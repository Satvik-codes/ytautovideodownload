import { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { UrlInput } from './components/UrlInput';
import { VideoPreviewCard } from './components/VideoPreviewCard';
import { HowItWorks } from './components/HowItWorks';
import type { VideoInfo, BackendSettings, DownloadStatus } from './types/video';
import { parseMediaInput, detectMediaFromCurrentWindow } from './utils/media-parser';
import type { MediaRef } from './utils/media-parser';
import { getApiUrl } from './config/api';
import './App.css';

export function App() {
  const [settings, setSettings] = useState<BackendSettings | null>(null);
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [status, setStatus] = useState<DownloadStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hasAutoTriggered = useRef(false);

  // 1. Fetch backend settings on startup
  useEffect(() => {
    fetch(getApiUrl('/api/video/settings'))
      .then((res) => (res.ok ? res.json() : null))
      .then((data: BackendSettings | null) => {
        if (data) setSettings(data);
      })
      .catch(() => {
        // Fallback default
        setSettings({ format: 'mp4', quality: 'best', maxDurationSeconds: 10800 });
      });
  }, []);

  // 2. Detect URL on mount (e.g. /watch?v=XYZ, /video?url=... or /user/status/ID)
  useEffect(() => {
    const detected = detectMediaFromCurrentWindow();
    if (detected && !hasAutoTriggered.current) {
      hasAutoTriggered.current = true;
      handleLoadAndDownload(detected);
    }
  }, []);

  const triggerBrowserDownload = (videoData: VideoInfo) => {
    // The server builds the right fallback URL per platform (?v= or ?url=)
    const downloadEndpoint = getApiUrl(videoData.downloadUrl);

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
  // way, failures fall back to the server-side download endpoint.
  const startDownload = async (videoData: VideoInfo) => {
    if (videoData.streams) {
      setStatus('browser_downloading');
      setProgress(0);
      try {
        // Loaded on demand: the muxer is only needed once a download starts
        const { downloadInBrowser, downloadDirect, StreamExpiredError } = await import(
          './utils/browser-download'
        );
        if (videoData.streams.direct) {
          await downloadDirect(videoData, setProgress);
          setStatus('download_ready');
          return;
        }
        try {
          await downloadInBrowser(videoData, setProgress);
        } catch (err) {
          // Links die when the server's egress IP rotates; the server has
          // already dropped its cache, so fresh info yields working links
          if (!(err instanceof StreamExpiredError)) throw err;
          const fresh = await fetch(getApiUrl(`/api/video/info?v=${encodeURIComponent(videoData.id)}`));
          if (!fresh.ok) throw err;
          const freshData: VideoInfo = await fresh.json();
          if (!freshData.streams) throw err;
          setProgress(0);
          await downloadInBrowser(freshData, setProgress);
        }
        setStatus('download_ready');
        return;
      } catch (err) {
        console.warn('In-browser download failed, falling back to server download:', err);
      }
    }

    setStatus('auto_downloading');
    triggerBrowserDownload(videoData);

    // Update status after short timeout to acknowledge browser trigger
    setTimeout(() => {
      setStatus('download_ready');
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
      await startDownload(videoData);
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

      <Header settings={settings} onReset={handleReset} />

      <main className="main-content">
        <div className="hero-banner">
          <h1 className="hero-heading">
            Download Any YouTube Video <span className="hero-accent">Instantly</span>
          </h1>
          <p className="hero-subtext">
            Just change <code>youtube.com</code> to <code>youdown.com</code> in your address
            bar, hit Enter, and your video downloads automatically! X (Twitter) posts work too:
            paste the link, or swap <code>x.com</code> for your YouDown address.
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
            video={video}
            status={status}
            errorMessage={errorMessage}
            progress={progress}
            onManualDownload={() => video && startDownload(video)}
            onReset={handleReset}
          />
        )}

        {/* How it works visual guide */}
        <HowItWorks />
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
