export class VideoInfoResponse {
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
  /** Signed streams for in-browser download + muxing via /api/video/stream */
  streams?: VideoStreams;
}

export class StreamDescriptor {
  token: string;
  height?: number;
  size?: number;
  ext: string;
}

/** A public, non-IP-locked CDN file the browser can fetch directly (X). */
export class DirectStream {
  url: string;
  height?: number;
  size?: number;
  ext: string;
}

export class VideoStreams {
  video?: StreamDescriptor;
  audio?: StreamDescriptor;
  progressive?: StreamDescriptor;
  direct?: DirectStream;
}

export class BackendSettingsResponse {
  format: string;
  quality: string;
  maxDurationSeconds: number;
}
