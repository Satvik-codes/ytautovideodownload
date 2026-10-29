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
  /** Signed streams for in-browser download + muxing via /api/video/stream */
  streams?: VideoStreams;
}

export class StreamDescriptor {
  token: string;
  height?: number;
  size?: number;
  ext: string;
}

export class VideoStreams {
  video?: StreamDescriptor;
  audio?: StreamDescriptor;
  progressive?: StreamDescriptor;
}

export class BackendSettingsResponse {
  format: string;
  quality: string;
  maxDurationSeconds: number;
}
