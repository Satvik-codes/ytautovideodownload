export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function safeFilename(title: string) {
  return title.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150) || 'video';
}

/** Reads a response body into a Blob, reporting progress against the expected size. */
export async function readBody(
  res: Response,
  type: string,
  expectedSize: number | undefined,
  onProgress: (fraction: number) => void,
): Promise<Blob> {
  const total = Number(res.headers.get('Content-Length')) || expectedSize || 0;
  const reader = res.body!.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.byteLength;
    if (total) onProgress(Math.min(received / total, 0.99));
  }
  return new Blob(parts as BlobPart[], { type });
}
