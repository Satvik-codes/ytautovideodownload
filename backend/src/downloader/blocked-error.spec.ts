import { isBlockedError } from './downloader.service.js';

describe('isBlockedError', () => {
  it('detects YouTube bot-wall and rate-limit errors', () => {
    expect(isBlockedError("ERROR: [youtube] abc: Sign in to confirm you're not a bot")).toBe(true);
    expect(isBlockedError('ERROR: unable to download video data: HTTP Error 403: Forbidden')).toBe(true);
    expect(isBlockedError('ERROR: HTTP Error 429: Too Many Requests')).toBe(true);
  });

  it('ignores ordinary failures', () => {
    expect(isBlockedError('ERROR: [youtube] abc: Video unavailable')).toBe(false);
    expect(isBlockedError('ERROR: [youtube] abc: Private video')).toBe(false);
  });
});
