import { readBody, saveBlob } from './save-file';

const MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
};

/**
 * Downloads a file the server builds itself (MP3, clips, fallback). A fetch
 * rather than a hidden iframe so errors reach the page, progress is visible,
 * and aborting the signal cancels the server job (it kills yt-dlp/ffmpeg
 * when the connection closes).
 */
export async function downloadFromServer(
  url: string,
  filename: string,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<void> {
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || `Download failed (${res.status}).`);
  }

  // Headers arrive only once the server has finished preparing the file
  onProgress(0);
  const ext = filename.split('.').pop() || 'mp4';
  const blob = await readBody(res, MIME_TYPES[ext] || 'application/octet-stream', undefined, onProgress);
  saveBlob(blob, filename);
  onProgress(1);
}
