import { BadRequestException } from '@nestjs/common';

export type DownloadFormat = 'mp4' | 'mp3' | 'm4a';

export interface DownloadOptions {
  format: DownloadFormat;
  /** Max video height; undefined means the server's configured cap */
  height?: number;
  /** Clip bounds in whole seconds; end undefined means "to the end" */
  section?: { start: number; end?: number };
}

export interface DownloadQuery {
  format?: string;
  quality?: string;
  start?: string;
  end?: string;
}

const FORMATS: DownloadFormat[] = ['mp4', 'mp3', 'm4a'];

/** Strictly parses the user-facing download query; anything odd is rejected, never passed to yt-dlp. */
export function parseDownloadOptions(query: DownloadQuery, defaultFormat: string): DownloadOptions {
  const rawFormat = (query.format || defaultFormat).toLowerCase();
  const format: DownloadFormat = FORMATS.includes(rawFormat as DownloadFormat)
    ? (rawFormat as DownloadFormat)
    : query.format
      ? invalid('Unsupported format. Use mp4, mp3 or m4a.')
      : 'mp4';

  let height: number | undefined;
  if (query.quality && format === 'mp4') {
    const match = /^(\d{3,4})p?$/i.exec(query.quality);
    height = match ? Number(match[1]) : NaN;
    if (!(height >= 144 && height <= 4320)) invalid('Unsupported quality. Use e.g. 720p.');
  }

  const start = parseSeconds(query.start, 'start');
  const end = parseSeconds(query.end, 'end');
  let section: DownloadOptions['section'];
  if (start !== undefined || end !== undefined) {
    section = { start: start ?? 0, end };
    if (end !== undefined && end <= section.start) {
      invalid('The clip end must be after its start.');
    }
  }

  return { format, height, section };
}

/** Distinguishes cached files per variant; the plain best-quality MP4 keeps the bare key. */
export function optionsSuffix(options: DownloadOptions): string {
  let suffix = options.format === 'mp4' ? '' : `_${options.format}`;
  if (options.height) suffix += `_${options.height}p`;
  if (options.section) suffix += `_t${options.section.start}-${options.section.end ?? 'end'}`;
  return suffix;
}

function parseSeconds(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^\d{1,6}$/.test(value)) invalid(`Invalid ${name} time. Use whole seconds.`);
  return Number(value);
}

function invalid(message: string): never {
  throw new BadRequestException(message);
}
