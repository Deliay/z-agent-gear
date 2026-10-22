import { writeGhAuth } from './gh-config.js';
import { redactSecrets } from '../workload-executor.js';

/** 定时续期间隔（50 分钟，覆盖 Github App installation token 约 1 小时有效期）。 */
export const REFRESH_INTERVAL_MS = 50 * 60 * 1000;

/** token 到期前提前续期的余量（10 分钟）。 */
export const EXPIRY_SKEW_MS = 10 * 60 * 1000;

/** 申请接口超时（10 秒）。 */
export const REQUEST_TIMEOUT_MS = 10_000;

/** 401/403 退避序列（1/2/4 分钟，最多 3 次重试）。 */
export const BACKOFF_MS = [60_000, 120_000, 240_000] as const;

/** 凭据管理器依赖注入（测试锚定网络/时钟/副作用；生产使用缺省实现）。 */
export interface GithubCredentialManagerDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  writeGhAuth?: (token: string) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
  /** 定时器注入（测试用）；缺省使用全局 `setTimeout`。 */
  setTimeout?: typeof setTimeout;
  /** 退避等待注入（测试用）；缺省使用 `setTimeout`。 */
  sleep?: (ms: number) => Promise<void>;
}

/** `refreshNow()` 的统一返回（不包含 token）。 */
export interface GithubCredentialRefreshResult {
  ok: boolean;
  expiresAt?: Date;
  /** 可读错误码/文案；`no-binding` 表示尚未设置 Git 项目（正常跳过）。 */
  error?: string;
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * 云主机内 Github 凭据管理器（容器侧唯一凭据写入口）。
 *
 * - `start()`：校验 env 后立即申请一次，并按「50 分钟」或「token 到期前 10 分钟」（取较早）
 *   自续期；定时器 `unref()`，不阻止进程退出；
 * - `refreshNow()`：向 agent-api 申请仓库级 token 并写入 gh 配置；并发调用合并为一次请求；
 *   401/403 在本次调用内按 1/2/4 分钟退避（最多 3 次）；
 * - 404（未绑定 Git 项目）返回 `no-binding`，不告警；
 * - token 只交给 `writeGhAuth`（stdin），从不进入日志/错误。
 */
export class GithubCredentialManager {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchFn: typeof fetch;
  private readonly writeAuth: (token: string) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly sleepFn: (ms: number) => Promise<void>;

  private timer: Timer | null = null;
  private started = false;
  private stopped = false;
  private expiresAt: Date | null = null;
  private activeRefresh: Promise<GithubCredentialRefreshResult> | null = null;

