import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

export interface WarpStatus {
  enabled: boolean;
  ready: boolean;
  proxy: string | null;
  egressIp: string | null;
  warp: string | null;
  colo: string | null;
  rotations: number;
  lastError: string | null;
}

/**
 * Runs Cloudflare WARP in userspace (wgcf + wireproxy) and exposes it as a
 * local SOCKS5 proxy, so yt-dlp reaches YouTube from Cloudflare's IPs instead
 * of the host's datacenter IP. No root or TUN device needed.
 */
@Injectable()
export class WarpService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WarpService.name);
  private readonly enabled: boolean;
  private readonly port: number;
  private readonly workDir: string;
  private readonly rotateCooldownMs: number;
  private wireproxy: ChildProcess | null = null;
  private ready = false;
  private rotations = 0;
  private lastRotationAt = 0;
  private lastError: string | null = null;
  private rotating: Promise<void> | null = null;

  constructor(private readonly configService: ConfigService) {
    this.enabled =
      (this.configService.get<string>('WARP_ENABLED') || 'false').toLowerCase() === 'true';
    this.port = parseInt(this.configService.get<string>('WARP_SOCKS_PORT') || '40000', 10);
    this.workDir = path.join(os.tmpdir(), 'warp');
    this.rotateCooldownMs =
      parseInt(this.configService.get<string>('WARP_ROTATE_COOLDOWN_SECONDS') || '300', 10) *
      1000;
  }

  onModuleInit() {
    if (!this.enabled) return;
    // Start in the background so the HTTP server binds immediately; until the
    // tunnel is up, yt-dlp connects directly
    void this.startWithRetries(3, 30000);
  }

  private async startWithRetries(attempts: number, delayMs: number) {
    for (let i = 1; i <= attempts; i++) {
      try {
        await this.start();
        return;
      } catch (err) {
        // Keep the app running without WARP rather than failing the deploy
        this.lastError = err instanceof Error ? err.message : String(err);
        this.logger.error(`WARP start attempt ${i}/${attempts} failed: ${this.lastError}`);
        if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  onModuleDestroy() {
    this.stopProxy();
  }

  getProxyUrl(): string | null {
    return this.ready ? `socks5://127.0.0.1:${this.port}` : null;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Registers a fresh WARP identity and restarts the proxy, usually giving a
   * new egress IP. Concurrent callers share one rotation; calls inside the
   * cooldown window are ignored.
   */
  async rotate(): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.rotating) {
      await this.rotating;
      return true;
    }
    if (Date.now() - this.lastRotationAt < this.rotateCooldownMs) {
      this.logger.warn('WARP rotation skipped (cooldown active)');
      return false;
    }

    this.lastRotationAt = Date.now();
    this.rotating = (async () => {
      this.logger.warn('Rotating WARP identity...');
      this.stopProxy();
      fs.rmSync(this.workDir, { recursive: true, force: true });
      try {
        await this.start();
        this.rotations++;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.logger.error(`WARP rotation failed: ${this.lastError}`);
      }
    })();

    try {
      await this.rotating;
    } finally {
      this.rotating = null;
    }
    return this.ready;
  }

  async getStatus(): Promise<WarpStatus> {
    const status: WarpStatus = {
      enabled: this.enabled,
      ready: this.ready,
      proxy: this.getProxyUrl(),
      egressIp: null,
      warp: null,
      colo: null,
      rotations: this.rotations,
      lastError: this.lastError,
    };
    if (!this.ready) return status;

    const trace = await this.fetchTrace();
    if (trace) {
      status.egressIp = trace.ip ?? null;
      status.warp = trace.warp ?? null;
      status.colo = trace.colo ?? null;
    }
    return status;
  }

  private async start(): Promise<void> {
    this.ready = false;
    fs.mkdirSync(this.workDir, { recursive: true });

    const accountFile = path.join(this.workDir, 'wgcf-account.toml');
    const profileFile = path.join(this.workDir, 'wgcf-profile.conf');
    if (!fs.existsSync(accountFile)) {
      await this.run('wgcf', ['register', '--accept-tos']);
    }
    if (!fs.existsSync(profileFile)) {
      await this.run('wgcf', ['generate']);
    }

    const configFile = path.join(this.workDir, 'wireproxy.conf');
    fs.writeFileSync(
      configFile,
      `WGConfig = ${profileFile}\n\n[Socks5]\nBindAddress = 127.0.0.1:${this.port}\n`,
      'utf-8',
    );

    const child = spawn('wireproxy', ['-s', '-c', configFile], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (chunk) => {
      const line = chunk.toString().trim();
      if (line) this.logger.warn(`wireproxy: ${line}`);
    });
    child.on('exit', (code) => {
      if (this.wireproxy === child) {
        this.ready = false;
        this.wireproxy = null;
        this.logger.error(`wireproxy exited with code ${code}`);
      }
    });
    this.wireproxy = child;

    await this.waitForPort(15000);

    // wireproxy opens its port before the WireGuard handshake, so only mark the
    // tunnel ready once traffic actually flows through Cloudflare
    const trace = await this.fetchTrace();
    if (!trace || trace.warp !== 'on') {
      this.stopProxy();
      throw new Error(`WARP tunnel not passing traffic (trace warp=${trace?.warp ?? 'unreachable'})`);
    }
    this.ready = true;
    this.lastError = null;
    this.logger.log(`WARP ready on socks5://127.0.0.1:${this.port} (egress ${trace.ip}, ${trace.colo})`);
  }

  private stopProxy() {
    this.ready = false;
    if (this.wireproxy) {
      const child = this.wireproxy;
      this.wireproxy = null;
      child.kill('SIGTERM');
    }
  }

  private run(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: this.workDir, shell: false });
      let stderr = '';
      child.stderr.on('data', (c) => (stderr += c.toString()));
      child.on('error', (err) => reject(new Error(`${cmd} failed to start: ${err.message}`)));
      child.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim()}`)),
      );
    });
  }

  private waitForPort(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const attempt = () => {
        const socket = net.connect(this.port, '127.0.0.1');
        socket.once('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.once('error', () => {
          socket.destroy();
          if (Date.now() > deadline) {
            reject(new Error(`wireproxy did not open port ${this.port}`));
          } else {
            setTimeout(attempt, 300);
          }
        });
      };
      attempt();
    });
  }

  /** Reads Cloudflare's trace endpoint through the tunnel (warp=on, egress ip, colo). */
  private fetchTrace(): Promise<Record<string, string> | null> {
    return new Promise((resolve) => {
      const child = spawn(
        'curl',
        [
          '-s',
          '--max-time',
          '10',
          '--socks5-hostname',
          `127.0.0.1:${this.port}`,
          'https://www.cloudflare.com/cdn-cgi/trace',
        ],
        { shell: false },
      );
      let out = '';
      child.stdout.on('data', (c) => (out += c.toString()));
      child.on('error', () => resolve(null));
      child.on('close', (code) => {
        if (code !== 0) return resolve(null);
        const fields: Record<string, string> = {};
        for (const line of out.split('\n')) {
          const idx = line.indexOf('=');
          if (idx > 0) fields[line.slice(0, idx)] = line.slice(idx + 1).trim();
        }
        resolve(fields);
      });
    });
  }
}
