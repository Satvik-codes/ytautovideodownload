import { StreamTokenSigner } from './stream-token.js';
import { MAX_RELAY_CHUNK_BYTES, parseClampedRange } from './stream-relay.js';

const URL = 'https://rr1---sn-abc.googlevideo.com/videoplayback?expire=9999999999&ip=1.2.3.4';

describe('StreamTokenSigner', () => {
  const signer = new StreamTokenSigner('test-secret');
  const future = Math.floor(Date.now() / 1000) + 3600;

  it('round-trips a valid token', () => {
    const token = signer.sign({ u: URL, v: 'abc', e: future });
    expect(signer.verify(token)).toEqual({ u: URL, v: 'abc', e: future });
  });

  it('rejects tampered, expired, foreign-secret and non-googlevideo tokens', () => {
    const token = signer.sign({ u: URL, v: 'abc', e: future });
    const tampered = token.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
    expect(signer.verify(tampered)).toBeNull();
    expect(signer.verify(signer.sign({ u: URL, v: 'abc', e: 1 }))).toBeNull();
    expect(new StreamTokenSigner('other').verify(token)).toBeNull();
    expect(signer.verify(signer.sign({ u: 'https://evil.example.com/x', v: 'abc', e: future }))).toBeNull();
    expect(signer.verify('garbage')).toBeNull();
  });
});

describe('parseClampedRange', () => {
  it('clamps open-ended and oversized ranges', () => {
    expect(parseClampedRange('bytes=0-')).toEqual({ start: 0, end: MAX_RELAY_CHUNK_BYTES - 1 });
    expect(parseClampedRange(undefined)).toEqual({ start: 0, end: MAX_RELAY_CHUNK_BYTES - 1 });
    expect(parseClampedRange('bytes=100-199')).toEqual({ start: 100, end: 199 });
    expect(parseClampedRange('bytes=10-999999999')).toEqual({ start: 10, end: 10 + MAX_RELAY_CHUNK_BYTES - 1 });
  });

  it('rejects malformed ranges', () => {
    expect(parseClampedRange('bytes=200-100')).toBeNull();
    expect(parseClampedRange('items=0-1')).toBeNull();
    expect(parseClampedRange('bytes=-500')).toBeNull();
  });
});
