const YOUTUBE_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

export function extractVideoId(input: string): string | null {
  if (!input || typeof input !== 'string') return null;

  let target = input.trim();

  // Try decoding if query was encoded
  try {
    if (target.includes('%')) {
      target = decodeURIComponent(target);
    }
  } catch {
    // Keep as is
  }

  // Handle nested yout-style url query: url=https://...
  if (target.includes('url=')) {
    const urlMatch = target.match(/url=([^&]+)/);
    if (urlMatch && urlMatch[1]) {
      target = decodeURIComponent(urlMatch[1]);
    }
  }

  // 1. Check if directly 11 chars
  if (YOUTUBE_ID_REGEX.test(target)) {
    return target;
  }

  // 2. Query param v=...
  const vMatch = target.match(/[?&]v=([a-zA-Z0-9_-]{11})(?:[&?#\s]|$)/);
  if (vMatch && vMatch[1]) {
    return vMatch[1];
  }

  // 3. Shorts /shorts/...
  const shortsMatch = target.match(/\/shorts\/([a-zA-Z0-9_-]{11})(?:[/?&#\s]|$)/);
  if (shortsMatch && shortsMatch[1]) {
    return shortsMatch[1];
  }

  // 4. youtu.be/...
  const youtuBeMatch = target.match(/youtu\.be\/([a-zA-Z0-9_-]{11})(?:[/?&#\s]|$)/);
  if (youtuBeMatch && youtuBeMatch[1]) {
    return youtuBeMatch[1];
  }

  // 5. /embed/ or /v/
  const embedMatch = target.match(/\/(?:embed|v)\/([a-zA-Z0-9_-]{11})(?:[/?&#\s]|$)/);
  if (embedMatch && embedMatch[1]) {
    return embedMatch[1];
  }

  return null;
}

export type Platform = 'youtube' | 'twitter';

export interface MediaRef {
  platform: Platform;
  id: string;
  /** Query string for /api/video/info and /download */
  apiQuery: string;
  /** Path to show in the address bar so the link can be copied or bookmarked */
  shareablePath: string;
}

// Mirrors the backend allowlist (backend/src/downloader/utils/media-target.ts)
const TWITTER_HOSTS = new Set([
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'fxtwitter.com',
  'vxtwitter.com',
  'fixupx.com',
  'fixvx.com',
]);
const TWEET_PATH =
  /^\/(?:i(?:\/web)?|[A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,20})(?:\/video\/(\d{1,2}))?\/?$/;

/** Parses an X post link, or a bare `user/status/id` path from the URL trick. */
export function parseTwitterInput(input: string): MediaRef | null {
  let raw = (input || '').trim();
  try {
    if (raw.includes('%')) raw = decodeURIComponent(raw);
  } catch {
    // keep as is
  }

  const withScheme = /^https?:\/\//i.test(raw)
    ? raw
    : /^\/?[A-Za-z0-9_]{1,15}\/status\//.test(raw)
      ? `https://x.com/${raw.replace(/^\/+/, '')}`
      : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.username || url.password || !TWITTER_HOSTS.has(url.hostname.toLowerCase())) return null;

  const match = TWEET_PATH.exec(url.pathname);
  if (!match) return null;

  const id = match[1];
  const clip = match[2] && Number(match[2]) > 1 ? `/video/${match[2]}` : '';
  const canonical = `https://x.com/i/status/${id}${clip}`;
  return {
    platform: 'twitter',
    id,
    apiQuery: `url=${encodeURIComponent(canonical)}`,
    shareablePath: `/i/status/${id}${clip}`,
  };
}

/** Any supported link: YouTube (URL or 11-char ID) or an X post. */
export function parseMediaInput(input: string): MediaRef | null {
  const twitter = parseTwitterInput(input);
  if (twitter) return twitter;

  const id = extractVideoId(input);
  return id
    ? { platform: 'youtube', id, apiQuery: `v=${encodeURIComponent(id)}`, shareablePath: `/?v=${id}` }
    : null;
}

export function detectMediaFromCurrentWindow(): MediaRef | null {
  if (typeof window === 'undefined') return null;

  const urlParams = new URLSearchParams(window.location.search);

  // 1. Check ?v= parameter (typical when replacing youtube.com/watch?v=... with youdown.com/watch?v=...)
  const vParam = urlParams.get('v');
  if (vParam) {
    const ref = parseMediaInput(vParam);
    if (ref) return ref;
  }

  // 2. Check ?url= parameter (typical in yout.com/video/?url=...)
  const urlParam = urlParams.get('url');
  if (urlParam) {
    const ref = parseMediaInput(urlParam);
    if (ref) return ref;
  }

  // 3. Check pathname: X posts (x.com/user/status/ID → youdown/user/status/ID),
  //    YouTube /shorts/ID, /watch/ID or a bare /ID slug
  const pathname = window.location.pathname;
  if (pathname && pathname !== '/') {
    const twitter = parseTwitterInput(pathname);
    if (twitter) return twitter;

    const idFromPath = extractVideoId(pathname);
    if (idFromPath) return parseMediaInput(idFromPath);

    const slug = pathname.replace(/^\/+/, '');
    if (YOUTUBE_ID_REGEX.test(slug)) {
      return parseMediaInput(slug);
    }
  }

  return null;
}
