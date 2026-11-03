import { spawn, execFileSync, execFile, type ChildProcess, type SpawnOptions } from 'child_process';
import { Writable, Readable } from 'node:stream';
import { existsSync, mkdirSync } from 'fs';
import { platform } from 'os';
import { logger as rootLogger, type ObservationLogger } from '../observability/logger.js';
import { collectSecretValues, redactSecrets, REDACTED } from '../workload-executor.js';

/** B4：ACP 子进程 stderr 单条入日志前的截断上限（脱敏后截断，原文长段不进日志）。 */
export const STDERR_LOG_MAX_CHARS = 500;

/**
 * B4 敏感键值对（契约 §6.1 脱敏名单：token/key/password/secret 等 + authorization/cookie）。
 * 覆盖 `键 = 值` / `键: 值` / JSON `"键":"值"` 形态，仅替换值、保留键名便于排障。
 */
const SENSITIVE_KV_RE =
  /\b(password[_-]?hash|passwords?|passwd|passphrase|pwd|model[_-]?api[_-]?key|api[_-]?key|private[_-]?key|client[_-]?secret|secrets?|access[_-]?token|refresh[_-]?token|id[_-]?token|tokens?|authorization|cookie|key)\b(["']?\s*[=:]\s*)(?:Bearer\s+|Basic\s+)?(?:"[^"]*"|'[^']*'|[^\s"'`,;)\]}]+)/gi;

/** B4 命令行 flag 形态（`--token <值>` / `--api-key=<值>`）。 */
const SENSITIVE_FLAG_RE =
  /(--?(?:[A-Za-z0-9]+[-_])*(?:tokens?|keys?|secrets?|passwords?|passwd|credentials?))\b(["']?\s*[= ]\s*)(?:"[^"]*"|'[^']*'|[^\s"'`,;)\]}]+)/gi;

/** B4 形似凭据的串（GitHub/OpenAI/Slack/AWS/JWT/Bearer/zag key 等已知形态）。 */
const CREDENTIAL_LIKE_RES: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\bzag_(?:sk|k)_[A-Za-z0-9_-]{6,}/g,
];

/**
 * B4：ACP 子进程 stderr 入日志前的脱敏（不得原文入 info/error）。
 *
 * 三层防护（先脱敏、后截断见调用方）：
 * 1. `redactSecrets` 复用 workload-executor 工具：`ZAG_*` secret 精确值替换为 `***`；
 * 2. 契约 §6.1 名单键值对（token/key/password/secret 等）只留键名；
 * 3. 形似凭据的串（token 前缀 / JWT / Bearer / zag key）整体替换。
 */
export function redactStderrText(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = redactSecrets(text, collectSecretValues(env));
  out = out.replace(SENSITIVE_KV_RE, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`);
  out = out.replace(SENSITIVE_FLAG_RE, (_m, flag: string, sep: string) => `${flag}${sep}${REDACTED}`);
  for (const re of CREDENTIAL_LIKE_RES) out = out.replace(re, REDACTED);
  return out;
}

export interface AcpProcessOptions {
  sessionId: string;
  cwd: string;
  command?: string;
  args?: string[];
  /** 注入 logger（测试用）；缺省进程级单例，`component: 'acp-spawner'` + `sessionId` 字段化。 */
  logger?: ObservationLogger;
}

export class AcpSpawner {
  private process: ChildProcess | null = null;
  private sessionId: string;
  private cwd: string;
  private command: string;
  private args: string[];
  private log: ObservationLogger;
  private resolveClosed: (() => void) | null = null;
  private _closed: Promise<void>;

  constructor(options: AcpProcessOptions) {
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
    this.command = options.command ?? 'opencode';
    this.args = options.args ?? ['acp'];
    this.log = options.logger ?? rootLogger.child({ component: 'acp-spawner', sessionId: options.sessionId });
    this._closed = new Promise((resolve) => { this.resolveClosed = resolve; });
  }

  start(): void {
    const cmd = this.resolveCommand();
    this.log.info(
      { event: 'acp_spawn', command: cmd, args: this.args, cwd: this.cwd },
      'starting ACP server',
    );
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
      // B4：子进程 stderr 不得原文入 info/error —— 先脱敏（secret 值 + 键值对 + 形似凭据串）再截断。
      const safe = redactStderrText(data.toString());
      const truncated = safe.length > STDERR_LOG_MAX_CHARS;
      this.log.error(
        {
          event: 'acp_stderr',
          stderr: truncated ? safe.slice(0, STDERR_LOG_MAX_CHARS) : safe,
          ...(truncated ? { stderrTruncated: true } : {}),
        },
        'acp server stderr',
      );
    });

    this.process.on('exit', (code, signal) => {
      this.log.info(
        { event: 'acp_exit', exitCode: code, signal, command: cmd, args: this.args },
        'acp process exited',
      );
      this.process = null;
      this.resolveClosed?.();
    });

    this.process.on('error', (error) => {
      this.log.error({ event: 'acp_process_error', command: cmd, err: error }, 'acp process error');
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
