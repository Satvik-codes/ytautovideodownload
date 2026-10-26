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

export function detectVideoIdFromCurrentWindow(): string | null {
  if (typeof window === 'undefined') return null;

  const urlParams = new URLSearchParams(window.location.search);

  // 1. Check ?v= parameter (typical when replacing youtube.com/watch?v=... with youdown.com/watch?v=...)
  const vParam = urlParams.get('v');
  if (vParam) {
    const id = extractVideoId(vParam);
    if (id) return id;
  }

  // 2. Check ?url= parameter (typical in yout.com/video/?url=...)
  const urlParam = urlParams.get('url');
  if (urlParam) {
    const id = extractVideoId(urlParam);
    if (id) return id;
  }

  // 3. Check pathname (e.g. /shorts/ID or /watch/ID or /ID)
  const pathname = window.location.pathname;
  if (pathname) {
    const idFromPath = extractVideoId(pathname);
    if (idFromPath) return idFromPath;

    // Direct 11-char slug like /JYyzYnvad50
    const slug = pathname.replace(/^\/+/, '');
    if (YOUTUBE_ID_REGEX.test(slug)) {
      return slug;
    }
  }

  return null;
}
