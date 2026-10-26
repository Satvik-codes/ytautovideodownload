import { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { UrlInput } from './components/UrlInput';
import { VideoPreviewCard } from './components/VideoPreviewCard';
import { HowItWorks } from './components/HowItWorks';
import type { VideoInfo, BackendSettings, DownloadStatus } from './types/video';
import { extractVideoId, detectVideoIdFromCurrentWindow } from './utils/youtube-parser';
import { getApiUrl } from './config/api';
import './App.css';

export function App() {
  const [settings, setSettings] = useState<BackendSettings | null>(null);
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [status, setStatus] = useState<DownloadStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
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

  // 2. Detect URL on mount (e.g. /watch?v=XYZ or /video?url=...)
  useEffect(() => {
    const detectedId = detectVideoIdFromCurrentWindow();
    if (detectedId && !hasAutoTriggered.current) {
      hasAutoTriggered.current = true;
      handleLoadAndDownload(detectedId);
    }
  }, []);

  const triggerBrowserDownload = (videoId: string) => {
    const downloadEndpoint = getApiUrl(`/api/video/download?v=${encodeURIComponent(videoId)}`);

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

  const handleLoadAndDownload = async (videoId: string) => {
    setStatus('fetching_info');
    setErrorMessage(null);

    try {
      const response = await fetch(getApiUrl(`/api/video/info?v=${encodeURIComponent(videoId)}`));
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || 'Unable to retrieve video information.');
      }

      const videoData: VideoInfo = await response.json();
      setVideo(videoData);

      // Transition to auto downloading
      setStatus('auto_downloading');

      // Trigger native download
      triggerBrowserDownload(videoId);

      // Update status after short timeout to acknowledge browser trigger
      setTimeout(() => {
        setStatus('download_ready');
      }, 1500);
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Failed to process video.');
    }
  };

  const handleManualSearch = (input: string) => {
    const id = extractVideoId(input);
    if (!id) {
      setStatus('error');
      setErrorMessage('Please provide a valid YouTube link or 11-character video ID.');
      return;
    }

    // Update URL query in address bar so user can copy/bookmark it
    window.history.pushState(null, '', `?v=${id}`);
    handleLoadAndDownload(id);
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
            bar, hit Enter, and your video downloads automatically!
          </p>
        </div>

        {/* Search bar is always available for convenience */}
        <UrlInput
          onSearch={handleManualSearch}
          isLoading={status === 'fetching_info' || status === 'auto_downloading'}
        />

        {/* Video preview / download card when a video is loaded */}
        {(video || status === 'fetching_info' || status === 'error') && (
          <VideoPreviewCard
            video={video}
            status={status}
            errorMessage={errorMessage}
            onManualDownload={() => video && triggerBrowserDownload(video.id)}
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
