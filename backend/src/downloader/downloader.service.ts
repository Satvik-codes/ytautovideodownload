import {
  Injectable,
  InternalServerErrorException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { extractAndValidateVideo } from './utils/youtube-validator.js';
import { VideoInfoResponse, BackendSettingsResponse } from './dto/video-info.dto.js';

export interface DownloadResult {
  filePath: string;
  title: string;
  ext: string;
  fileSize: number;
}

@Injectable()
export class DownloaderService {
  private readonly logger = new Logger(DownloaderService.name);
  private readonly storageDir: string;
  private readonly defaultFormat: string;
  private readonly defaultQuality: string;
  private readonly maxDurationSeconds: number;

  constructor(private readonly configService: ConfigService) {
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
      // Use TV, iOS, and Mobile Web clients (bypasses desktop WEB client bot challenge on datacenter IPs)
      '--extractor-args',
      'youtube:player_client=tv,ios,mweb',
      '--user-agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
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

    // Support optional proxy if datacenter IP is completely blocked by YouTube
    const proxy =
      this.configService.get<string>('YOUTUBE_PROXY') ||
      this.configService.get<string>('HTTP_PROXY') ||
      this.configService.get<string>('HTTPS_PROXY');
    if (proxy && proxy.trim()) {
      baseArgs.push('--proxy', proxy.trim());
    }

    return baseArgs;
  }

  async getVideoInfo(input: string): Promise<VideoInfoResponse> {
    const { videoId, normalizedUrl } = extractAndValidateVideo(input);

    return new Promise<VideoInfoResponse>((resolve, reject) => {
      const args = [
        ...this.getBaseYtDlpArgs(),
        '--dump-json',
        '--',
        normalizedUrl,
      ];

      const child = spawn('yt-dlp', args, { shell: false });
      let stdoutData = '';
      let stderrData = '';

      child.stdout.on('data', (chunk) => {
        stdoutData += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderrData += chunk.toString();
      });

      child.on('error', (err) => {
        this.logger.error(`Failed to spawn yt-dlp: ${err.message}`);
        reject(
          new InternalServerErrorException(
            'Failed to execute downloader engine on server.',
          ),
        );
      });

      child.on('close', (code) => {
        if (code !== 0) {
          const firstErrLine =
            stderrData
              .split('\n')
              .find((line) => line.includes('ERROR:'))
              ?.replace(/^.*ERROR:\s*/, '')
              ?.trim() ||
            stderrData.trim() ||
            `Exit code ${code}`;

          this.logger.error(`yt-dlp exited with code ${code}: ${stderrData}`);
          return reject(
            new BadRequestException(
              `Could not retrieve video information: ${firstErrLine}`,
            ),
          );
        }

        try {
          const info = JSON.parse(stdoutData.trim());

          if (info.is_live) {
            return reject(
              new BadRequestException(
                'Live streams cannot be downloaded as static videos.',
              ),
            );
          }

          const duration = Math.round(Number(info.duration) || 0);
          if (duration > this.maxDurationSeconds) {
            return reject(
              new BadRequestException(
                `Video exceeds the maximum allowed duration of ${Math.round(this.maxDurationSeconds / 60)} minutes.`,
              ),
            );
          }

          const durationFormatted = this.formatDuration(duration);
          const title = (info.title || 'YouTube Video').trim();
          const author = (info.uploader || info.channel || 'Unknown Channel').trim();
          const thumbnail =
            info.thumbnail ||
            `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

          resolve({
            id: videoId,
            title,
            duration,
            durationFormatted,
            author,
            thumbnail,
            views: info.view_count,
            format: this.defaultFormat,
            quality: this.defaultQuality,
            downloadUrl: `/api/video/download?v=${videoId}`,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.logger.error(`JSON parse error for video info: ${msg}`);
          reject(
            new InternalServerErrorException(
              'Failed to parse video metadata response.',
            ),
          );
        }
      });
    });
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
        const cachedTitle = await this.quickGetTitle(videoId, normalizedUrl);
        return {
          filePath: finalFilePath,
          title: cachedTitle,
          ext: targetExt,
          fileSize: stats.size,
        };
      }
    }

    const { args, expectedExt } = this.buildDownloadArgs(normalizedUrl, videoId);
    this.logger.log(`Executing yt-dlp for video: ${videoId}`);

    return new Promise<DownloadResult>((resolve, reject) => {
      const child = spawn('yt-dlp', args, { shell: false });
      let stderrData = '';

      if (registerAbort) {
        registerAbort(() => {
          this.logger.warn(`Client aborted download for ${videoId}. Terminating process.`);
          child.kill('SIGTERM');
          this.cleanupPartialFiles(videoId);
        });
      }

      child.stderr.on('data', (chunk) => {
        stderrData += chunk.toString();
      });

      child.on('error', (err) => {
        this.logger.error(`Child process error: ${err.message}`);
        reject(new InternalServerErrorException('Downloader failed to start.'));
      });

      child.on('close', async (code) => {
        if (code !== 0) {
          const firstErrLine =
            stderrData
              .split('\n')
              .find((line) => line.includes('ERROR:'))
              ?.replace(/^.*ERROR:\s*/, '')
              ?.trim() ||
            stderrData.trim() ||
            `Exit code ${code}`;

          this.logger.error(`Download process exited with code ${code}: ${stderrData}`);
          this.cleanupPartialFiles(videoId);
          return reject(
            new BadRequestException(
              `Download failed: ${firstErrLine}`,
            ),
          );
        }

        const candidateFile = path.join(this.storageDir, `${videoId}.${expectedExt}`);
        if (!fs.existsSync(candidateFile)) {
          this.logger.error(`Expected file not found at ${candidateFile}`);
          return reject(
            new InternalServerErrorException('Downloaded file was not created properly.'),
          );
        }

        const stats = fs.statSync(candidateFile);
        const title = await this.quickGetTitle(videoId, normalizedUrl);

        resolve({
          filePath: candidateFile,
          title,
          ext: expectedExt,
          fileSize: stats.size,
        });
      });
    });
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

  private async quickGetTitle(videoId: string, normalizedUrl: string): Promise<string> {
    try {
      return await new Promise<string>((resolve) => {
        const child = spawn(
          'yt-dlp',
          [...this.getBaseYtDlpArgs(), '--get-title', '--', normalizedUrl],
          { shell: false },
        );
        let out = '';
        child.stdout.on('data', (c) => (out += c.toString()));
        child.on('close', (c) => {
          if (c === 0 && out.trim()) {
            resolve(out.trim());
          } else {
            resolve(`YouTube_Video_${videoId}`);
          }
        });
        child.on('error', () => resolve(`YouTube_Video_${videoId}`));
      });
    } catch {
      return `YouTube_Video_${videoId}`;
    }
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
