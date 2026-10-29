import { Module } from '@nestjs/common';
import { DownloaderController } from './downloader.controller.js';
import { DownloaderService } from './downloader.service.js';
import { DownloaderCleanupService } from './downloader.cleanup.js';
import { HealthController } from './health.controller.js';
import { WarpService } from './warp.service.js';

@Module({
  controllers: [DownloaderController, HealthController],
  providers: [DownloaderService, DownloaderCleanupService, WarpService],
  exports: [DownloaderService],
})
export class DownloaderModule {}
