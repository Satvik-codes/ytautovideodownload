import {
  Injectable,
  InternalServerErrorException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { MediaTarget, parseMediaTarget } from './utils/media-target.js';
import {
  VideoInfoResponse,
  BackendSettingsResponse,
  DirectStream,
  StreamDescriptor,
  VideoStreams,
} from './dto/video-info.dto.js';
import { WarpService } from './warp.service.js';
import { StreamTokenPayload, StreamTokenSigner } from './utils/stream-token.js';

export interface DownloadResult {
  filePath: string;
  title: string;
  ext: string;
  fileSize: number;
}

interface YtDlpResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** One extraction attempt: extractor settings plus whether to use the proxy. */
interface Attempt {
  extractorArgs: string;
  useProxy: boolean;
}

// yt-dlp errors for X mapped to messages users can act on. `final` errors are
// about the content itself, so further attempts can't help; login errors are
// not final because X also returns them when it throttles an IP
const TWITTER_ERRORS: { pattern: RegExp; message: string; final: boolean }[] = [
  { pattern: /No video could be found/i, message: 'This post has no video.', final: true },
  { pattern: /Domain Not Found/i, message: 'This video is no longer available on X.', final: true },
  {
    pattern: /(login|log in|authenticat|protected|NSFW|age-restricted)/i,
    message: "This post requires an X login and can't be downloaded.",
    final: false,
  },
];

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// Tried in order. The embedded-player client is checked less strictly on
// datacenter IPs and needs one request; mweb/tv cover non-embeddable videos.
const DEFAULT_CLIENT_CHAIN = ['web_embedded', 'mweb,tv'];

// stderr patterns that mean YouTube is blocking our egress IP
const BLOCKED_PATTERNS = [
  /confirm you.?re not a bot/i,
  /HTTP Error 429/i,
  /HTTP Error 403/i,
  /Sign in to confirm/i,
  /This content isn.?t available, try again later/i,
];

export function isBlockedError(stderr: string): boolean {
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(stderr));
}

@Injectable()
export class DownloaderService {
  private readonly logger = new Logger(DownloaderService.name);
  private readonly storageDir: string;
  private readonly defaultFormat: string;
  private readonly defaultQuality: string;
  private readonly maxDurationSeconds: number;
  private readonly infoCacheTtlMs: number;
  private readonly infoCache = new Map<string, { info: VideoInfoResponse; expiresAt: number }>();
  private readonly tokenSigner: StreamTokenSigner;
  // Titles outlive invalidated info so fallback downloads keep a real filename
  private readonly titles = new Map<string, string>();

