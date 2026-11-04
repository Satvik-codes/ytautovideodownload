import React, { useState } from 'react';
import { Download, CheckCircle2, Clock, Loader2, RefreshCw, AlertCircle, XCircle, Ban } from 'lucide-react';
import { DEFAULT_SELECTION } from '../types/video';
import type { VideoInfo, DownloadStatus, DownloadSelection } from '../types/video';
import { DownloadOptions } from './DownloadOptions';
import { formatClock } from '../utils/clock';

interface VideoPreviewCardProps {
  video: VideoInfo | null;
  status: DownloadStatus;
  errorMessage: string | null;
  progress: number;
  onDownload: (selection: DownloadSelection) => void;
  onCancel: () => void;
  onReset: () => void;
}

export const VideoPreviewCard: React.FC<VideoPreviewCardProps> = ({
  video,
  status,
  errorMessage,
  progress,
  onDownload,
  onCancel,
  onReset,
}) => {
  const [selection, setSelection] = useState<DownloadSelection>(DEFAULT_SELECTION);
  const [trimValid, setTrimValid] = useState(true);

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
  const busy = status === 'preparing' || status === 'downloading';

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
              {video.platform === 'twitter' ? 'X' : 'YouTube'}
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

          <p className="video-author">By: {video.author}</p>

          <DownloadOptions
            video={video}
            selection={selection}
            onChange={setSelection}
            onValidityChange={setTrimValid}
            disabled={busy}
          />

          <StatusBanner status={status} progress={progress} errorMessage={errorMessage} />

          <div className="action-buttons">
            {busy ? (
              <button onClick={onCancel} className="cancel-button">
                <XCircle size={20} />
                <span>Cancel download</span>
              </button>
            ) : (
              <button
                onClick={() => onDownload(selection)}
                className="primary-download-button"
                disabled={!trimValid || status === 'fetching_info'}
              >
                <Download size={20} />
                <span>{downloadLabel(selection)}</span>
              </button>
            )}

            <button onClick={onReset} className="link-button">
              Download another video
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

function downloadLabel(selection: DownloadSelection) {
  const what =
    selection.kind === 'audio'
      ? `Download Audio (${selection.audioFormat === 'mp3' ? 'MP3 • 320 kbps' : 'M4A'})`
      : `Download Video (MP4 • ${selection.height ? `${selection.height}p` : 'Best'})`;
  const clip = selection.trim
    ? ` • ${formatClock(selection.trim.start)}–${formatClock(selection.trim.end)}`
    : '';
  return what + clip;
}

const StatusBanner: React.FC<{
  status: DownloadStatus;
  progress: number;
  errorMessage: string | null;
}> = ({ status, progress, errorMessage }) => {
  if (status === 'preparing' || status === 'downloading') {
    const preparing = status === 'preparing';
    return (
      <div className="status-banner info" role="status">
        <div className="status-item downloading">
          {preparing ? (
            <Clock size={18} className="icon-blue" />
          ) : (
            <Loader2 size={18} className="spinner icon-blue" />
          )}
          <span>
            {preparing
              ? 'Preparing your file on our server. MP3s and clips can take a minute.'
              : `Downloading... ${Math.round(progress * 100)}%`}
          </span>
        </div>
        <div className={`progress-track${preparing ? ' indeterminate' : ''}`}>
          <div className="progress-fill" style={preparing ? undefined : { width: `${progress * 100}%` }} />
        </div>
      </div>
    );
  }
  if (status === 'fetching_info') {
    return (
      <div className="status-banner info" role="status">
        <div className="status-item downloading">
          <Loader2 size={18} className="spinner icon-blue" />
          <span>Loading video info...</span>
        </div>
      </div>
    );
  }
  if (status === 'download_ready') {
    return (
      <div className="status-banner" role="status">
        <div className="status-item ready">
          <CheckCircle2 size={18} className="icon-green" />
          <span>Done! Check your downloads folder.</span>
        </div>
      </div>
    );
  }
  if (status === 'cancelled') {
    return (
      <div className="status-banner neutral" role="status">
        <div className="status-item muted">
          <Ban size={18} />
          <span>Download cancelled.</span>
        </div>
      </div>
    );
  }
  if (status === 'download_failed') {
    return (
      <div className="status-banner error" role="alert">
        <div className="status-item failed">
          <AlertCircle size={18} />
          <span>{errorMessage || 'Download failed. Please try again.'}</span>
        </div>
      </div>
    );
  }
  return null;
};
