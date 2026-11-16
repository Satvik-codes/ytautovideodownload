import { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { UrlInput } from './components/UrlInput';
import { VideoPreviewCard } from './components/VideoPreviewCard';
import type { VideoInfo, DownloadStatus, DownloadSelection } from './types/video';
import { parseMediaInput, detectMediaFromCurrentWindow } from './utils/media-parser';
import type { MediaRef } from './utils/media-parser';
import { downloadFromServer } from './utils/server-download';
import { safeFilename } from './utils/save-file';
import { getApiUrl } from './config/api';
import './App.css';

/** Server endpoint for this selection; the server builds ?v= or ?url= per platform. */
function serverDownloadUrl(videoData: VideoInfo, selection: DownloadSelection) {
  const params = new URLSearchParams();
  if (selection.kind === 'audio') {
    params.set('format', selection.audioFormat);
  } else {
    params.set('format', 'mp4');
    if (selection.height) params.set('quality', `${selection.height}p`);
  }
  if (selection.trim) {
    params.set('start', String(selection.trim.start));
    params.set('end', String(selection.trim.end));
  }
  return getApiUrl(`${videoData.downloadUrl}&${params}`);
}

export function App() {
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [status, setStatus] = useState<DownloadStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const hasAutoLoaded = useRef(false);
  // Last requested video, so a temporary YouTube block can be retried in place
  const lastMedia = useRef<MediaRef | null>(null);
  const [retryable, setRetryable] = useState(false);
  // Aborting this cancels the running download, in the browser or on the server
  const downloadAbort = useRef<AbortController | null>(null);

  // Detect URL on mount (e.g. /watch?v=XYZ, /video?url=... or /user/status/ID)
  useEffect(() => {
    const detected = detectMediaFromCurrentWindow();
    if (detected && !hasAutoLoaded.current) {
      hasAutoLoaded.current = true;
      handleLoad(detected);
    }
  }, []);

  const cancelDownload = () => {
    downloadAbort.current?.abort();
    downloadAbort.current = null;
  };

  // Preferred path: X files come straight from X's CDN; YouTube streams come
  // through the relay in small chunks and are muxed in the browser. Either
  // way, failures fall back to the server-side download endpoint. MP3 and
  // clips always go to the server: they need ffmpeg (encoding / cutting).
  const startDownload = async (videoData: VideoInfo, selection: DownloadSelection) => {
    cancelDownload();
    const controller = new AbortController();
    downloadAbort.current = controller;
    const { signal } = controller;

    const audioInBrowser =
      selection.kind === 'audio' && selection.audioFormat === 'm4a' && !!videoData.streams?.audio;
    const inBrowser = !selection.trim && (selection.kind === 'video' || audioInBrowser);
    setErrorMessage(null);
    setProgress(0);

    try {
      if (videoData.streams && inBrowser) {
        setStatus('downloading');
        try {
          await downloadInBrowserWithRetry(videoData, selection, audioInBrowser, signal);
          setStatus('download_ready');
          return;
        } catch (err) {
          if (signal.aborted) throw err;
          console.warn('In-browser download failed, falling back to server download:', err);
        }
      }

      setStatus('preparing');
      setProgress(0);
      const ext = selection.kind === 'audio' ? selection.audioFormat : 'mp4';
      await downloadFromServer(
        serverDownloadUrl(videoData, selection),
        `${safeFilename(videoData.title)}.${ext}`,
        signal,
        (fraction) => {
          setStatus('downloading');
          setProgress(fraction);
        },
      );
      setStatus('download_ready');
    } catch (err) {
      if (signal.aborted) {
        setStatus('cancelled');
        return;
      }
      setStatus('download_failed');
      setErrorMessage(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      if (downloadAbort.current === controller) downloadAbort.current = null;
    }
  };

  const downloadInBrowserWithRetry = async (
    videoData: VideoInfo,
    selection: DownloadSelection,
    audioInBrowser: boolean,
    signal: AbortSignal,
  ) => {
    // Loaded on demand: the muxer is only needed once a download starts
    const { downloadInBrowser, downloadDirect, downloadAudioInBrowser, StreamExpiredError } =
      await import('./utils/browser-download');
    if (videoData.streams?.direct) {
      await downloadDirect(videoData, selection.height, signal, setProgress);
      return;
    }
    const run = (data: VideoInfo) =>
      audioInBrowser
        ? downloadAudioInBrowser(data, signal, setProgress)
        : downloadInBrowser(data, selection.height, signal, setProgress);
    try {
      await run(videoData);
    } catch (err) {
      // Links die when the server's egress IP rotates; the server has
      // already dropped its cache, so fresh info yields working links
      if (!(err instanceof StreamExpiredError)) throw err;
      const fresh = await fetch(getApiUrl(`/api/video/info?v=${encodeURIComponent(videoData.id)}`), {
        signal,
      });
      if (!fresh.ok) throw err;
      const freshData: VideoInfo = await fresh.json();
      if (!freshData.streams) throw err;
      setVideo(freshData);
      setProgress(0);
      await run(freshData);
    }
  };

  // Loads the video info only; the download starts when the user presses Download
  const handleLoad = async (media: MediaRef) => {
    cancelDownload();
    lastMedia.current = media;
    setStatus('fetching_info');
    setErrorMessage(null);
    setRetryable(false);

    try {
      const response = await fetch(getApiUrl(`/api/video/info?${media.apiQuery}`));
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        // The server marks YouTube's bot wall; it usually clears after a retry
        setRetryable(errorData.code === 'YT_BLOCKED');
        throw new Error(errorData.message || 'Unable to retrieve video information.');
      }

      const videoData: VideoInfo = await response.json();
      setVideo(videoData);
      setStatus('ready');
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Failed to process video.');
    }
  };

  const handleManualSearch = (input: string) => {
    const media = parseMediaInput(input);
    if (!media) {
      setStatus('error');
      setErrorMessage(
        'Please provide a valid YouTube link, 11-character video ID, or X (Twitter) post link.',
      );
      return;
    }

    // Update the address bar so the user can copy/bookmark it
    window.history.pushState(null, '', media.shareablePath);
    handleLoad(media);
  };

  const handleReset = () => {
    cancelDownload();
    setVideo(null);
    setStatus('idle');
    setErrorMessage(null);
    hasAutoLoaded.current = false;
    window.history.pushState(null, '', window.location.pathname === '/' ? '/' : '/');
  };

  return (
    <div className="app-layout">
      <Header onReset={handleReset} />

      <main className="main-content">
        <div className="hero-banner">
          <h1 className="hero-heading">
            Download Any YouTube Video <span className="hero-accent">Instantly</span>
          </h1>
          <p className="hero-subtext">
            Paste a YouTube or X link, or swap <code>youtube.com</code> / <code>x.com</code> for
            YouDown in your address bar.
          </p>
        </div>

        {/* Search bar is always available for convenience */}
        <UrlInput
          onSearch={handleManualSearch}
          isLoading={status === 'fetching_info'}
        />

        {/* Video preview / download card when a video is loaded */}
        {(video || status === 'fetching_info' || status === 'error') && (
          <VideoPreviewCard
            // Fresh picker state (trim bounds especially) for every video
            key={video?.id}
            video={video}
            status={status}
            errorMessage={errorMessage}
            progress={progress}
            onDownload={(selection) => video && startDownload(video, selection)}
            onCancel={cancelDownload}
            onRetry={
              retryable ? () => lastMedia.current && handleLoad(lastMedia.current) : undefined
            }
            onReset={handleReset}
          />
        )}
      </main>

      <footer className="footer-container">
        <p className="footer-text">
          YouDown • Pure direct downloads powered by NestJS & React.
        </p>
      </footer>
    </div>
  );
}

export default App;