  constructor(
    private readonly configService: ConfigService,
    private readonly warpService: WarpService,
  ) {
    this.defaultFormat = (
      this.configService.get<string>('DOWNLOAD_FORMAT') || 'mp4'
    ).toLowerCase();
    this.defaultQuality = (
      this.configService.get<string>('DOWNLOAD_QUALITY') || 'best'
    ).toLowerCase();
    this.maxDurationSeconds = parseInt(
      this.configService.get<string>('MAX_VIDEO_DURATION_SECONDS') || '10800',
      10,
    );
    this.infoCacheTtlMs =
      parseInt(this.configService.get<string>('INFO_CACHE_MINUTES') || '300', 10) * 60 * 1000;
    this.tokenSigner = new StreamTokenSigner(this.configService.get<string>('STREAM_TOKEN_SECRET'));

    const configuredStorage =
      this.configService.get<string>('DOWNLOAD_STORAGE_DIR') || './downloads';
    this.storageDir = path.resolve(process.cwd(), configuredStorage);

    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  getSettings(): BackendSettingsResponse {
    return {
      format: this.defaultFormat,
      quality: this.defaultQuality,
      maxDurationSeconds: this.maxDurationSeconds,
    };
  }

  /** Proxy for all YouTube traffic: an explicit proxy wins, else the WARP tunnel when up. */
  getProxyUrl(): string | null {
    const proxy =
      this.configService.get<string>('YOUTUBE_PROXY') ||
      this.configService.get<string>('HTTP_PROXY') ||
      this.configService.get<string>('HTTPS_PROXY') ||
      this.warpService.getProxyUrl();
    return proxy && proxy.trim() ? proxy.trim() : null;
  }

  verifyStreamToken(token: string): StreamTokenPayload | null {
    return this.tokenSigner.verify(token);
  }

  /** Drops cached info so the next request re-extracts (e.g. after the egress IP changed). */
  invalidateInfo(videoId: string) {
    this.infoCache.delete(videoId);
  }

  /** Attempts to try in order; YouTube env overrides disable its fallback chain. */
  private attemptChain(target: MediaTarget): Attempt[] {
    if (target.platform === 'twitter') {
      // X's guest API may throttle WARP; the last attempt goes out directly
      return [
        { extractorArgs: 'twitter:api=graphql', useProxy: true },
        { extractorArgs: 'twitter:api=syndication', useProxy: true },
        { extractorArgs: 'twitter:api=graphql', useProxy: false },
      ];
    }
    const extractorArgs = this.configService.get<string>('YOUTUBE_EXTRACTOR_ARGS');
    const playerClient = this.configService.get<string>('YOUTUBE_PLAYER_CLIENT');
    if (extractorArgs && extractorArgs.trim()) {
      return [{ extractorArgs: extractorArgs.trim(), useProxy: true }];
    }
    if (playerClient && playerClient.trim()) {
      return [{ extractorArgs: `youtube:player_client=${playerClient.trim()}`, useProxy: true }];
    }
    return DEFAULT_CLIENT_CHAIN.map((clients) => ({
      extractorArgs: `youtube:player_client=${clients}`,
      useProxy: true,
    }));
  }

  private getBaseYtDlpArgs(target: MediaTarget, attempt: Attempt): string[] {
    const baseArgs = [
      '--no-config',
      // X posts with several videos are playlists; pick the requested clip
      ...(target.platform === 'twitter'
        ? ['--playlist-items', String(target.index ?? 1)]
        : ['--no-playlist']),
      '--js-runtimes',
      'node',
      '--user-agent',
      USER_AGENT,
      '--extractor-args',
      attempt.extractorArgs,
    ];

    // Support optional YouTube cookies (via YOUTUBE_COOKIES or COOKIES_FILE env var)
    const cookiesEnv = this.configService.get<string>('YOUTUBE_COOKIES');
    const cookiesFile = this.configService.get<string>('COOKIES_FILE');

    if (cookiesFile && fs.existsSync(cookiesFile)) {
      baseArgs.push('--cookies', cookiesFile);
    } else if (cookiesEnv && cookiesEnv.trim()) {
      const tempCookiePath = path.join(this.storageDir, 'yt_cookies.txt');
      try {
        let content = cookiesEnv.trim();
        if (content.startsWith('base64:')) {
          content = Buffer.from(content.replace('base64:', ''), 'base64').toString('utf-8');
        }
        fs.writeFileSync(tempCookiePath, content, 'utf-8');
        baseArgs.push('--cookies', tempCookiePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Could not write cookies: ${msg}`);
      }
    }

    const proxy = attempt.useProxy ? this.getProxyUrl() : null;
    if (proxy) {
      baseArgs.push('--proxy', proxy);
    }

    return baseArgs;
  }

  async getVideoInfo(input: string): Promise<VideoInfoResponse> {
    const target = parseMediaTarget(input);
    const key = target.storageKey;

    const cached = this.infoCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.info;
    }

    const result = await this.runYtDlpWithRotation(target, (attempt) => [
      ...this.getBaseYtDlpArgs(target, attempt),
      '--dump-json',
      '--',
      target.normalizedUrl,
    ]);

    if (result.code !== 0) {
      this.logger.error(`yt-dlp exited with code ${result.code}: ${result.stderr}`);
      throw new BadRequestException(
        `Could not retrieve video information: ${this.firstErrorLine(result, target)}`,
      );
    }

    let info: any;
    try {
      // One JSON object per line; a playlist-item selection yields exactly one
      const lines = result.stdout.trim().split('\n').filter(Boolean);
      if (!lines.length) {
        throw new BadRequestException(
          target.platform === 'twitter' ? 'This post has no video.' : 'No video found.',
        );
      }
      info = JSON.parse(lines[lines.length - 1]);
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`JSON parse error for video info: ${msg}`);
      throw new InternalServerErrorException('Failed to parse video metadata response.');
    }

    if (info.is_live) {
      throw new BadRequestException('Live streams cannot be downloaded as static videos.');
    }

    const duration = Math.round(Number(info.duration) || 0);
    if (duration > this.maxDurationSeconds) {
      throw new BadRequestException(
        `Video exceeds the maximum allowed duration of ${Math.round(this.maxDurationSeconds / 60)} minutes.`,
      );
    }

    const isTwitter = target.platform === 'twitter';
    const videoInfo: VideoInfoResponse = {
      id: target.id,
      platform: target.platform,
      title: String(info.title || (isTwitter ? 'X Video' : 'YouTube Video'))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200),
      duration,
      durationFormatted: this.formatDuration(duration),
      author: (info.uploader || info.channel || 'Unknown').trim(),
      thumbnail:
        info.thumbnail || (isTwitter ? '' : `https://img.youtube.com/vi/${target.id}/hqdefault.jpg`),
      views: info.view_count,
      format: this.defaultFormat,
      quality: this.defaultQuality,
      downloadUrl: isTwitter
        ? `/api/video/download?url=${encodeURIComponent(this.shareableTwitterUrl(target))}`
        : `/api/video/download?v=${target.id}`,
      streams:
        this.defaultFormat !== 'mp4'
          ? undefined
          : isTwitter
            ? this.selectDirectStream(info.formats)
            : this.selectStreams(target.id, info.formats),
    };

    this.infoCache.set(key, { info: videoInfo, expiresAt: Date.now() + this.infoCacheTtlMs });
    this.titles.set(key, videoInfo.title);
    return videoInfo;
  }

  /** A post URL that parseMediaTarget accepts and that keeps the clip index. */
  private shareableTwitterUrl(target: MediaTarget): string {
    const index = target.index && target.index > 1 ? `/video/${target.index}` : '';
    return `https://x.com/i/status/${target.id}${index}`;
  }

  async downloadVideo(
    input: string,
    registerAbort?: (abortFn: () => void) => void,
  ): Promise<DownloadResult> {
    const target = parseMediaTarget(input);
    const key = target.storageKey;
    const targetExt = this.defaultFormat === 'mp3' ? 'mp3' : 'mp4';
    const finalFilePath = path.join(this.storageDir, `${key}.${targetExt}`);

    // If already downloaded and cached, return immediately
    if (fs.existsSync(finalFilePath)) {
      const stats = fs.statSync(finalFilePath);
      if (stats.size > 0) {
        this.logger.log(`Serving cached video for ${key} (${stats.size} bytes)`);
        return {
          filePath: finalFilePath,
          title: this.cachedTitle(key),
          ext: targetExt,
          fileSize: stats.size,
        };
      }
    }

    this.logger.log(`Executing yt-dlp for ${key}`);
    let expectedExt = targetExt;
    let aborted = false;

    const result = await this.runYtDlpWithRotation(
      target,
      (attempt) => {
        const built = this.buildDownloadArgs(target, attempt);
        expectedExt = built.expectedExt;
        return built.args;
      },
      (child) => {
        registerAbort?.(() => {
          aborted = true;
          this.logger.warn(`Client aborted download for ${key}. Terminating process.`);
          child.kill('SIGTERM');
          this.cleanupPartialFiles(key);
        });
      },
      () => aborted,
    );

    if (result.code !== 0) {
      this.logger.error(`Download process exited with code ${result.code}: ${result.stderr}`);
      this.cleanupPartialFiles(key);
      throw new BadRequestException(`Download failed: ${this.firstErrorLine(result, target)}`);
    }

    const candidateFile = path.join(this.storageDir, `${key}.${expectedExt}`);
    if (!fs.existsSync(candidateFile)) {
      this.logger.error(`Expected file not found at ${candidateFile}`);
      throw new InternalServerErrorException('Downloaded file was not created properly.');
    }

    return {
      filePath: candidateFile,
      title: this.cachedTitle(key),
      ext: expectedExt,
      fileSize: fs.statSync(candidateFile).size,
    };
  }

  /**
   * Runs yt-dlp with each attempt in the platform's chain until one succeeds.
   * If the egress IP is blocked and WARP is enabled, rotates the WARP identity
   * and retries the same attempt once. Args are rebuilt per attempt so the
   * current proxy state applies.
   */
  private async runYtDlpWithRotation(
    target: MediaTarget,
    buildArgs: (attempt: Attempt) => string[],
    onChild?: (child: ChildProcess) => void,
    shouldStop?: () => boolean,
  ): Promise<YtDlpResult> {
    let result: YtDlpResult | null = null;
    let rotated = false;

    for (const attempt of this.attemptChain(target)) {
      result = await this.runYtDlp(buildArgs(attempt), onChild);
      if (result.code === 0 || shouldStop?.()) {
        if (result.code === 0 && target.platform === 'twitter') {
          this.logger.log(`X extraction succeeded via ${attempt.extractorArgs} (proxy: ${attempt.useProxy})`);
        }
        return result;
      }

      if (attempt.useProxy && isBlockedError(result.stderr) && !rotated && this.warpService.isEnabled()) {
        rotated = true;
        this.logger.warn('Egress IP blocked; rotating WARP and retrying.');
        if (await this.warpService.rotate()) {
          result = await this.runYtDlp(buildArgs(attempt), onChild);
          if (result.code === 0 || shouldStop?.()) return result;
        }
      }
      this.logger.warn(
        `yt-dlp failed with ${attempt.extractorArgs} (proxy: ${attempt.useProxy}): ${this.firstErrorLine(result)}`,
      );
      // Content errors (no video, deleted) won't change with another attempt
      if (target.platform === 'twitter' && this.matchTwitterError(result)?.final) break;
    }
    return result!;
  }

  /**
   * X serves single-file MP4s from video.twimg.com that are neither signed
   * nor IP-locked and allow CORS, so the browser downloads them directly.
   */
  private selectDirectStream(formats: any[] | undefined): VideoStreams | undefined {
    if (!Array.isArray(formats)) return undefined;
    const caps: Record<string, number> = { '1080p': 1080, '720p': 720, '480p': 480 };
    const maxHeight = caps[this.defaultQuality] ?? Infinity;
    const candidates = formats.filter((f) => {
      if (!f?.url || f.protocol !== 'https' || f.ext !== 'mp4') return false;
      try {
        return new URL(f.url).hostname === 'video.twimg.com';
      } catch {
        return false;
      }
    });
    const byHeight = (a: any, b: any) =>
      (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0);
    const best =
      candidates.filter((f) => (f.height || 0) <= maxHeight).sort(byHeight)[0] ??
      candidates.sort(byHeight).at(-1);
    if (!best) return undefined;

    const direct: DirectStream = {
      url: best.url,
      height: best.height || undefined,
      size: best.filesize || best.filesize_approx || undefined,
      ext: 'mp4',
    };
    return { direct };
  }

  /**
   * Picks the streams the browser relays and muxes itself: best H.264 video
   * within the quality cap, best AAC audio, and a progressive (single-file)
   * fallback. Only direct https formats qualify (no HLS/DASH manifests).
   */
  private selectStreams(videoId: string, formats: any[] | undefined): VideoStreams | undefined {
    if (!Array.isArray(formats)) return undefined;
    const caps: Record<string, number> = { '1080p': 1080, '720p': 720, '480p': 480 };
    const maxHeight = caps[this.defaultQuality] ?? Infinity;
    const direct = formats.filter((f) => f?.url && f.protocol === 'https');
    const byQuality = (a: any, b: any) =>
      (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0);

    const video = direct
      .filter(
        (f) =>
          String(f.vcodec).startsWith('avc1') &&
          f.acodec === 'none' &&
          f.ext === 'mp4' &&
          (f.height || 0) <= maxHeight,
      )
      .sort(byQuality)[0];
    const audio = direct
      .filter((f) => String(f.acodec).startsWith('mp4a') && f.vcodec === 'none' && f.ext === 'm4a')
      .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
    const progressive = direct
      .filter(
        (f) => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && f.ext === 'mp4',
      )
      .sort(byQuality)[0];

    const describe = (f: any): StreamDescriptor | undefined => {
      if (!f) return undefined;
      const urlExpiry = Number(new URL(f.url).searchParams.get('expire'));
      const fallbackExpiry = Math.floor((Date.now() + this.infoCacheTtlMs) / 1000);
      return {
        token: this.tokenSigner.sign({ u: f.url, v: videoId, e: urlExpiry || fallbackExpiry }),
        height: f.height || undefined,
        size: f.filesize || f.filesize_approx || undefined,
        ext: f.ext,
      };
    };

    if (!(video && audio) && !progressive) return undefined;
    return {
      video: video && audio ? describe(video) : undefined,
      audio: video && audio ? describe(audio) : undefined,
      progressive: describe(progressive),
    };
  }

  private runYtDlp(args: string[], onChild?: (child: ChildProcess) => void): Promise<YtDlpResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('yt-dlp', args, { shell: false });
      let stdout = '';
      let stderr = '';
      onChild?.(child);

      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
      child.on('error', (err) => {
        this.logger.error(`Failed to spawn yt-dlp: ${err.message}`);
        reject(new InternalServerErrorException('Failed to execute downloader engine on server.'));
      });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  private firstErrorLine(result: YtDlpResult, target?: MediaTarget): string {
    if (target?.platform === 'twitter') {
      const friendly = this.matchTwitterError(result);
      if (friendly) return friendly.message;
    }
    return (
      result.stderr
        .split('\n')
        .find((line) => line.includes('ERROR:'))
        ?.replace(/^.*ERROR:\s*/, '')
        ?.trim() ||
      result.stderr.trim() ||
      `Exit code ${result.code}`
    );
  }

  private matchTwitterError(result: YtDlpResult) {
    const errorLines = result.stderr
      .split('\n')
      .filter((line) => line.includes('ERROR:'))
      .join('\n');
    return TWITTER_ERRORS.find(({ pattern }) => pattern.test(errorLines)) ?? null;
  }

  private cachedTitle(key: string): string {
    const fallback = key.startsWith('tw_') ? `X_Video_${key.slice(3)}` : `YouTube_Video_${key}`;
    return this.titles.get(key) || fallback;
  }

  private buildDownloadArgs(
    target: MediaTarget,
    attempt: Attempt,
  ): { args: string[]; expectedExt: string } {
    const normalizedUrl = target.normalizedUrl;
    const baseArgs = this.getBaseYtDlpArgs(target, attempt);
    const outputTemplate = path.join(this.storageDir, `${target.storageKey}.%(ext)s`);

    if (this.defaultFormat === 'mp3') {
      return {
        args: [
          ...baseArgs,
          '-x',
          '--audio-format',
          'mp3',
          '--audio-quality',
          '0',
          '-o',
          outputTemplate,
          '--',
          normalizedUrl,
        ],
        expectedExt: 'mp3',
      };
    }

    if (this.defaultFormat === 'm4a') {
      return {
        args: [
          ...baseArgs,
          '-x',
          '--audio-format',
          'm4a',
          '-o',
          outputTemplate,
          '--',
          normalizedUrl,
        ],
        expectedExt: 'm4a',
      };
    }

    // MP4 video format selector based on configured quality. H.264 (avc1) is
    // preferred: YouTube also ships AV1 in MP4, which many players (including
    // Windows' built-in ones) can't play without an extra codec
    const caps: Record<string, string> = { '1080p': '1080', '720p': '720', '480p': '480' };
    const h = caps[this.defaultQuality] ? `[height<=${caps[this.defaultQuality]}]` : '';
    // X ships single-file H.264 MP4s over https; prefer those over its HLS variants
    const formatSelector = (
      target.platform === 'twitter'
        ? [`b${h}[protocol=https][ext=mp4]`, 'b[protocol=https][ext=mp4]', 'b[ext=mp4]', 'b']
        : [
            `bv*${h}[vcodec^=avc1]+ba[ext=m4a]`,
            `b${h}[vcodec^=avc1][acodec!=none]`,
            `bv*${h}[ext=mp4]+ba[ext=m4a]`,
            `bv*${h}+ba`,
            'b',
          ]
    ).join('/');

    return {
      args: [
        ...baseArgs,
        '-f',
        formatSelector,
        '--merge-output-format',
        'mp4',
        '-o',
        outputTemplate,
        '--',
        normalizedUrl,
      ],
      expectedExt: 'mp4',
    };
  }

  private cleanupPartialFiles(videoId: string) {
    try {
      const files = fs.readdirSync(this.storageDir);
      for (const file of files) {
        if (file.startsWith(videoId) && (file.endsWith('.part') || file.endsWith('.ytdl'))) {
          fs.unlinkSync(path.join(this.storageDir, file));
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Could not cleanup partial files for ${videoId}: ${msg}`);
    }
  }

  private formatDuration(seconds: number): string {
    if (!seconds || seconds <= 0) return '0:00';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    const formattedSecs = secs < 10 ? `0${secs}` : `${secs}`;
    if (hrs > 0) {
      const formattedMins = mins < 10 ? `0${mins}` : `${mins}`;
      return `${hrs}:${formattedMins}:${formattedSecs}`;
    }
    return `${mins}:${formattedSecs}`;
  }
}
