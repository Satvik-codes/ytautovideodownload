import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WarpService } from './warp.service.js';
import { DownloaderService } from './downloader.service.js';

const config = (env: Record<string, string>) =>
  ({ get: (key: string) => env[key] }) as unknown as ConfigService;

describe('WarpService.rotate', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reconnects with the same identity instead of deleting it and re-registering', async () => {
    const warp = new WarpService(config({ WARP_ENABLED: 'true', WARP_ROTATE_COOLDOWN_SECONDS: '0' }));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warp-test-'));
    dirs.push(workDir);
    (warp as any).workDir = workDir;
    const account = path.join(workDir, 'wgcf-account.toml');
    fs.writeFileSync(account, 'device_id = "kept"');

    const start = vi.spyOn(warp as any, 'start').mockImplementation(async () => {
      (warp as any).ready = true;
    });

    expect(await warp.rotate()).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(account, 'utf-8')).toBe('device_id = "kept"');
    expect((await warp.getStatus()).rotations).toBe(1);
  });
});

describe('DownloaderService with the WARP tunnel down', () => {
  it('fails YouTube requests with a retryable 503 instead of going direct', async () => {
    const warp = {
      isEnabled: () => true,
      isReady: () => false,
      ensureReady: vi.fn(async () => false),
      getProxyUrl: () => null,
    };
    const service = new DownloaderService(
      config({ DOWNLOAD_STORAGE_DIR: path.join(os.tmpdir(), 'youdown-test-downloads') }),
      warp as unknown as WarpService,
    );
    const runYtDlp = vi.spyOn(service as any, 'runYtDlp');

    const error = await service.getVideoInfo('dQw4w9WgXcQ').catch((e) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.getResponse()).toMatchObject({ code: 'YT_BLOCKED', statusCode: 503 });
    expect(warp.ensureReady).toHaveBeenCalled();
    expect(runYtDlp).not.toHaveBeenCalled();
  });

  it('still goes through an explicitly configured proxy', async () => {
    const warp = { isEnabled: () => true, isReady: () => false, ensureReady: vi.fn(), getProxyUrl: () => null };
    const service = new DownloaderService(
      config({
        DOWNLOAD_STORAGE_DIR: path.join(os.tmpdir(), 'youdown-test-downloads'),
        YOUTUBE_PROXY: 'socks5://127.0.0.1:9',
      }),
      warp as unknown as WarpService,
    );
    const runYtDlp = vi
      .spyOn(service as any, 'runYtDlp')
      .mockResolvedValue({ code: 1, stdout: '', stderr: 'ERROR: [youtube] x: Video unavailable' });

    await service.getVideoInfo('dQw4w9WgXcQ').catch(() => undefined);
    expect(warp.ensureReady).not.toHaveBeenCalled();
    expect(runYtDlp).toHaveBeenCalled();
  });
});
