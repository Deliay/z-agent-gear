import { spawn } from 'node:child_process';

/** 设备码有效期缺省值（实机 `Code expires in 1800s.`）。 */
export const DEFAULT_KIMI_EXPIRES_IN_SECONDS = 1800;
/** 登录等待上限：默认 30 分钟（与设备码一致），可 env 覆盖。 */
export const DEFAULT_KIMI_LOGIN_WAIT_MS = 1_800_000;
/** 进程内登录缓存 TTL（5 分钟）。 */
export const DEFAULT_KIMI_AUTH_CACHE_TTL_MS = 300_000;
const MAX_URL_LENGTH = 2048;
const MAX_USER_CODE_LENGTH = 64;
const MAX_LINE_BYTES = 8 * 1024;
const MAX_ERROR_SUMMARY = 200;

export type KimiLoginOutcome =
  | { state: 'logged-in'; account?: string }
  | { state: 'device-flow'; url: string; userCode: string; expiresInSeconds: number }
  | { state: 'failed'; reason: 'cancelled' | 'timeout' | 'error'; error?: string };

/** `run()` 的终态（device-flow 只经 onDeviceFlow 上抛）。 */
export type KimiLoginTerminal = Exclude<KimiLoginOutcome, { state: 'device-flow' }>;

export type KimiLoginLine =
  | { kind: 'logged-in'; account?: string }
  | { kind: 'device-url'; url: string }
  | { kind: 'user-code'; userCode: string }
  | { kind: 'expires-in'; expiresInSeconds: number }
  | { kind: 'waiting' }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string };

/** 是否为可下发给前端的 http(s) 链接（不可信内容不入库）。 */
export function isSafeLoginUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isSafeUserCode(value: string): boolean {
  return /^[A-Za-z0-9-]{1,64}$/.test(value) && value.length <= MAX_USER_CODE_LENGTH;
}

/** 脱敏摘要：去控制字符/压缩空白/截断 200（原始输出不进日志与事件）。 */
export function sanitizeErrorSummary(text: string): string {
  const cleaned = text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > MAX_ERROR_SUMMARY ? cleaned.slice(0, MAX_ERROR_SUMMARY) : cleaned;
}

/** 逐行解析（stdout+stderr 合并口径；`\r\n` 由调用方归一）。 */
export function parseKimiLoginLine(rawLine: string): KimiLoginLine | null {
  const line = rawLine.replace(/\r$/, '').trim();
  if (line.length === 0) return null;
  const loggedIn = /^Logged in to (.+?)\.?$/.exec(line);
  if (loggedIn) return { kind: 'logged-in', account: loggedIn[1].trim() };
  const deviceUrl = /^Opening browser for Kimi device login: (\S+)$/.exec(line);
  if (deviceUrl) return { kind: 'device-url', url: deviceUrl[1] };
  const userCode = /enter code:\s*([A-Za-z0-9-]+)/.exec(line);
  if (userCode) return { kind: 'user-code', userCode: userCode[1] };
  const expires = /^Code expires in (\d+)s\.$/.exec(line);
  if (expires) return { kind: 'expires-in', expiresInSeconds: Number(expires[1]) };
  if (/^Waiting for authorization to complete/.test(line)) return { kind: 'waiting' };
  if (/^Login cancelled/.test(line)) return { kind: 'cancelled' };
  const failed = /^Login failed:?\s*(.*)$/.exec(line);
  if (failed) return { kind: 'error', message: sanitizeErrorSummary(failed[1] || line) };
  return null;
}

function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function resolveKimiLoginWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntFromEnv(env.KIMI_LOGIN_WAIT_MS, DEFAULT_KIMI_LOGIN_WAIT_MS);
}

export function resolveKimiAuthCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntFromEnv(env.KIMI_AUTH_CACHE_TTL_MS, DEFAULT_KIMI_AUTH_CACHE_TTL_MS);
}

