import {
  Injectable,
  InternalServerErrorException,
  BadRequestException,
  HttpException,
  Logger,
  ServiceUnavailableException,
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
import { DownloadOptions, optionsSuffix } from './utils/download-options.js';

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

// Smallest quality offered in the picker
const MIN_HEIGHT = 360;

// stderr patterns that mean YouTube is blocking our egress IP
const BLOCKED_PATTERNS = [
  /confirm you.?re not a bot/i,
  /HTTP Error 429/i,
  /HTTP Error 403/i,
  /Sign in to confirm/i,
  /This content isn.?t available, try again later/i,
];

export const BLOCKED_MESSAGE =
  'YouTube is temporarily blocking our server. Please try again in a minute.';

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
      throw this.failure('Could not retrieve video information', result, target);
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
    options: DownloadOptions,
    registerAbort?: (abortFn: () => void) => void,
  ): Promise<DownloadResult> {
    const target = parseMediaTarget(input);
    const key = target.storageKey;
    const duration = this.infoCache.get(key)?.info.duration;
    if (options.section && duration && options.section.start >= duration) {
      throw new BadRequestException('The clip start is past the end of the video.');
    }
    // Every variant (format, quality, clip) gets its own file
    const fileKey = `${key}${optionsSuffix(options)}`;
    const targetExt = options.format;
    const finalFilePath = path.join(this.storageDir, `${fileKey}.${targetExt}`);

    // If already downloaded and cached, return immediately
    if (fs.existsSync(finalFilePath)) {
      const stats = fs.statSync(finalFilePath);
      if (stats.size > 0) {
        this.logger.log(`Serving cached file ${fileKey} (${stats.size} bytes)`);
        return {
          filePath: finalFilePath,
          title: this.cachedTitle(key),
          ext: targetExt,
          fileSize: stats.size,
        };
      }
    }

    this.logger.log(`Executing yt-dlp for ${fileKey}`);
    let expectedExt: string = targetExt;
    let aborted = false;
    const killOnAbort = (child: ChildProcess) => {
      registerAbort?.(() => {
        aborted = true;
        this.logger.warn(`Client aborted download for ${fileKey}. Terminating process.`);
        child.kill('SIGTERM');
        this.cleanupPartialFiles(fileKey);
      });
    };

    // Clips download the full stream through the proxy and are cut here.
    // yt-dlp's --download-sections was slower and unreliable: it hands the
    // download to ffmpeg, which can't use the SOCKS (WARP) proxy, and in
    // testing it dropped the video track of DASH formats
    const stem = options.section ? `${fileKey}.src` : fileKey;
    const result = await this.runYtDlpWithRotation(
      target,
      (attempt) => {
        const built = this.buildDownloadArgs(target, attempt, stem, options);
        expectedExt = built.expectedExt;
        return built.args;
      },
      killOnAbort,
      () => aborted,
    );

    if (aborted) throw new BadRequestException('Download cancelled.');
    if (result.code !== 0) {
      this.logger.error(`Download process exited with code ${result.code}: ${result.stderr}`);
      this.cleanupPartialFiles(fileKey);
      throw this.failure('Download failed', result, target);
    }

    if (options.section) {
      await this.cutSection(stem, finalFilePath, options, killOnAbort, () => aborted);
    }

    const candidateFile = options.section
      ? finalFilePath
      : path.join(this.storageDir, `${fileKey}.${expectedExt}`);
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
   * Cuts the clip out of the downloaded source with ffmpeg. Video is stream
   * copied (cuts snap to the keyframe before the start); MP3 is encoded at
   * 320 kbps; M4A copies AAC audio and only encodes other codecs.
   */
  private async cutSection(
    stem: string,
    destPath: string,
    options: DownloadOptions,
    onChild: (child: ChildProcess) => void,
    isAborted: () => boolean,
  ): Promise<void> {
    const source = fs
      .readdirSync(this.storageDir)
      .find((file) => file.startsWith(`${stem}.`) && !/\.(part|ytdl)$/.test(file));
    if (!source) {
      throw new InternalServerErrorException('Downloaded file was not created properly.');
    }
    const sourcePath = path.join(this.storageDir, source);
    const { start, end } = options.section!;

    const codecArgs =
      options.format === 'mp4'
        ? ['-map', '0', '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart']
        : options.format === 'mp3'
          ? ['-vn', '-c:a', 'libmp3lame', '-b:a', '320k']
          : ['-vn', '-c:a', /\.(m4a|mp4)$/.test(source) ? 'copy' : 'aac', '-b:a', '256k', '-movflags', '+faststart'];
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      String(start),
      '-i',
      sourcePath,
      // -t, not -to: after an input seek the output timeline starts at zero
      ...(end !== undefined ? ['-t', String(end - start)] : []),
      ...codecArgs,
      destPath,
    ];

    try {
      const result = await this.runProcess('ffmpeg', args, onChild);
      if (isAborted()) throw new BadRequestException('Download cancelled.');
      if (result.code !== 0 || !fs.existsSync(destPath) || fs.statSync(destPath).size === 0) {
        this.logger.error(`ffmpeg cut failed (${result.code}): ${result.stderr}`);
        fs.rmSync(destPath, { force: true });
        throw new InternalServerErrorException('Could not cut the clip.');
      }
    } finally {
      fs.rmSync(sourcePath, { force: true });
    }
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
    const ladder = onePerHeight(candidates.filter((f) => (f.height || 0) <= maxHeight).sort(byHeight));
    const best = ladder[0] ?? candidates.sort(byHeight).at(-1);
    if (!best) return undefined;

    const describe = (f: any): DirectStream => ({
      url: f.url,
      height: f.height || undefined,
      size: f.filesize || f.filesize_approx || undefined,
      ext: 'mp4',
    });
    return { direct: describe(best), directs: ladder.length ? ladder.map(describe) : [describe(best)] };
  }

  /**
   * Picks the streams the browser relays and muxes itself: the best H.264
   * video per height within the quality cap (the quality picker's options),
   * best AAC audio (also the in-browser M4A), and a progressive (single-file)
   * fallback. Only direct https formats qualify (no HLS/DASH manifests).
   */
  private selectStreams(videoId: string, formats: any[] | undefined): VideoStreams | undefined {
    if (!Array.isArray(formats)) return undefined;
    const caps: Record<string, number> = { '1080p': 1080, '720p': 720, '480p': 480 };
    const maxHeight = caps[this.defaultQuality] ?? Infinity;
    const direct = formats.filter((f) => f?.url && f.protocol === 'https');
    const byQuality = (a: any, b: any) =>
      (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0);

    const videos = onePerHeight(
      direct
        .filter(
          (f) =>
            String(f.vcodec).startsWith('avc1') &&
            f.acodec === 'none' &&
            f.ext === 'mp4' &&
            (f.height || 0) <= maxHeight,
        )
        .sort(byQuality),
    );
    // Renditions below 360p only as a last resort, so the picker stays useful
    const offered = videos.filter((f) => (f.height || 0) >= MIN_HEIGHT);
    const ladder = offered.length ? offered : videos.slice(0, 1);
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

    if (!(ladder.length && audio) && !progressive && !audio) return undefined;
    // Video-only streams are useless without audio to mux them with
    const muxable = audio ? ladder.map((f) => describe(f)!) : [];
    return {
      video: muxable[0],
      videos: muxable.length ? muxable : undefined,
      audio: describe(audio),
      progressive: describe(progressive),
    };
  }

  private runYtDlp(args: string[], onChild?: (child: ChildProcess) => void): Promise<YtDlpResult> {
    return this.runProcess('yt-dlp', args, onChild);
  }

  private runProcess(
    command: string,
    args: string[],
    onChild?: (child: ChildProcess) => void,
  ): Promise<YtDlpResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { shell: false });
      let stdout = '';
      let stderr = '';
      onChild?.(child);

      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
      child.on('error', (err) => {
        this.logger.error(`Failed to spawn ${command}: ${err.message}`);
        reject(new InternalServerErrorException('Failed to execute downloader engine on server.'));
      });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  }

  /**
   * The error for a failed yt-dlp run. YouTube's bot wall becomes a 503 with
   * code YT_BLOCKED and a plain message: yt-dlp's own text tells the user to
   * pass cookies, which they can't, and the frontend offers a retry instead.
   */
  private failure(prefix: string, result: YtDlpResult, target: MediaTarget): HttpException {
    const errorLine = this.firstErrorLine(result, target);
    if (target.platform === 'youtube' && isBlockedError(errorLine)) {
      return new ServiceUnavailableException({
        statusCode: 503,
        code: 'YT_BLOCKED',
        message: BLOCKED_MESSAGE,
      });
    }
    return new BadRequestException(`${prefix}: ${errorLine}`);
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
    stem: string,
    options: DownloadOptions,
  ): { args: string[]; expectedExt: string } {
    const normalizedUrl = target.normalizedUrl;
    const baseArgs = this.getBaseYtDlpArgs(target, attempt);
    const outputTemplate = path.join(this.storageDir, `${stem}.%(ext)s`);

    // Audio clips: fetch the source audio as is; cutSection converts it
    if (options.section && options.format !== 'mp4') {
      return {
        args: [...baseArgs, '-f', 'ba[ext=m4a]/ba', '-o', outputTemplate, '--', normalizedUrl],
        expectedExt: 'm4a',
      };
    }

    if (options.format === 'mp3') {
      return {
        args: [
          ...baseArgs,
          '-x',
          '--audio-format',
          'mp3',
          '--audio-quality',
          '320K',
          '-o',
          outputTemplate,
          '--',
          normalizedUrl,
        ],
        expectedExt: 'mp3',
      };
    }

    if (options.format === 'm4a') {
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
    // A requested height never exceeds the configured cap
    const caps: Record<string, number> = { '1080p': 1080, '720p': 720, '480p': 480 };
    const cap = caps[this.defaultQuality];
    const height = options.height && cap ? Math.min(options.height, cap) : options.height || cap;
    const h = height ? `[height<=${height}]` : '';
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

/** Keeps the first (best) format of each height from a list sorted best first. */
function onePerHeight(sorted: any[]): any[] {
  const seen = new Set<number>();
  return sorted.filter((f) => {
    const height = f.height || 0;
    if (seen.has(height)) return false;
    seen.add(height);
    return true;
  });
}
