import {
  Controller,
  Get,
  Query,
  Res,
  BadRequestException,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import { DownloaderService } from './downloader.service.js';
import { sanitizeFilename } from './utils/filename-sanitizer.js';
import { VideoInfoResponse, BackendSettingsResponse } from './dto/video-info.dto.js';

@Controller('api/video')
export class DownloaderController {
  private readonly logger = new Logger(DownloaderController.name);

  constructor(private readonly downloaderService: DownloaderService) {}

  @Get('settings')
  getSettings(): BackendSettingsResponse {
    return this.downloaderService.getSettings();
  }

  @Get('info')
  async getVideoInfo(
    @Query('v') v?: string,
    @Query('url') url?: string,
  ): Promise<VideoInfoResponse> {
    const input = v || url;
    if (!input) {
      throw new BadRequestException('A video ID (?v=...) or URL (?url=...) is required.');
    }
    return this.downloaderService.getVideoInfo(input);
  }

  @Get('download')
  async downloadVideo(
    @Query('v') v?: string,
    @Query('url') url?: string,
    @Res() res?: Response,
  ): Promise<void> {
    const input = v || url;
    if (!input) {
      throw new BadRequestException('A video ID (?v=...) or URL (?url=...) is required.');
    }

    if (!res) {
      throw new BadRequestException('Response object is unavailable.');
    }

    let abortCallback: (() => void) | null = null;
    let isFinished = false;

    // Attach abort handler if client disconnects early
    res.on('close', () => {
      if (!isFinished && abortCallback) {
        this.logger.warn(`Client connection closed before download completed.`);
        abortCallback();
      }
    });

    try {
      const result = await this.downloaderService.downloadVideo(
        input,
        (abortFn) => {
          abortCallback = abortFn;
        },
      );

      const { asciiFallback, utf8Encoded } = sanitizeFilename(
        result.title,
        result.ext,
      );

      const mimeType =
        result.ext === 'mp3'
          ? 'audio/mpeg'
          : result.ext === 'm4a'
          ? 'audio/mp4'
          : 'video/mp4';

      res.setHeader(
        'Content-Disposition',
        `attachment; filename=${asciiFallback}; filename*=${utf8Encoded}`,
      );
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Length', result.fileSize);

      const fileStream = fs.createReadStream(result.filePath);

      fileStream.on('error', (err) => {
        this.logger.error(`Stream error: ${err.message}`);
        if (!res.headersSent) {
          res.status(500).json({ message: 'Error streaming file.' });
        }
      });

      fileStream.on('end', () => {
        isFinished = true;
      });

      fileStream.pipe(res);
    } catch (error) {
      isFinished = true;
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Download endpoint error: ${msg}`);
      if (!res.headersSent) {
        const statusCode =
          error instanceof HttpException ? error.getStatus() : 500;
        res.status(statusCode).json({
          statusCode,
          message: msg || 'Download error.',
        });
      }
    }
  }
}
