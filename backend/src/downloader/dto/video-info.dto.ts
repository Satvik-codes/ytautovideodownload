export class VideoInfoResponse {
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

export class BackendSettingsResponse {
  format: string;
  quality: string;
  maxDurationSeconds: number;
}
