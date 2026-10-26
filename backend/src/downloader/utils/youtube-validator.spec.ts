import { describe, it, expect } from 'vitest';
import { extractAndValidateVideo } from './youtube-validator.js';
import { sanitizeFilename } from './filename-sanitizer.js';

describe('YouTube Validator & Sanitizer Security Tests', () => {
  it('should accurately parse standard 11-character video ID', () => {
    const result = extractAndValidateVideo('JYyzYnvad50');
    expect(result.videoId).toBe('JYyzYnvad50');
    expect(result.normalizedUrl).toBe('https://www.youtube.com/watch?v=JYyzYnvad50');
  });

  it('should parse standard youtube.com/watch?v=... URL', () => {
    const result = extractAndValidateVideo('https://www.youtube.com/watch?v=JYyzYnvad50');
    expect(result.videoId).toBe('JYyzYnvad50');
  });

  it('should parse yout.com style redirect URL /video/?url=...', () => {
    const result = extractAndValidateVideo(
      'https://yout.com/video/?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DJYyzYnvad50',
    );
    expect(result.videoId).toBe('JYyzYnvad50');
  });

  it('should parse youtube shorts URL', () => {
    const result = extractAndValidateVideo('https://www.youtube.com/shorts/JYyzYnvad50');
    expect(result.videoId).toBe('JYyzYnvad50');
  });

  it('should parse youtu.be short URL', () => {
    const result = extractAndValidateVideo('https://youtu.be/JYyzYnvad50?t=42');
    expect(result.videoId).toBe('JYyzYnvad50');
  });

  it('should reject non-YouTube domains (SSRF attack mitigation)', () => {
    expect(() => extractAndValidateVideo('http://169.254.169.254/latest/meta-data/')).toThrow();
    expect(() => extractAndValidateVideo('https://evil.com/video/JYyzYnvad50')).toThrow();
    expect(() => extractAndValidateVideo('http://localhost:8080/admin')).toThrow();
  });

  it('should reject command injection and argument payloads', () => {
    expect(() => extractAndValidateVideo('--exec "calc.exe"')).toThrow();
    expect(() => extractAndValidateVideo('; rm -rf / ;')).toThrow();
    expect(() => extractAndValidateVideo('https://youtube.com/watch?v=invalid_id_too_long_12345')).toThrow();
  });

  it('should sanitize filename and prevent CRLF injection in headers', () => {
    const rawTitle = 'Super Cool Video\r\nInjected-Header: evil\n"quote"';
    const { asciiFallback, utf8Encoded, cleanBaseName } = sanitizeFilename(rawTitle, 'mp4');

    expect(asciiFallback).not.toContain('\r');
    expect(asciiFallback).not.toContain('\n');
    expect(cleanBaseName).not.toContain('"');
    expect(utf8Encoded.startsWith("UTF-8''")).toBe(true);
  });
});
