import React, { useState } from 'react';
import { Film, Music, Scissors } from 'lucide-react';
import type { AudioFormat, DownloadSelection, VideoInfo } from '../types/video';
import { formatClock, parseClock } from '../utils/clock';

interface DownloadOptionsProps {
  video: VideoInfo;
  selection: DownloadSelection;
  onChange: (selection: DownloadSelection) => void;
  /** Reports whether the trim inputs currently hold a usable clip */
  onValidityChange: (valid: boolean) => void;
  disabled: boolean;
}

// Offered when the server returned no stream list (it then picks the format itself)
const STANDARD_HEIGHTS = [1080, 720, 480, 360];

interface QualityOption {
  height: number;
  size?: number;
}

/** Quality ladder from the signed streams, capped like the server's DOWNLOAD_QUALITY. */
function qualityOptions(video: VideoInfo): QualityOption[] {
  const streams = video.streams;
  const audioSize = streams?.audio?.size ?? 0;
  const fromStreams: QualityOption[] = streams?.directs?.length
    ? streams.directs.map((s) => ({ height: s.height ?? 0, size: s.size }))
    : (streams?.videos ?? []).map((s) => ({
        height: s.height ?? 0,
        size: s.size ? s.size + audioSize : undefined,
      }));
  const known = fromStreams.filter((o) => o.height > 0);
  if (known.length) return known;

  const cap = Number(/^(\d+)p$/.exec(video.quality)?.[1]) || Infinity;
  return STANDARD_HEIGHTS.filter((h) => h <= cap).map((height) => ({ height }));
}

function formatSize(bytes?: number) {
  if (!bytes) return '';
  return bytes >= 1024 ** 3
    ? ` · ${(bytes / 1024 ** 3).toFixed(1)} GB`
    : ` · ${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

export const DownloadOptions: React.FC<DownloadOptionsProps> = ({
  video,
  selection,
  onChange,
  onValidityChange,
  disabled,
}) => {
  const duration = video.duration;
  const [trimOpen, setTrimOpen] = useState(false);
  const [startText, setStartText] = useState('0:00');
  const [endText, setEndText] = useState(formatClock(duration));
  const [trimError, setTrimError] = useState<string | null>(null);
  const options = qualityOptions(video);

  const applyTrim = (open: boolean, start: string, end: string) => {
    if (!open) {
      setTrimError(null);
      onValidityChange(true);
      onChange({ ...selection, trim: undefined });
      return;
    }
    const s = parseClock(start);
    const e = parseClock(end);
    const error =
      s === null || e === null
        ? 'Use times like 1:30 or 0:01:30.'
        : duration > 0 && e > duration
          ? `The video is only ${formatClock(duration)} long.`
          : e <= s
            ? 'End must be after start.'
            : null;
    setTrimError(error);
    onValidityChange(!error);
    if (error) return;
    // The whole video selected is no clip at all: keep the fast in-browser path
    const whole = s === 0 && duration > 0 && e === duration;
    onChange({ ...selection, trim: whole ? undefined : { start: s!, end: e! } });
  };

  return (
    <div className="options-panel">
      <div className="options-tabs" role="tablist" aria-label="Download type">
        {(['video', 'audio'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            role="tab"
            aria-selected={selection.kind === kind}
            className={`options-tab${selection.kind === kind ? ' active' : ''}`}
            onClick={() => onChange({ ...selection, kind })}
            disabled={disabled}
          >
            {kind === 'video' ? <Film size={16} /> : <Music size={16} />}
            <span>{kind === 'video' ? 'Video' : 'Audio only'}</span>
          </button>
        ))}
      </div>

      {selection.kind === 'video' ? (
        <label className="options-field">
          <span className="options-label">Quality</span>
          <select
            className="options-select"
            value={selection.height ?? ''}
            onChange={(e) =>
              onChange({ ...selection, height: e.target.value ? Number(e.target.value) : undefined })
            }
            disabled={disabled}
          >
            <option value="">Best available{options[0] ? ` (${options[0].height}p)` : ''}</option>
            {options.map((o) => (
              <option key={o.height} value={o.height}>
                {o.height}p{formatSize(o.size)}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <div className="options-field">
          <span className="options-label">Format</span>
          <div className="format-choices">
            {(
              [
                ['mp3', 'MP3 · 320 kbps', 'Plays everywhere, converted on our server'],
                ['m4a', 'M4A · original', 'Instant, no re-encoding'],
              ] as [AudioFormat, string, string][]
            ).map(([format, title, hint]) => (
              <label
                key={format}
                className={`format-choice${selection.audioFormat === format ? ' active' : ''}`}
              >
                <input
                  type="radio"
                  name="audio-format"
                  value={format}
                  checked={selection.audioFormat === format}
                  onChange={() => onChange({ ...selection, audioFormat: format })}
                  disabled={disabled}
                />
                <span className="format-choice-title">{title}</span>
                <span className="format-choice-hint">{hint}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="trim-section">
        <label className="trim-toggle">
          <input
            type="checkbox"
            checked={trimOpen}
            onChange={(e) => {
              setTrimOpen(e.target.checked);
              applyTrim(e.target.checked, startText, endText);
            }}
            disabled={disabled}
          />
          <Scissors size={15} />
          <span>Trim to a clip</span>
        </label>

        {trimOpen && (
          <div className="trim-fields">
            <label className="options-field trim-field">
              <span className="options-label">Start</span>
              <input
                className="options-input"
                inputMode="numeric"
                value={startText}
                onChange={(e) => {
                  setStartText(e.target.value);
                  applyTrim(true, e.target.value, endText);
                }}
                aria-invalid={!!trimError}
                disabled={disabled}
              />
            </label>
            <label className="options-field trim-field">
              <span className="options-label">End</span>
              <input
                className="options-input"
                inputMode="numeric"
                value={endText}
                onChange={(e) => {
                  setEndText(e.target.value);
                  applyTrim(true, startText, e.target.value);
                }}
                aria-invalid={!!trimError}
                disabled={disabled}
              />
            </label>
            <p className={`trim-hint${trimError ? ' error' : ''}`}>
              {trimError ??
                (selection.kind === 'video'
                  ? 'Clips are cut on our server. Video cuts land on the nearest keyframe, so they may start a moment early.'
                  : 'Clips are cut on our server.')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