export interface KimiExitClassification {
  code: number | null;
  signal?: NodeJS.Signals | null;
  /** 我方 cancel() 设置的标志（不依赖文案）。 */
  cancelled?: boolean;
  /** 解析到 `Login cancelled*` 文案。 */
  cancelMessage?: boolean;
  /** `Login failed: <msg>` 摘要（已脱敏、≤200）。 */
  errorMessage?: string;
  account?: string;
  /** 设备码到期时间戳（毫秒）；缺省视为未到期。 */
  expiresAt?: number;
  now?: number;
}

/**
 * 判定 `kimi login` 终态（§3 A5）：
 * exit 0 → logged-in；cancel 标志/文案 → cancelled；已过 expiresAt → timeout；其余 → error。
 */
export function classifyExit(input: KimiExitClassification): KimiLoginTerminal {
  const now = input.now ?? Date.now();
  if (input.cancelled) return { state: 'failed', reason: 'cancelled' };
  if (input.code === 0) {
    return input.account ? { state: 'logged-in', account: input.account } : { state: 'logged-in' };
  }
  if (input.cancelMessage) return { state: 'failed', reason: 'cancelled' };
  if (typeof input.expiresAt === 'number' && now >= input.expiresAt) {
    return { state: 'failed', reason: 'timeout' };
  }
  const summary = input.errorMessage
    ? input.errorMessage
    : `kimi login exited with ${input.code === null ? input.signal ?? 'unknown signal' : `code ${input.code}`}`;
  return { state: 'failed', reason: 'error', error: sanitizeErrorSummary(summary) };
}

export interface KimiLoginHandlers {
  /** 设备码首次命中时上抛一次（并发使用动作共用一个登录流程）。 */
  onDeviceFlow?: (payload: { url: string; userCode: string; expiresInSeconds: number }) => void;
  /** 可观测：只上报匹配到的行类型，不含原文。 */
  onLineMatched?: (kind: KimiLoginLine['kind']) => void;
}

interface ChildLike {
  stdout?: { on: (event: 'data', cb: (chunk: Buffer | string) => void) => unknown } | null;
  stderr?: { on: (event: 'data', cb: (chunk: Buffer | string) => void) => unknown } | null;
  kill: (signal?: NodeJS.Signals) => unknown;
  on: (event: 'exit' | 'close' | 'error', cb: (...args: any[]) => void) => unknown;
}

export type KimiSpawnFn = (
  command: string,
  args: string[],
  options: { stdio: ['ignore', 'pipe', 'pipe']; env: NodeJS.ProcessEnv },
) => ChildLike;

export interface KimiLoginFlowOptions {
  command?: string;
  args?: string[];
  waitMs?: number;
  env?: NodeJS.ProcessEnv;
  spawnFn?: KimiSpawnFn;
  now?: () => number;
}

/** `kimi login` 单次子进程（stdio 无 TTY、不传 `--region`、输出按行合并解析）。 */
export class KimiLoginFlow {
  private readonly command: string;
  private readonly args: string[];
  private readonly waitMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnFn: KimiSpawnFn;
  private readonly now: () => number;

