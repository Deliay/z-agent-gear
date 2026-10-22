import { spawn, execFileSync, execFile, type ChildProcess, type SpawnOptions } from 'child_process';
import { Writable, Readable } from 'node:stream';
import { existsSync, mkdirSync } from 'fs';
import { platform } from 'os';

export interface AcpProcessOptions {
  sessionId: string;
  cwd: string;
  command?: string;
  args?: string[];
}

export class AcpSpawner {
  private process: ChildProcess | null = null;
  private sessionId: string;
  private cwd: string;
  private command: string;
  private args: string[];
  private resolveClosed: (() => void) | null = null;
  private _closed: Promise<void>;

  constructor(options: AcpProcessOptions) {
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
    this.command = options.command ?? 'opencode';
    this.args = options.args ?? ['acp'];
    this._closed = new Promise((resolve) => { this.resolveClosed = resolve; });
  }

  start(): void {
    const cmd = this.resolveCommand();
    console.log(`Starting ACP server: session=${this.sessionId} cmd=${cmd} args=${JSON.stringify(this.args)} cwd=${this.cwd}`);
    mkdirSync(this.cwd, { recursive: true });

    const spawnOptions: SpawnOptions = {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    if (platform() === 'win32') {
      // .cmd/.bat cannot be spawned without a shell since Node 18.20.2/20.12.2
      // (CVE-2024-27980, spawn throws EINVAL); real executables spawn directly
      // (no shell) for reliable taskkill targeting.
      if (/\.(cmd|bat)$/i.test(cmd)) {
        spawnOptions.shell = true;
      }
    } else {
      spawnOptions.detached = true;
    }

    this.process = spawn(cmd, this.args, spawnOptions);

    this.process.stderr?.on('data', (data: Buffer) => {
      console.error(`ACP stderr (session=${this.sessionId}): ${data.toString()}`);
    });

    this.process.on('exit', (code, signal) => {
      console.log(`ACP process exited: session=${this.sessionId} code=${code} signal=${signal} cmd=${cmd} args=${JSON.stringify(this.args)}`);
      this.process = null;
      this.resolveClosed?.();
    });

    this.process.on('error', (error) => {
      console.error(`ACP process error (session=${this.sessionId}, cmd=${cmd}):`, error);
      // spawn 失败同样视为进程终止：必须 resolve closed，让 bridge 收敛 pending，避免 65s 迟到 timeout
      this.process = null;
      this.resolveClosed?.();
    });
  }

  get stdin(): WritableStream {
    if (!this.process?.stdin) throw new Error('ACP process not running');
    return Writable.toWeb(this.process.stdin) as WritableStream;
  }

  get stdout(): ReadableStream<Uint8Array> {
    if (!this.process?.stdout) throw new Error('ACP process not running');
    return Readable.toWeb(this.process.stdout) as ReadableStream<Uint8Array>;
  }

  get closed(): Promise<void> {
    return this._closed;
  }

  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  stop(): void {
    if (!this.process) return;
    const pid = this.process.pid;
    if (!pid) {
      this.process.kill();
      return;
    }
    if (platform() === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], (err) => {
        if (err) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* process already gone */ }
        }
      });
    } else {
      process.kill(-pid, 'SIGTERM');
      setTimeout(() => {
        // Only send SIGKILL if process is still running
        if (this.process && this.process.pid === pid) {
          try { process.kill(-pid, 'SIGKILL'); } catch { /* process already gone */ }
        }
      }, 5000);
    }
  }

  isRunning(): boolean {
    return this.process !== null;
  }

  private resolveCommand(): string {
    if (this.command.includes('\\') || this.command.includes('/')) return this.command;
    return platform() === 'win32' ? this.resolveWindowsCommand() : this.resolveUnixCommand();
  }

  private resolveWindowsCommand(): string {
    try {
      const result = execFileSync('where', [this.command], { encoding: 'utf8', timeout: 1000 });
      const firstMatch = result.trim().split('\n')[0]?.trim();
      if (firstMatch) return firstMatch;
    } catch { /* not found via where */ }
    const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';');
    for (const ext of pathext) {
      const candidate = this.command + ext.toLowerCase();
      if (existsSync(candidate)) return candidate;
    }
    return this.command;
  }

  private resolveUnixCommand(): string {
    const candidates = [this.command, `/usr/bin/${this.command}`, `/usr/local/bin/${this.command}`];
    for (const cmd of candidates) {
      try {
        const result = execFileSync('which', [cmd], { encoding: 'utf8', timeout: 1000 });
        if (result.trim()) return result.trim();
      } catch { /* try next */ }
      if (existsSync(cmd)) return cmd;
    }
    return this.command;
  }
}
