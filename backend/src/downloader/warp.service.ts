import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
  decodeProfileEnv,
  parseWarpIpFamily,
  toIpv4OnlyProfile,
  WarpIpFamily,
} from './utils/warp-profile.js';

// Reconnect backoff while the tunnel is down: 30 s doubling to 5 min, forever
const RECONNECT_INITIAL_MS = 30_000;
const RECONNECT_MAX_MS = 5 * 60_000;

export interface WarpStatus {
  enabled: boolean;
  ready: boolean;
  proxy: string | null;
  ipFamily: WarpIpFamily;
  egressIp: string | null;
  warp: string | null;
  colo: string | null;
  rotations: number;
  /** env: fixed identity from WARP_PROFILE_B64; registered: wgcf account made at runtime */
  identity: 'env' | 'registered';
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
  // IPv4 by default: YouTube flags WARP's IPv6 egress ranges as bots
  private readonly ipFamily: WarpIpFamily;
  // A fixed identity survives restarts; without it every cold start (Render
  // wipes /tmp) registers a new account, and Cloudflare rate-limits those
  private readonly envProfile: string | null;
  private starting: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = RECONNECT_INITIAL_MS;
  private destroyed = false;
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
    this.ipFamily = parseWarpIpFamily(this.configService.get<string>('WARP_IP_FAMILY'));
    this.envProfile = this.configService.get<string>('WARP_PROFILE_B64')?.trim() || null;
  }

  onModuleInit() {
    if (!this.enabled) return;
    if (!this.envProfile) {
      this.logger.warn(
        'WARP_PROFILE_B64 is not set: a WARP account is registered at runtime, again after every restart. ' +
          'Hosts with ephemeral disks and shared IPs (Render) soon hit Cloudflare\'s 429 on registration.',
      );
    }
    // Start in the background so the HTTP server binds immediately
    void this.connect();
  }

  onModuleDestroy() {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopProxy();
  }

  /** Starts the tunnel (one attempt at a time); on failure schedules a retry with backoff. */
  private async connect(): Promise<void> {
    if (!this.starting) {
      this.starting = this.start()
        .then(() => {
          this.reconnectDelayMs = RECONNECT_INITIAL_MS;
        })
        .catch((err) => {
          this.lastError = err instanceof Error ? err.message : String(err);
          this.logger.error(`WARP start failed: ${this.lastError}`);
          this.scheduleReconnect();
        })
        .finally(() => {
          this.starting = null;
        });
    }
    return this.starting;
  }

  private scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(delay * 2, RECONNECT_MAX_MS);
    this.logger.warn(`WARP retry in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.ready) void this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  /**
   * Waits up to timeoutMs for the tunnel, starting it if it's down and no
   * attempt is running. Lets a request wait out a reconnect instead of
   * going direct from the host's (bot-walled) IP.
   */
  async ensureReady(timeoutMs: number): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.ready) return true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await Promise.race([this.connect(), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
    return this.ready;
  }

  getProxyUrl(): string | null {
    return this.ready ? `socks5://127.0.0.1:${this.port}` : null;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Reconnects the tunnel with the same identity; a new WireGuard session can
   * land on a different (shared) IPv4 egress. The identity is never deleted:
   * registering replacements is what got Cloudflare to answer 429. Concurrent
   * callers share one rotation; calls inside the cooldown window are ignored.
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
      this.logger.warn('Reconnecting WARP...');
      this.stopProxy();
      await this.connect();
      if (this.ready) this.rotations++;
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
      ipFamily: this.ipFamily,
      egressIp: null,
      warp: null,
      colo: null,
      rotations: this.rotations,
      identity: this.envProfile ? 'env' : 'registered',
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
    this.stopProxy();
    fs.mkdirSync(this.workDir, { recursive: true });

    const accountFile = path.join(this.workDir, 'wgcf-account.toml');
    const profileFile = path.join(this.workDir, 'wgcf-profile.conf');
    if (this.envProfile) {
      fs.writeFileSync(profileFile, decodeProfileEnv(this.envProfile), { encoding: 'utf-8', mode: 0o600 });
    } else {
      if (!fs.existsSync(accountFile)) {
        await this.run('wgcf', ['register', '--accept-tos']);
      }
      if (!fs.existsSync(profileFile)) {
        await this.run('wgcf', ['generate']);
      }
    }

    // The wgcf profile stays as generated; wireproxy reads a rewritten copy
    let tunnelProfile = profileFile;
    if (this.ipFamily === 'ipv4') {
      tunnelProfile = path.join(this.workDir, 'wgcf-profile-ipv4.conf');
      fs.writeFileSync(tunnelProfile, toIpv4OnlyProfile(fs.readFileSync(profileFile, 'utf-8')), 'utf-8');
    }

    const configFile = path.join(this.workDir, 'wireproxy.conf');
    fs.writeFileSync(
      configFile,
      `WGConfig = ${tunnelProfile}\n\n[Socks5]\nBindAddress = 127.0.0.1:${this.port}\n`,
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
        this.scheduleReconnect();
      }
    });
    this.wireproxy = child;

    // wireproxy opens its port before the WireGuard handshake, so only mark the
    // tunnel ready once traffic actually flows through Cloudflare
    let trace: Record<string, string> | null;
    try {
      await this.waitForPort(15000);
      trace = await this.fetchTrace();
      if (!trace || trace.warp !== 'on') {
        throw new Error(`WARP tunnel not passing traffic (trace warp=${trace?.warp ?? 'unreachable'})`);
      }
    } catch (err) {
      // Don't leave a half-started wireproxy holding the port for the next attempt
      this.stopProxy();
      throw err;
    }
    this.ready = true;
    this.lastError = null;
    this.logger.log(`WARP ready on socks5://127.0.0.1:${this.port} (${this.ipFamily}, egress ${trace.ip}, ${trace.colo})`);
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
