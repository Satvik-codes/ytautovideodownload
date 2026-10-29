export interface VideoInfo {
  id: string;
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

export interface VideoStreams {
  video?: StreamDescriptor;
  audio?: StreamDescriptor;
  progressive?: StreamDescriptor;
}

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
  | 'error';
