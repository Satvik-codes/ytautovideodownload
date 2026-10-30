import { parseMediaTarget } from './media-target.js';

describe('parseMediaTarget', () => {
  it('keeps YouTube parsing unchanged', () => {
    expect(parseMediaTarget('https://www.youtube.com/watch?v=JYyzYnvad50')).toEqual({
      platform: 'youtube',
      id: 'JYyzYnvad50',
      normalizedUrl: 'https://www.youtube.com/watch?v=JYyzYnvad50',
      storageKey: 'JYyzYnvad50',
    });
    expect(parseMediaTarget('JYyzYnvad50').platform).toBe('youtube');
  });

  it.each([
    'https://x.com/primevideouk/status/1578401165338976258',
    'https://twitter.com/primevideouk/status/1578401165338976258',
    'https://mobile.twitter.com/primevideouk/status/1578401165338976258',
    'https://www.x.com/primevideouk/status/1578401165338976258?s=20&t=abc',
    'x.com/primevideouk/status/1578401165338976258',
    'https://fxtwitter.com/primevideouk/status/1578401165338976258',
    'https://vxtwitter.com/primevideouk/status/1578401165338976258/',
    'https://x.com/i/web/status/1578401165338976258',
    'https://x.com/i/status/1578401165338976258',
    'primevideouk/status/1578401165338976258',
    '/primevideouk/status/1578401165338976258',
    'https://yout.com/video/?url=https%3A%2F%2Fx.com%2Fprimevideouk%2Fstatus%2F1578401165338976258',
  ])('parses X post link %s', (input) => {
    expect(parseMediaTarget(input)).toEqual({
      platform: 'twitter',
      id: '1578401165338976258',
      normalizedUrl: 'https://twitter.com/i/web/status/1578401165338976258',
      storageKey: 'tw_1578401165338976258',
      index: 1,
    });
  });

  it('selects a clip in multi-video posts', () => {
    const target = parseMediaTarget('https://x.com/user/status/123456789/video/2');
    expect(target.index).toBe(2);
    expect(target.storageKey).toBe('tw_123456789_2');
  });

  it.each([
    'https://x.com.evil.com/user/status/123',
    'https://evilx.com/user/status/123',
    'https://user@x.com/user/status/123',
    'https://evil.com/x.com/user/status/123',
    'https://t.co/AbCdEf',
    'https://x.com/i/spaces/1ABCDEF',
    'https://x.com/user/status/notanumber',
    'https://x.com/user',
    'javascript:alert(1)//x.com/user/status/1',
    'http://169.254.169.254/latest/meta-data/',
  ])('rejects %s', (input) => {
    expect(() => parseMediaTarget(input)).toThrow();
  });
});
