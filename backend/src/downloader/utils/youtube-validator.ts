import { BadRequestException } from '@nestjs/common';

export interface ParsedVideoTarget {
  videoId: string;
  normalizedUrl: string;
}

const YOUTUBE_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

export function extractAndValidateVideo(input: string): ParsedVideoTarget {
  if (!input || typeof input !== 'string') {
    throw new BadRequestException('A valid YouTube URL or Video ID is required.');
  }

  let target = input.trim();

  // Try decoding if it was URL-encoded (e.g. from /video?url=https%3A%2F%2F...)
  try {
    if (target.includes('%')) {
      target = decodeURIComponent(target);
    }
  } catch {
    // Keep target as is if decode fails
  }

  // Handle nested yout-style url query like: url=https://www.youtube.com/watch?v=...
  if (target.includes('url=')) {
    const urlParamMatch = target.match(/url=([^&]+)/);
    if (urlParamMatch && urlParamMatch[1]) {
      target = decodeURIComponent(urlParamMatch[1]);
    }
  }

  // 1. Check if directly an 11-char video ID
  if (YOUTUBE_ID_REGEX.test(target)) {
    return {
      videoId: target,
      normalizedUrl: `https://www.youtube.com/watch?v=${target}`,
    };
  }

  // Verify domain first to reject SSRF and non-youtube links
  const isYoutubeDomain =
    /^(?:https?:\/\/)?(?:[a-zA-Z0-9-]+\.)*(?:youtube\.com|youtu\.be)(?::\d+)?(?:\/|$)/i.test(
      target,
    );

  if (!isYoutubeDomain) {
    throw new BadRequestException(
      'Invalid YouTube domain. Only youtube.com and youtu.be links are allowed.',
    );
  }

  // 2. Check if a v= parameter is present
  const vParamMatch = target.match(/[?&]v=([^&#\s]+)/);
  if (vParamMatch && vParamMatch[1]) {
    const candidateId = vParamMatch[1];
    if (YOUTUBE_ID_REGEX.test(candidateId)) {
      return {
        videoId: candidateId,
        normalizedUrl: `https://www.youtube.com/watch?v=${candidateId}`,
      };
    }
    throw new BadRequestException('YouTube video ID must be exactly 11 characters.');
  }

  // 3. Shorts URL: /shorts/([a-zA-Z0-9_-]{11})
  const shortsMatch = target.match(/\/shorts\/([^/?&#\s]+)/);
  if (shortsMatch && shortsMatch[1]) {
    const candidateId = shortsMatch[1];
    if (YOUTUBE_ID_REGEX.test(candidateId)) {
      return {
        videoId: candidateId,
        normalizedUrl: `https://www.youtube.com/watch?v=${candidateId}`,
      };
    }
    throw new BadRequestException('YouTube Shorts ID must be exactly 11 characters.');
  }

  // 4. youtu.be/ID
  const youtuBeMatch = target.match(/youtu\.be\/([^/?&#\s]+)/);
  if (youtuBeMatch && youtuBeMatch[1]) {
    const candidateId = youtuBeMatch[1];
    if (YOUTUBE_ID_REGEX.test(candidateId)) {
      return {
        videoId: candidateId,
        normalizedUrl: `https://www.youtube.com/watch?v=${candidateId}`,
      };
    }
    throw new BadRequestException('youtu.be ID must be exactly 11 characters.');
  }

  // 5. Embed or /v/ URL
  const embedMatch = target.match(/\/(?:embed|v)\/([^/?&#\s]+)/);
  if (embedMatch && embedMatch[1]) {
    const candidateId = embedMatch[1];
    if (YOUTUBE_ID_REGEX.test(candidateId)) {
      return {
        videoId: candidateId,
        normalizedUrl: `https://www.youtube.com/watch?v=${candidateId}`,
      };
    }
    throw new BadRequestException('YouTube embed ID must be exactly 11 characters.');
  }

  throw new BadRequestException(
    'Invalid YouTube URL structure. Please provide a valid youtube.com or youtu.be video link.',
  );
}
