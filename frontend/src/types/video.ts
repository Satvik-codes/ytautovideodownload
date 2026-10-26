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
  | 'download_ready'
  | 'error';
