import React from 'react';
import { Download, CheckCircle2, Loader2, RefreshCw, AlertCircle } from 'lucide-react';
import type { VideoInfo, DownloadStatus } from '../types/video';

interface VideoPreviewCardProps {
  video: VideoInfo | null;
  status: DownloadStatus;
  errorMessage: string | null;
  onManualDownload: () => void;
  onReset: () => void;
}

export const VideoPreviewCard: React.FC<VideoPreviewCardProps> = ({
  video,
  status,
  errorMessage,
  onManualDownload,
  onReset,
}) => {
  if (status === 'error') {
    return (
      <div className="card-container error-card">
        <div className="error-icon-box">
          <AlertCircle size={36} className="error-icon" />
        </div>
        <h3 className="error-title">Unable to Download Video</h3>
        <p className="error-message">
          {errorMessage || 'The video could not be loaded. Please ensure the link is valid and public.'}
        </p>
        <button onClick={onReset} className="secondary-button">
          <RefreshCw size={16} />
          <span>Try Another Video</span>
        </button>
      </div>
    );
  }

  if (status === 'fetching_info' && !video) {
    return (
      <div className="card-container loading-card">
        <div className="spinner-box">
          <Loader2 size={40} className="spinner icon-blue" />
        </div>
        <h3 className="loading-title">Recognizing Video...</h3>
        <p className="loading-desc">Fetching metadata from YouTube</p>
      </div>
    );
  }

  if (!video) return null;

  return (
    <div className="card-container video-card">
      <div className="video-card-inner">
        {/* Thumbnail with duration badge */}
        <div className="thumbnail-wrapper">
          <img
            src={video.thumbnail}
            alt={video.title}
            className="video-thumbnail"
            onError={(e) => {
              // Fallback if maxres is missing
              (e.currentTarget as HTMLImageElement).src = `https://img.youtube.com/vi/${video.id}/hqdefault.jpg`;
            }}
          />
          <div className="duration-badge">{video.durationFormatted}</div>
        </div>

        {/* Video details */}
        <div className="video-info">
          <div className="video-badge-row">
            <span className="badge-pill format-pill">
              {video.format.toUpperCase()}
            </span>
            <span className="badge-pill quality-pill">
              Quality: {video.quality}
            </span>
            {video.views && (
              <span className="badge-pill views-pill">
                {Number(video.views).toLocaleString()} views
              </span>
            )}
          </div>

          <h2 className="video-title" title={video.title}>
            {video.title}
          </h2>

          <p className="video-author">Channel: {video.author}</p>

          {/* Status banner */}
          <div className="status-banner">
            {status === 'auto_downloading' ? (
              <div className="status-item downloading">
                <Loader2 size={18} className="spinner icon-blue" />
                <span>Triggering your direct download automatically...</span>
              </div>
            ) : (
              <div className="status-item ready">
                <CheckCircle2 size={18} className="icon-green" />
                <span>
                  Download triggered! If it didn't start automatically, click below.
                </span>
              </div>
            )}
          </div>

          {/* Direct Download Button */}
          <div className="action-buttons">
            <button
              onClick={onManualDownload}
              className="primary-download-button pulse-button"
            >
              <Download size={20} />
              <span>
                Download Video ({video.format.toUpperCase()} • {video.quality})
              </span>
            </button>

            <button onClick={onReset} className="link-button">
              Download another video
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
