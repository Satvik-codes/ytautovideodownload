import { spawn } from 'child_process';
import type { Response } from 'express';

// Each relayed request covers at most this many bytes, keeping every HTTP
// request short regardless of video length
export const MAX_RELAY_CHUNK_BYTES = 4 * 1024 * 1024;

export interface ByteRange {
  start: number;
  end: number;
}

/** Parses `bytes=a-b` / `bytes=a-` and clamps it to MAX_RELAY_CHUNK_BYTES. */
export function parseClampedRange(header: string | undefined): ByteRange | null {
  const match = /^bytes=(\d+)-(\d*)$/.exec((header || 'bytes=0-').trim());
  if (!match) return null;
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : Infinity;
  if (requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, start + MAX_RELAY_CHUNK_BYTES - 1) };
}

export interface RelayOptions {
  url: string;
  range: ByteRange;
  /** socks5://host:port, or null to connect directly */
  proxy: string | null;
  userAgent: string;
  res: Response;
}

/**
 * Fetches one byte range of a googlevideo URL with curl and pipes it to the
 * client. googlevideo URLs are locked to the IP that extracted them (`ip=`),
 * so the request goes through the same proxy, forcing the same address family.
 * Resolves with the upstream status code.
 */
export function relayRange({ url, range, proxy, userAgent, res }: RelayOptions): Promise<number> {
  return new Promise((resolve) => {
    const args = [
      '-s',
      '-i',
      '-L',
      '--max-time',
      '60',
      '-A',
      userAgent,
      '-H',
      `Range: bytes=${range.start}-${range.end}`,
    ];
    if (proxy) {
      // Local DNS + explicit family: the proxy connects to the exact address
      // family the URL was issued for (WARP has separate v4 and v6 egress IPs)
      const ipParam = new URL(url).searchParams.get('ip') || '';
      args.push('--socks5', proxy.replace(/^socks5h?:\/\//, ''), ipParam.includes(':') ? '-6' : '-4');
    }
    args.push(url);

    const child = spawn('curl', args, { shell: false });
    let headerBuffer = Buffer.alloc(0);
    let headersDone = false;
    let status = 0;

    res.on('close', () => child.kill('SIGTERM'));

    child.stdout.on('data', (chunk: Buffer) => {
      if (headersDone) {
        if (status === 206 || status === 200) res.write(chunk);
        return;
      }
      headerBuffer = Buffer.concat([headerBuffer, chunk]);

      // With -L, curl prints one header block per hop; skip redirects
      let sep: number;
      while (!headersDone && (sep = headerBuffer.indexOf('\r\n\r\n')) !== -1) {
        const block = headerBuffer.subarray(0, sep).toString('latin1');
        headerBuffer = headerBuffer.subarray(sep + 4);
        status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(block)?.[1] || 0);
        if (status >= 300 && status < 400) continue;
        if (status === 100) continue;

        headersDone = true;
        if (status === 206 || status === 200) {
          const headers = parseHeaders(block);
          res.status(206);
          res.setHeader('Content-Type', headers['content-type'] || 'application/octet-stream');
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Cache-Control', 'no-store');
          if (headers['content-range']) res.setHeader('Content-Range', headers['content-range']);
          if (headers['content-length']) res.setHeader('Content-Length', headers['content-length']);
          if (headerBuffer.length) res.write(headerBuffer);
        }
      }
    });

    child.on('error', () => resolve(0));
    child.on('close', () => {
      if (headersDone && (status === 206 || status === 200)) res.end();
      resolve(status);
    });
  });
}

function parseHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of block.split('\r\n').slice(1)) {
    const idx = line.indexOf(':');
    if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}
