import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

export interface StreamTokenPayload {
  /** googlevideo URL (IP-locked to our egress) */
  u: string;
  /** video ID, used to invalidate cached info when the URL dies */
  v: string;
  /** expiry, unix seconds */
  e: number;
}

/**
 * Signed, expiring stream tokens: base64url(JSON).base64url(HMAC-SHA256).
 * The browser only ever sees opaque tokens, never raw googlevideo URLs, and
 * cannot point the relay at arbitrary hosts.
 */
export class StreamTokenSigner {
  private readonly secret: Buffer;

  constructor(secret?: string) {
    // A per-process random secret is fine: tokens are as short-lived as the
    // in-memory info cache they come from
    this.secret = secret ? Buffer.from(secret, 'utf-8') : randomBytes(32);
  }

  sign(payload: StreamTokenPayload): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
    return `${body}.${this.mac(body)}`;
  }

  /** Returns the payload, or null if the token is malformed, forged or expired. */
  verify(token: string, nowSeconds = Math.floor(Date.now() / 1000)): StreamTokenPayload | null {
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;

    const expected = Buffer.from(this.mac(body));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

    let payload: StreamTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
    } catch {
      return null;
    }
    if (typeof payload.u !== 'string' || typeof payload.e !== 'number' || payload.e < nowSeconds) {
      return null;
    }
    if (!/^https:\/\/[a-z0-9.-]+\.googlevideo\.com\//i.test(payload.u)) return null;
    return payload;
  }

  private mac(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}
