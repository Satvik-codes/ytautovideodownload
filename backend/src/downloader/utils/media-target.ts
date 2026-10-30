import { BadRequestException } from '@nestjs/common';
import { extractAndValidateVideo } from './youtube-validator.js';

export type Platform = 'youtube' | 'twitter';

export interface MediaTarget {
  platform: Platform;
  /** YouTube video ID or X post ID */
  id: string;
  normalizedUrl: string;
  /** Collision-free key for caches and files on disk */
  storageKey: string;
  /** 1-based clip index within a multi-video X post */
  index?: number;
}

// Exact hosts only: subdomain/lookalike tricks (x.com.evil.com) never match
const TWITTER_HOSTS = new Set([
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'x.com',
  'www.x.com',
  'mobile.x.com',
  // embed-fixer mirrors people commonly share
  'fxtwitter.com',
  'vxtwitter.com',
  'fixupx.com',
  'fixvx.com',
]);

const TWEET_PATH = /^\/(?:i(?:\/web)?|[A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,20})(?:\/video\/(\d{1,2}))?\/?$/;

export function isTwitterInput(input: string): boolean {
  return /(?:^|\/\/|\.)(?:twitter|x|fxtwitter|vxtwitter|fixupx|fixvx)\.com\b|^\/?[A-Za-z0-9_]{1,15}\/status\/\d/i.test(
    input.trim(),
  );
}

/**
 * Resolves user input to a supported media target. YouTube input goes through
 * the existing validator unchanged; X links are parsed with URL() against an
 * exact host allowlist.
 */
export function parseMediaTarget(input: string): MediaTarget {
  if (!input || typeof input !== 'string') {
    throw new BadRequestException('A valid YouTube or X (Twitter) link is required.');
  }
  let target = input.trim();
  try {
    if (target.includes('%')) target = decodeURIComponent(target);
  } catch {
    // keep as is
  }
  const nested = /[?&]url=([^&]+)/.exec(target);
  if (nested?.[1]) {
    try {
      target = decodeURIComponent(nested[1]);
    } catch {
      target = nested[1];
    }
  }

  if (/^(?:https?:\/\/)?t\.co\//i.test(target)) {
    throw new BadRequestException('Short t.co links are not supported. Please paste the full x.com post link.');
  }

  if (isTwitterInput(target)) {
    return parseTwitter(target);
  }

  const { videoId, normalizedUrl } = extractAndValidateVideo(target);
  return { platform: 'youtube', id: videoId, normalizedUrl, storageKey: videoId };
}

function parseTwitter(raw: string): MediaTarget {
  // Bare "user/status/123" paths come from the URL trick (youdown-host/user/status/123)
  const withScheme = /^https?:\/\//i.test(raw)
    ? raw
    : /^\/?[A-Za-z0-9_]{1,15}\/status/.test(raw)
      ? `https://x.com/${raw.replace(/^\/+/, '')}`
      : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new BadRequestException('Invalid X (Twitter) link.');
  }

  if (url.username || url.password || !TWITTER_HOSTS.has(url.hostname.toLowerCase())) {
    throw new BadRequestException('Invalid X (Twitter) domain. Only x.com and twitter.com post links are allowed.');
  }
  if (url.pathname.startsWith('/i/spaces') || url.pathname.startsWith('/i/broadcasts')) {
    throw new BadRequestException('X Spaces and live broadcasts are not supported.');
  }

  const match = TWEET_PATH.exec(url.pathname);
  if (!match) {
    throw new BadRequestException('Please provide a link to a specific X post (x.com/user/status/...).');
  }

  const id = match[1];
  const index = match[2] ? Math.max(1, Number(match[2])) : 1;
  return {
    platform: 'twitter',
    id,
    normalizedUrl: `https://twitter.com/i/web/status/${id}`,
    storageKey: index > 1 ? `tw_${id}_${index}` : `tw_${id}`,
    index,
  };
}
