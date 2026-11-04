import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { optionsSuffix, parseDownloadOptions, sectionArg } from './download-options.js';

describe('parseDownloadOptions', () => {
  it('falls back to the configured format, and to mp4 for unsupported configs', () => {
    expect(parseDownloadOptions({}, 'mp3')).toEqual({ format: 'mp3' });
    expect(parseDownloadOptions({}, 'webm')).toEqual({ format: 'mp4' });
  });

  it('parses format, quality and clip bounds', () => {
    expect(parseDownloadOptions({ format: 'MP4', quality: '720p', start: '10', end: '40' }, 'mp4')).toEqual({
      format: 'mp4',
      height: 720,
      section: { start: 10, end: 40 },
    });
  });

  it('ignores quality for audio formats', () => {
    expect(parseDownloadOptions({ format: 'mp3', quality: '720p' }, 'mp4').height).toBeUndefined();
  });

  it('allows open-ended clips', () => {
    expect(parseDownloadOptions({ start: '30' }, 'mp4').section).toEqual({ start: 30, end: undefined });
    expect(parseDownloadOptions({ end: '30' }, 'mp4').section).toEqual({ start: 0, end: 30 });
  });

  it.each([
    [{ format: 'webm' }],
    [{ quality: 'best' }],
    [{ quality: '99999' }],
    [{ start: '-5' }],
    [{ start: '1.5' }],
    [{ start: '10;rm' }],
    [{ start: '40', end: '40' }],
    [{ start: '40', end: '10' }],
  ])('rejects %j', (query) => {
    expect(() => parseDownloadOptions(query, 'mp4')).toThrow(BadRequestException);
  });
});

describe('optionsSuffix / sectionArg', () => {
  it('keeps the bare key for the default download', () => {
    expect(optionsSuffix({ format: 'mp4' })).toBe('');
  });

  it('encodes every variant', () => {
    expect(optionsSuffix({ format: 'mp4', height: 480, section: { start: 5, end: 9 } })).toBe('_480p_t5-9');
    expect(optionsSuffix({ format: 'mp3', section: { start: 5 } })).toBe('_mp3_t5-end');
  });

  it('builds yt-dlp section specs', () => {
    expect(sectionArg({ start: 5, end: 9 })).toBe('*5-9');
    expect(sectionArg({ start: 5 })).toBe('*5-inf');
  });
});
