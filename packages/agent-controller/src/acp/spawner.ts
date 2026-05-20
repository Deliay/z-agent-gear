import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { Writable, Readable } from 'node:stream';
import { existsSync, mkdirSync } from 'fs';

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
    console.log(`Starting ACP server ${cmd}`)
    mkdirSync(this.cwd, { recursive: true });
    this.process = spawn(cmd, this.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      console.error(`ACP stderr: ${data.toString()}`);
    });

    this.process.on('exit', (code, signal) => {
      console.log(`ACP process exited with code ${code} and signal ${signal}`);
      this.process = null;
      this.resolveClosed?.();
    });

    this.process.on('error', (error) => {
      console.error('ACP process error:', error);
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

  stop(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGKILL');
        }
      }, 5000);
    }
  }

  isRunning(): boolean {
    return this.process !== null;
  }

  private resolveCommand(): string {
    if (this.command.includes('/')) return this.command;
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