  private child: ChildLike | null = null;
  private settled = false;
  private cancelled = false;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: KimiLoginFlowOptions = {}) {
    this.command = options.command ?? 'kimi';
    this.args = options.args ?? ['login'];
    this.waitMs = options.waitMs ?? resolveKimiLoginWaitMs(options.env);
    this.env = options.env ?? process.env;
    this.spawnFn = options.spawnFn ?? (spawn as unknown as KimiSpawnFn);
    this.now = options.now ?? Date.now;
  }

  /** 终止进行中的 `kimi login`（SIGTERM；reason 由 cancelled 标志定，不依赖文案）。 */
  cancel(): void {
    if (this.settled) return;
    this.cancelled = true;
    this.killChild('SIGTERM');
  }

  private killChild(signal: NodeJS.Signals): void {
    try {
      this.child?.kill(signal);
    } catch {
      /* 进程可能已退出 */
    }
  }

  private clearKillTimer(): void {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }

  run(handlers: KimiLoginHandlers = {}): Promise<KimiLoginTerminal> {
    return new Promise((resolve) => {
      let url: string | undefined;
      let userCode: string | undefined;
      let expiresInSeconds = DEFAULT_KIMI_EXPIRES_IN_SECONDS;
      let account: string | undefined;
      let cancelMessage = false;
      let errorMessage: string | undefined;
      let expiresAt: number | undefined;
      let emitted = false;
      const buffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };

      const finish = (outcome: KimiLoginTerminal): void => {
        if (this.settled) return;
        this.settled = true;
        this.clearKillTimer();
        resolve(outcome);
      };
      const fail = (error: string): void => {
        this.killChild('SIGTERM');
        finish({ state: 'failed', reason: 'error', error: sanitizeErrorSummary(error) });
      };

      const maybeEmitDeviceFlow = (): void => {
        if (emitted || !url || !userCode) return;
        emitted = true;
        expiresAt = this.now() + expiresInSeconds * 1000;
        handlers.onDeviceFlow?.({ url, userCode, expiresInSeconds });
      };

      const handleLine = (raw: string): void => {
        const parsed = parseKimiLoginLine(raw);
        if (!parsed) return;
        handlers.onLineMatched?.(parsed.kind);
        switch (parsed.kind) {
          case 'logged-in':
            account = parsed.account;
            return;
          case 'device-url':
            if (!isSafeLoginUrl(parsed.url)) {
              fail('kimi login device URL rejected');
              return;
            }
            url = parsed.url;
            break;
          case 'user-code':
            if (!isSafeUserCode(parsed.userCode)) {
              fail('kimi login user code rejected');
              return;
            }
            userCode = parsed.userCode;
            break;
          case 'expires-in':
            expiresInSeconds = Math.min(3600, Math.max(60, parsed.expiresInSeconds));
            break;
          case 'cancelled':
            cancelMessage = true;
            return;
          case 'error':
            errorMessage = parsed.message;
            return;
          default:
            return;
        }
        if (emitted && url && userCode) {
          expiresAt = this.now() + expiresInSeconds * 1000;
        } else {
          maybeEmitDeviceFlow();
        }
      };

      const pushChunk = (stream: 'stdout' | 'stderr', chunk: Buffer | string): void => {
        let buffer = buffers[stream] + chunk.toString();
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          handleLine(line);
          if (this.settled) return;
          index = buffer.indexOf('\n');
        }
        // 行缓冲上限 8 KiB：无换行的超长输出直接丢弃，避免无界增长。
        buffers[stream] = buffer.length > MAX_LINE_BYTES ? '' : buffer;
      };

      const flushBuffers = (): void => {
        for (const stream of ['stdout', 'stderr'] as const) {
          const leftover = buffers[stream];
          buffers[stream] = '';
          if (leftover.trim().length > 0) handleLine(leftover);
        }
      };

      let child: ChildLike;
      try {
        child = this.spawnFn(this.command, this.args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: this.env,
        });
      } catch (error) {
        fail((error as Error).message);
        return;
      }
      this.child = child;

      child.stdout?.on('data', (chunk) => pushChunk('stdout', chunk));
      child.stderr?.on('data', (chunk) => pushChunk('stderr', chunk));
      child.on('error', (error: Error) => fail(error?.message ?? String(error)));
      child.on('exit', (code: number | null, signal?: NodeJS.Signals | null) => {
        flushBuffers();
        finish(
          classifyExit({
            code,
            signal: signal ?? null,
            cancelled: this.cancelled,
            cancelMessage,
            errorMessage,
            ...(account ? { account } : {}),
            ...(expiresAt ? { expiresAt } : {}),
            now: this.now(),
          }),
        );
      });

      this.killTimer = setTimeout(() => {
        this.killTimer = null;
        this.killChild('SIGTERM');
        finish({ state: 'failed', reason: 'timeout' });
      }, this.waitMs);
    });
  }
}
