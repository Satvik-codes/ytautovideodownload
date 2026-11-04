import { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { UrlInput } from './components/UrlInput';
import { VideoPreviewCard } from './components/VideoPreviewCard';
import { DEFAULT_SELECTION } from './types/video';
import type { VideoInfo, DownloadStatus, DownloadSelection } from './types/video';
import { parseMediaInput, detectMediaFromCurrentWindow } from './utils/media-parser';
import type { MediaRef } from './utils/media-parser';
import { getApiUrl } from './config/api';
import './App.css';

export function App() {
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [status, setStatus] = useState<DownloadStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hasAutoTriggered = useRef(false);

  // Detect URL on mount (e.g. /watch?v=XYZ, /video?url=... or /user/status/ID)
  useEffect(() => {
    const detected = detectMediaFromCurrentWindow();
    if (detected && !hasAutoTriggered.current) {
      hasAutoTriggered.current = true;
      handleLoadAndDownload(detected);
    }
  }, []);

  const triggerBrowserDownload = (videoData: VideoInfo, selection: DownloadSelection) => {
    // The server builds the right fallback URL per platform (?v= or ?url=)
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
    const downloadEndpoint = getApiUrl(`${videoData.downloadUrl}&${params}`);

    // Trigger download via hidden iframe
    if (iframeRef.current) {
      iframeRef.current.src = downloadEndpoint;
    } else {
      // Fallback anchor trigger
      const link = document.createElement('a');
      link.href = downloadEndpoint;
      link.setAttribute('download', '');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  // Preferred path: X files come straight from X's CDN; YouTube streams come
  // through the relay in small chunks and are muxed in the browser. Either
  // way, failures fall back to the server-side download endpoint. MP3 and
  // clips always go to the server: they need ffmpeg (encoding / cutting).
  const startDownload = async (videoData: VideoInfo, selection: DownloadSelection) => {
    const audioInBrowser =
      selection.kind === 'audio' && selection.audioFormat === 'm4a' && !!videoData.streams?.audio;
    const inBrowser = !selection.trim && (selection.kind === 'video' || audioInBrowser);

    if (videoData.streams && inBrowser) {
      setStatus('browser_downloading');
      setProgress(0);
      try {
        // Loaded on demand: the muxer is only needed once a download starts
        const { downloadInBrowser, downloadDirect, downloadAudioInBrowser, StreamExpiredError } =
          await import('./utils/browser-download');
        if (videoData.streams.direct) {
          await downloadDirect(videoData, selection.height, setProgress);
          setStatus('download_ready');
          return;
        }
        const run = (data: VideoInfo) =>
          audioInBrowser
            ? downloadAudioInBrowser(data, setProgress)
            : downloadInBrowser(data, selection.height, setProgress);
        try {
          await run(videoData);
        } catch (err) {
          // Links die when the server's egress IP rotates; the server has
          // already dropped its cache, so fresh info yields working links
          if (!(err instanceof StreamExpiredError)) throw err;
          const fresh = await fetch(getApiUrl(`/api/video/info?v=${encodeURIComponent(videoData.id)}`));
          if (!fresh.ok) throw err;
          const freshData: VideoInfo = await fresh.json();
          if (!freshData.streams) throw err;
          setVideo(freshData);
          setProgress(0);
          await run(freshData);
        }
        setStatus('download_ready');
        return;
      } catch (err) {
        console.warn('In-browser download failed, falling back to server download:', err);
      }
    }

    setStatus('auto_downloading');
    triggerBrowserDownload(videoData, selection);

    // Update status after short timeout to acknowledge browser trigger. The
    // iframe gives no completion signal, so slow server jobs say so instead
    const slowJob = !!selection.trim || (selection.kind === 'audio' && !audioInBrowser);
    setTimeout(() => {
      setStatus(slowJob ? 'server_preparing' : 'download_ready');
    }, 1500);
  };

  const handleLoadAndDownload = async (media: MediaRef) => {
    setStatus('fetching_info');
    setErrorMessage(null);

    try {
      const response = await fetch(getApiUrl(`/api/video/info?${media.apiQuery}`));
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || 'Unable to retrieve video information.');
      }

      const videoData: VideoInfo = await response.json();
      setVideo(videoData);
      await startDownload(videoData, DEFAULT_SELECTION);
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
    handleLoadAndDownload(media);
  };

  const handleReset = () => {
    setVideo(null);
    setStatus('idle');
    setErrorMessage(null);
    hasAutoTriggered.current = false;
    window.history.pushState(null, '', window.location.pathname === '/' ? '/' : '/');
  };

  return (
    <div className="app-layout">
      {/* Hidden iframe for zero-navigation browser downloads */}
      <iframe
        ref={iframeRef}
        style={{ display: 'none', width: 0, height: 0, border: 'none' }}
        title="download-frame"
      />

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
          isLoading={
            status === 'fetching_info' ||
            status === 'auto_downloading' ||
            status === 'browser_downloading'
          }
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