  constructor(deps: GithubCredentialManagerDeps = {}) {
    this.env = deps.env ?? process.env;
    this.fetchFn = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.writeAuth = deps.writeGhAuth ?? ((token: string) => writeGhAuth(token));
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((message: string) => console.log(message));
    this.setTimeoutFn = deps.setTimeout ?? setTimeout;
    this.sleepFn =
      deps.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          timer.unref?.();
        }));
  }

  /** 当前是否具备申请条件（三个 env 均非空）。 */
  isEnabled(): boolean {
    return this.missingEnv().length === 0;
  }

  /** 启动：立即申请一次，并安排下一次续期（env 缺失时只 warn，不抛错）。 */
  start(): void {
    if (this.started) return;
    this.stopped = false;
    const missing = this.missingEnv();
    if (missing.length > 0) {
      this.log(`[GithubCredential] disabled: missing environment variable(s): ${missing.join(', ')}`);
      return;
    }
    this.started = true;
    void this.refreshNow()
      .catch(() => undefined)
      .finally(() => this.scheduleNext());
  }

  /** 停止定时续期（进程退出/云主机 shutdown）。 */
  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * 立即申请并写入 gh 配置。
   *
   * 并发调用共享同一个 in-flight Promise（只发一次请求），从而串行化「申请 → 写入」。
   */
  refreshNow(): Promise<GithubCredentialRefreshResult> {
    if (this.activeRefresh) return this.activeRefresh;
    const refresh = this.doRefresh().finally(() => {
      if (this.activeRefresh === refresh) this.activeRefresh = null;
    });
    this.activeRefresh = refresh;
    return refresh;
  }

  private async doRefresh(): Promise<GithubCredentialRefreshResult> {
    if (!this.isEnabled()) {
      return { ok: false, error: 'disabled' };
    }

    const endpoint = this.env.ZAG_AGENT_API_ENDPOINT!.trim().replace(/\/+$/, '');
    const controllerId = this.env.ZAG_CONTROLLER_ID!.trim();
    const hostKey = this.env.ZAG_HOST_KEY!.trim();
    const url = `${endpoint}/internal/cloud-hosts/${encodeURIComponent(controllerId)}/github-credential`;

    for (let attempt = 0; ; attempt += 1) {
      const result = await this.request(url, hostKey);
      if (result.kind === 'retryable' && attempt < BACKOFF_MS.length) {
        const delay = BACKOFF_MS[attempt]!;
        this.log(
          `[GithubCredential] 凭据无效（HTTP ${result.status}），${Math.round(delay / 60_000)} 分钟后重试` +
            `（${attempt + 1}/${BACKOFF_MS.length}）`,
        );
        await this.sleepFn(delay);
        continue;
      }
      if (result.kind === 'retryable') {
        return { ok: false, error: `Github 凭据无效（HTTP ${result.status}）` };
      }
      return result.value;
    }
  }

  private async request(
    url: string,
    hostKey: string,
  ): Promise<
    | { kind: 'retryable'; status: number }
    | { kind: 'result'; value: GithubCredentialRefreshResult }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${hostKey}` },
        signal: controller.signal,
      });

      if (response.status === 404) {
        // 未设置 Git 项目：正常跳过，不告警、不重试。
        return { kind: 'result', value: { ok: false, error: 'no-binding' } };
      }
      if (response.status === 401 || response.status === 403) {
        return { kind: 'retryable', status: response.status };
      }
      if (!response.ok) {
        return {
          kind: 'result',
          value: { ok: false, error: `Github 凭据申请失败（HTTP ${response.status}）` },
        };
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { kind: 'result', value: { ok: false, error: 'Github 凭据响应不是合法 JSON' } };
      }
      const token = (payload as { token?: unknown } | null)?.token;
      if (typeof token !== 'string' || token.length === 0) {
        return { kind: 'result', value: { ok: false, error: 'Github 凭据响应缺少 token' } };
      }
      const rawExpiresAt = (payload as { expiresAt?: unknown } | null)?.expiresAt;
      const expiresAt =
        typeof rawExpiresAt === 'string' && !Number.isNaN(Date.parse(rawExpiresAt))
          ? new Date(rawExpiresAt)
          : undefined;

      try {
        await this.writeAuth(token);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          kind: 'result',
          value: { ok: false, error: `写入 gh 配置失败：${redactSecrets(reason, [token])}` },
        };
      }

      this.expiresAt = expiresAt ?? null;
      this.log(
        expiresAt
          ? `[GithubCredential] gh 凭据已更新，有效期至 ${expiresAt.toISOString()}`
          : '[GithubCredential] gh 凭据已更新',
      );
      return { kind: 'result', value: { ok: true, expiresAt } };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const message = /abort/i.test(reason)
        ? 'Github 凭据申请超时（10s）'
        : `Github 凭据申请失败：${reason}`;
      return { kind: 'result', value: { ok: false, error: message } };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 下一次续期：50 分钟与「到期前 10 分钟」取较早；定时器 unref，不阻止进程退出。 */
  private scheduleNext(): void {
    if (this.stopped || !this.started || !this.isEnabled()) return;
    let delay = REFRESH_INTERVAL_MS;
    if (this.expiresAt) {
      const beforeExpiry = this.expiresAt.getTime() - EXPIRY_SKEW_MS - this.now();
      if (beforeExpiry > 0 && beforeExpiry < delay) delay = beforeExpiry;
    }
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      void this.refreshNow()
        .catch(() => undefined)
        .finally(() => this.scheduleNext());
    }, delay);
    this.timer.unref?.();
  }

  private missingEnv(): string[] {
    const keys = ['ZAG_AGENT_API_ENDPOINT', 'ZAG_CONTROLLER_ID', 'ZAG_HOST_KEY'] as const;
    return keys.filter((key) => {
      const value = this.env[key];
      return typeof value !== 'string' || value.trim().length === 0;
    });
  }
}
