import React, { useState } from 'react';
import { Download, CheckCircle2, Clock, Loader2, RefreshCw, AlertCircle } from 'lucide-react';
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
  onReset: () => void;
}

export const VideoPreviewCard: React.FC<VideoPreviewCardProps> = ({
  video,
  status,
  errorMessage,
  progress,
  onDownload,
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

          {/* Status banner */}
          <div className="status-banner">
            {status === 'browser_downloading' ? (
              <div className="status-item downloading">
                <Loader2 size={18} className="spinner icon-blue" />
                <span>Downloading in your browser... {Math.round(progress * 100)}%</span>
              </div>
            ) : status === 'auto_downloading' ? (
              <div className="status-item downloading">
                <Loader2 size={18} className="spinner icon-blue" />
                <span>Triggering your direct download automatically...</span>
              </div>
            ) : status === 'server_preparing' ? (
              <div className="status-item downloading">
                <Clock size={18} className="icon-blue" />
                <span>
                  Preparing your file on our server. It downloads automatically when ready, which
                  can take a minute for MP3s and clips.
                </span>
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

          <DownloadOptions
            video={video}
            selection={selection}
            onChange={setSelection}
            onValidityChange={setTrimValid}
            disabled={status === 'browser_downloading'}
          />

          {/* Direct Download Button */}
          <div className="action-buttons">
            <button
              onClick={() => onDownload(selection)}
              className="primary-download-button pulse-button"
              disabled={status === 'browser_downloading' || !trimValid}
            >
              <Download size={20} />
              <span>{downloadLabel(selection)}</span>
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
