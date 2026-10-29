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
import { extractAndValidateVideo } from './utils/youtube-validator.js';
import { VideoInfoResponse, BackendSettingsResponse } from './dto/video-info.dto.js';
import { WarpService } from './warp.service.js';

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

// The embedded-player client is checked less strictly than the desktop web
// client on datacenter IPs; mweb/tv are fallbacks for non-embeddable videos.
const DEFAULT_EXTRACTOR_ARGS = 'youtube:player_client=web_embedded,mweb,tv';

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

  private getBaseYtDlpArgs(): string[] {
    const baseArgs = [
      '--no-config',
      '--no-playlist',
      '--js-runtimes',
      'node',
      '--user-agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    ];

    // Support optional extractor args or player client overrides
    const extractorArgs = this.configService.get<string>('YOUTUBE_EXTRACTOR_ARGS');
    const playerClient = this.configService.get<string>('YOUTUBE_PLAYER_CLIENT');
    if (extractorArgs && extractorArgs.trim()) {
      baseArgs.push('--extractor-args', extractorArgs.trim());
    } else if (playerClient && playerClient.trim()) {
      baseArgs.push('--extractor-args', `youtube:player_client=${playerClient.trim()}`);
    } else {
      baseArgs.push('--extractor-args', DEFAULT_EXTRACTOR_ARGS);
    }

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

    // An explicit proxy wins; otherwise route through the WARP tunnel when it is up
    const proxy =
      this.configService.get<string>('YOUTUBE_PROXY') ||
      this.configService.get<string>('HTTP_PROXY') ||
      this.configService.get<string>('HTTPS_PROXY') ||
      this.warpService.getProxyUrl();
    if (proxy && proxy.trim()) {
      baseArgs.push('--proxy', proxy.trim());
    }

    return baseArgs;
  }

  async getVideoInfo(input: string): Promise<VideoInfoResponse> {
    const { videoId, normalizedUrl } = extractAndValidateVideo(input);

    const cached = this.infoCache.get(videoId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.info;
    }

    const result = await this.runYtDlpWithRotation(() => [
      ...this.getBaseYtDlpArgs(),
      '--dump-json',
      '--',
      normalizedUrl,
    ]);

    if (result.code !== 0) {
      this.logger.error(`yt-dlp exited with code ${result.code}: ${result.stderr}`);
      throw new BadRequestException(
        `Could not retrieve video information: ${this.firstErrorLine(result)}`,
      );
    }

    let info: any;
    try {
      info = JSON.parse(result.stdout.trim());
    } catch (e) {
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

    const videoInfo: VideoInfoResponse = {
      id: videoId,
      title: (info.title || 'YouTube Video').trim(),
      duration,
      durationFormatted: this.formatDuration(duration),
      author: (info.uploader || info.channel || 'Unknown Channel').trim(),
      thumbnail: info.thumbnail || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      views: info.view_count,
      format: this.defaultFormat,
      quality: this.defaultQuality,
      downloadUrl: `/api/video/download?v=${videoId}`,
    };

    this.infoCache.set(videoId, { info: videoInfo, expiresAt: Date.now() + this.infoCacheTtlMs });
    return videoInfo;
  }

  async downloadVideo(
    input: string,
    registerAbort?: (abortFn: () => void) => void,
  ): Promise<DownloadResult> {
    const { videoId, normalizedUrl } = extractAndValidateVideo(input);
    const targetExt = this.defaultFormat === 'mp3' ? 'mp3' : 'mp4';
    const finalFilePath = path.join(this.storageDir, `${videoId}.${targetExt}`);

    // If already downloaded and cached, return immediately
    if (fs.existsSync(finalFilePath)) {
      const stats = fs.statSync(finalFilePath);
      if (stats.size > 0) {
        this.logger.log(`Serving cached video for ID ${videoId} (${stats.size} bytes)`);
        return {
          filePath: finalFilePath,
          title: this.cachedTitle(videoId),
          ext: targetExt,
          fileSize: stats.size,
        };
      }
    }

    this.logger.log(`Executing yt-dlp for video: ${videoId}`);
    let expectedExt = targetExt;
    let aborted = false;

    const result = await this.runYtDlpWithRotation(
      () => {
        const built = this.buildDownloadArgs(normalizedUrl, videoId);
        expectedExt = built.expectedExt;
        return built.args;
      },
      (child) => {
        registerAbort?.(() => {
          aborted = true;
          this.logger.warn(`Client aborted download for ${videoId}. Terminating process.`);
          child.kill('SIGTERM');
          this.cleanupPartialFiles(videoId);
        });
      },
      () => aborted,
    );

    if (result.code !== 0) {
      this.logger.error(`Download process exited with code ${result.code}: ${result.stderr}`);
      this.cleanupPartialFiles(videoId);
      throw new BadRequestException(`Download failed: ${this.firstErrorLine(result)}`);
    }

    const candidateFile = path.join(this.storageDir, `${videoId}.${expectedExt}`);
    if (!fs.existsSync(candidateFile)) {
      this.logger.error(`Expected file not found at ${candidateFile}`);
      throw new InternalServerErrorException('Downloaded file was not created properly.');
    }

    return {
      filePath: candidateFile,
      title: this.cachedTitle(videoId),
      ext: expectedExt,
      fileSize: fs.statSync(candidateFile).size,
    };
  }

  /**
   * Runs yt-dlp; if YouTube blocks the egress IP and WARP is enabled, rotates
   * the WARP identity and retries once. Args are rebuilt for the retry so the
   * new proxy state applies.
   */
  private async runYtDlpWithRotation(
    buildArgs: () => string[],
    onChild?: (child: ChildProcess) => void,
    shouldStop?: () => boolean,
  ): Promise<YtDlpResult> {
    const first = await this.runYtDlp(buildArgs(), onChild);
    if (first.code === 0 || shouldStop?.() || !isBlockedError(first.stderr)) {
      return first;
    }
    if (!this.warpService.isEnabled()) {
      return first;
    }

    this.logger.warn('YouTube blocked the current egress IP; rotating WARP and retrying once.');
    const rotated = await this.warpService.rotate();
    if (!rotated) {
      return first;
    }
    return this.runYtDlp(buildArgs(), onChild);
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

  private firstErrorLine(result: YtDlpResult): string {
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

  private cachedTitle(videoId: string): string {
    return this.infoCache.get(videoId)?.info.title || `YouTube_Video_${videoId}`;
  }

  private buildDownloadArgs(
    normalizedUrl: string,
    videoId: string,
  ): { args: string[]; expectedExt: string } {
    const baseArgs = this.getBaseYtDlpArgs();
    const outputTemplate = path.join(this.storageDir, `${videoId}.%(ext)s`);

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

    // MP4 Video format selector based on configured quality
    let formatSelector = 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b';

    if (this.defaultQuality === '1080p') {
      formatSelector =
        'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b';
    } else if (this.defaultQuality === '720p') {
      formatSelector =
        'bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*[height<=720]+ba/b';
    } else if (this.defaultQuality === '480p') {
      formatSelector =
        'bv*[height<=480][ext=mp4]+ba[ext=m4a]/bv*[height<=480]+ba/b';
    }

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
