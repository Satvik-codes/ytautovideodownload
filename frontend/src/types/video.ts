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
  | 'auto_downloading'
  | 'browser_downloading'
  | 'download_ready'
  // MP3 and clips are built on the server first; the iframe download starts when it's done
  | 'server_preparing'
  | 'error';
