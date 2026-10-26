import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class DownloaderCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DownloaderCleanupService.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly storageDir: string;
  private readonly retentionMs: number;

  constructor(private readonly configService: ConfigService) {
    const configuredStorage =
      this.configService.get<string>('DOWNLOAD_STORAGE_DIR') || './downloads';
    this.storageDir = path.resolve(process.cwd(), configuredStorage);

    const retentionMinutes = parseInt(
      this.configService.get<string>('CACHE_RETENTION_MINUTES') || '30',
      10,
    );
    this.retentionMs = retentionMinutes * 60 * 1000;
  }

  onModuleInit() {
    this.runCleanup();
    this.timer = setInterval(() => {
      this.runCleanup();
    }, 10 * 60 * 1000);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  runCleanup() {
    if (!fs.existsSync(this.storageDir)) return;

    try {
      const now = Date.now();
      const files = fs.readdirSync(this.storageDir);

      for (const file of files) {
        const filePath = path.join(this.storageDir, file);
        try {
          const stats = fs.statSync(filePath);
          if (now - stats.mtimeMs > this.retentionMs) {
            fs.unlinkSync(filePath);
            this.logger.log(`Purged expired cached download: ${file}`);
          }
        } catch (fileErr) {
          const msg = fileErr instanceof Error ? fileErr.message : String(fileErr);
          this.logger.warn(`Failed to inspect/unlink file ${file}: ${msg}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error during download cleanup cycle: ${msg}`);
    }
  }
}
