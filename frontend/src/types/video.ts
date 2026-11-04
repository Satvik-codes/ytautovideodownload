export interface VideoInfo {
  id: string;
  platform: 'youtube' | 'twitter';
  title: string;
  duration: number;
  durationFormatted: string;
  author: string;
  thumbnail: string;
  views?: number;
  format: string;
  quality: string;
  downloadUrl: string;
  streams?: VideoStreams;
}

export interface StreamDescriptor {
  token: string;
  height?: number;
  size?: number;
  ext: string;
}

/** A public CDN file the browser fetches directly (X) */
export interface DirectStream {
  url: string;
  height?: number;
  size?: number;
  ext: string;
}

export interface VideoStreams {
  /** Default video pick, muxed with `audio` */
  video?: StreamDescriptor;
  /** Every video-only quality, best first; each pairs with `audio` */
  videos?: StreamDescriptor[];
  audio?: StreamDescriptor;
  progressive?: StreamDescriptor;
  direct?: DirectStream;
  /** Every X CDN quality, best first */
  directs?: DirectStream[];
}

export type AudioFormat = 'mp3' | 'm4a';

/** What the user picked in the card; the defaults reproduce the auto-download. */
export interface DownloadSelection {
  kind: 'video' | 'audio';
  /** Video height; undefined means best available */
  height?: number;
  audioFormat: AudioFormat;
  /** Clip bounds in whole seconds; undefined means the full video */
  trim?: { start: number; end: number };
}

export const DEFAULT_SELECTION: DownloadSelection = { kind: 'video', audioFormat: 'mp3' };

export interface BackendSettings {
  format: string;
  quality: string;
  maxDurationSeconds: number;
}

export type DownloadStatus =
  | 'idle'
  | 'fetching_info'
  // Info loaded, waiting for the user to pick options and press Download
  | 'ready'
  // The server is building the file (MP3, clips); no bytes yet
  | 'preparing'
  | 'downloading'
  | 'download_ready'
  | 'cancelled'
  // A download failed; the card stays so the user can retry or change options
  | 'download_failed'
  // Loading the video info failed
  | 'error';
