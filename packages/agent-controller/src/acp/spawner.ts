import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export interface AcpProcessOptions {
  sessionId: string;
  cwd: string;
}

export class AcpSpawner extends EventEmitter {
  private process: ChildProcess | null = null;
  private sessionId: string;
  private cwd: string;

  constructor(options: AcpProcessOptions) {
    super();
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
  }

  start(): void {
    this.process = spawn('opencode', ['acp'], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(line => line.trim());
      for (const line of lines) {
        try {
          const message = JSON.parse(line);
          this.emit('message', message);
        } catch (error) {
          console.error('Failed to parse ACP message:', error);
        }
      }
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      console.error(`ACP stderr: ${data.toString()}`);
    });

    this.process.on('exit', (code, signal) => {
      console.log(`ACP process exited with code ${code} and signal ${signal}`);
      this.emit('exit', { code, signal });
      this.process = null;
    });

    this.process.on('error', (error) => {
      console.error('ACP process error:', error);
      this.emit('error', error);
    });
  }

  send(message: Record<string, unknown>): void {
    if (!this.process?.stdin) {
      throw new Error('ACP process not running');
    }
    this.process.stdin.write(JSON.stringify(message) + '\n');
  }

  stop(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      
      // Force kill after 5 seconds if process hasn't exited
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

  getSessionId(): string {
    return this.sessionId;
  }
}