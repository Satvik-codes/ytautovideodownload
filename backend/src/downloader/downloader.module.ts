import { Module } from '@nestjs/common';
import { DownloaderController } from './downloader.controller.js';
import { DownloaderService } from './downloader.service.js';
import { DownloaderCleanupService } from './downloader.cleanup.js';

@Module({
  controllers: [DownloaderController],
  providers: [DownloaderService, DownloaderCleanupService],
  exports: [DownloaderService],
})
export class DownloaderModule {}
