import { CommitIdentity, type CommitIdentityMode } from './commit-identity.js';
import { redactSecrets } from '../workload-executor.js';

/** 提交身份同步间隔（50 分钟）。 */
export const REFRESH_INTERVAL_MS = 50 * 60 * 1000;

/** 下发接口超时（10 秒）。 */
export const REQUEST_TIMEOUT_MS = 10_000;

/** 401/403 退避序列（1/2/4 分钟，最多 3 次重试）。 */
export const BACKOFF_MS = [60_000, 120_000, 240_000] as const;

/** 托管配置应用器（测试注入；生产为 `CommitIdentity`）。 */
export interface CommitIdentityApplier {
  apply(
    mode: Exclude<CommitIdentityMode, 'unset'>,
    identity: {
      name: string;
      email: string;
      coAuthorName?: string;
      coAuthorEmail?: string;
    },
  ): Promise<void>;
  remove(): Promise<void>;
}

/** 提交身份管理器依赖注入（测试锚定网络 / 时钟 / 副作用；生产使用缺省实现）。 */
export interface CommitIdentityManagerDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  applier?: CommitIdentityApplier;
  log?: (message: string) => void;
  /** 定时器注入（测试用）；缺省使用全局 `setTimeout`。 */
  setTimeout?: typeof setTimeout;
  /** 退避等待注入（测试用）；缺省使用 `setTimeout`。 */
  sleep?: (ms: number) => Promise<void>;
}

/** `refreshNow()` 的统一返回（不含任何身份值）。 */
export interface CommitIdentityRefreshResult {
  ok: boolean;
  /** 成功应用 / 移除的模式；失败或缺省时不返回。 */
  mode?: CommitIdentityMode;
  /** 可读错误文案；`disabled` 表示 env 缺失。 */
  error?: string;
}

const VALID_MODES: readonly CommitIdentityMode[] = [
  'agent_only',
  'co_author',
  'human_only',
  'unset',
];

type Timer = ReturnType<typeof setTimeout>;

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * 容器内提交身份同步管理器（实现点 3，与 `GithubCredentialManager` 同构）。
 *
 * - `start()`：校验 env 后立即拉取一次，之后每 50 分钟拉取；定时器 `unref()`；
 * - `refreshNow()`：POST 内部端点，并发调用合并为一次请求；401/403 按 1/2/4 分钟退避（≤3 次）；
 * - 成功响应按字段存在性消费：`mode=unset` → `remove()`，其余 → `apply()`；
 * - 网络 / 解析 / 应用失败保留现状，返回可读错误，不崩溃、不回滚已应用配置；
 * - 与凭据管理器相互独立（不依赖 gh 凭据 / Git 项目绑定）；日志不含 host key 与身份值。
 */
export class CommitIdentityManager {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchFn: typeof fetch;
  private readonly applier: CommitIdentityApplier;
  private readonly log: (message: string) => void;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly sleepFn: (ms: number) => Promise<void>;

  private timer: Timer | null = null;
  private started = false;
  private stopped = false;
  private activeRefresh: Promise<CommitIdentityRefreshResult> | null = null;

  constructor(deps: CommitIdentityManagerDeps = {}) {
    this.env = deps.env ?? process.env;
    this.fetchFn = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.applier = deps.applier ?? new CommitIdentity();
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

  /** 当前是否具备拉取条件（三个 env 均非空）。 */
  isEnabled(): boolean {
    return this.missingEnv().length === 0;
  }

  /** 启动：立即拉取一次并安排下一次同步（env 缺失时只 warn，不抛错）。 */
  start(): void {
    if (this.started) return;
    this.stopped = false;
    const missing = this.missingEnv();
    if (missing.length > 0) {
      this.log(`[CommitIdentity] disabled: missing environment variable(s): ${missing.join(', ')}`);
      return;
    }
    this.started = true;
    void this.refreshNow()
      .catch(() => undefined)
      .finally(() => this.scheduleNext());
  }

  /** 停止周期同步（进程退出 / 云主机 shutdown）。 */
  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 立即拉取并应用 / 移除托管配置；并发调用共享同一个 in-flight Promise。 */
  refreshNow(): Promise<CommitIdentityRefreshResult> {
    if (this.activeRefresh) return this.activeRefresh;
    const refresh = this.doRefresh().finally(() => {
      if (this.activeRefresh === refresh) this.activeRefresh = null;
    });
    this.activeRefresh = refresh;
    return refresh;
  }

  private async doRefresh(): Promise<CommitIdentityRefreshResult> {
    if (!this.isEnabled()) {
      return { ok: false, error: 'disabled' };
    }

    const endpoint = this.env.ZAG_AGENT_API_ENDPOINT!.trim().replace(/\/+$/, '');
    const controllerId = this.env.ZAG_CONTROLLER_ID!.trim();
    const hostKey = this.env.ZAG_HOST_KEY!.trim();
    const url = `${endpoint}/internal/cloud-hosts/${encodeURIComponent(controllerId)}/commit-identity`;

    for (let attempt = 0; ; attempt += 1) {
      const result = await this.request(url, hostKey);
      if (result.kind === 'retryable' && attempt < BACKOFF_MS.length) {
        const delay = BACKOFF_MS[attempt]!;
        this.log(
          `[CommitIdentity] 提交身份下发未授权（HTTP ${result.status}），` +
            `${Math.round(delay / 60_000)} 分钟后重试（${attempt + 1}/${BACKOFF_MS.length}）`,
        );
        await this.sleepFn(delay);
        continue;
      }
      if (result.kind === 'retryable') {
        return { ok: false, error: `提交身份下发未授权（HTTP ${result.status}）` };
      }
      return result.value;
    }
  }

  private async request(
    url: string,
    hostKey: string,
  ): Promise<
    | { kind: 'retryable'; status: number }
    | { kind: 'result'; value: CommitIdentityRefreshResult }
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

      if (response.status === 401 || response.status === 403) {
        return { kind: 'retryable', status: response.status };
      }
      if (!response.ok) {
        return {
          kind: 'result',
          value: { ok: false, error: `提交身份下发失败（HTTP ${response.status}）` },
        };
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { kind: 'result', value: { ok: false, error: '提交身份响应不是合法 JSON' } };
      }

      return { kind: 'result', value: await this.consume(payload, hostKey) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const message = /abort/i.test(reason)
        ? '提交身份下发超时（10s）'
        : `提交身份下发失败：${redactSecrets(reason, [hostKey])}`;
      return { kind: 'result', value: { ok: false, error: message } };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 按字段存在性消费响应：unset → remove；其余 → apply。 */
  private async consume(payload: unknown, hostKey: string): Promise<CommitIdentityRefreshResult> {
    const body = (payload ?? {}) as Record<string, unknown>;
    const mode = body.mode;
    if (typeof mode !== 'string' || !VALID_MODES.includes(mode as CommitIdentityMode)) {
      return { ok: false, error: `提交身份响应 mode 非法：${String(mode)}` };
    }

    if (mode === 'unset') {
      try {
        await this.applier.remove();
      } catch (error) {
        return { ok: false, error: this.applyError('移除', error, hostKey) };
      }
      this.log('[CommitIdentity] 托管配置已移除（mode=unset）');
      return { ok: true, mode: 'unset' };
    }

    const name = nonEmptyString(body.name);
    const email = nonEmptyString(body.email);
    if (!name || !email) {
      return { ok: false, error: '提交身份响应缺少 name/email' };
    }

    if (mode === 'co_author') {
      const coAuthorName = nonEmptyString(body.coAuthorName);
      const coAuthorEmail = nonEmptyString(body.coAuthorEmail);
      if (!coAuthorName || !coAuthorEmail) {
        return { ok: false, error: '提交身份响应缺少 coAuthorName/coAuthorEmail' };
      }
      try {
        await this.applier.apply(mode, { name, email, coAuthorName, coAuthorEmail });
      } catch (error) {
        return { ok: false, error: this.applyError('应用', error, hostKey) };
      }
    } else {
      const narrowed = mode as 'agent_only' | 'human_only';
      try {
        await this.applier.apply(narrowed, { name, email });
      } catch (error) {
        return { ok: false, error: this.applyError('应用', error, hostKey) };
      }
    }

    this.log(`[CommitIdentity] 提交身份已更新（mode=${mode}）`);
    return { ok: true, mode: mode as CommitIdentityMode };
  }

  private applyError(action: string, error: unknown, hostKey: string): string {
    const reason = error instanceof Error ? error.message : String(error);
    return `提交身份${action}失败：${redactSecrets(reason, [hostKey])}`;
  }

  /** 下一次同步：固定 50 分钟；定时器 unref，不阻止进程退出。 */
  private scheduleNext(): void {
    if (this.stopped || !this.started || !this.isEnabled()) return;
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      void this.refreshNow()
        .catch(() => undefined)
        .finally(() => this.scheduleNext());
    }, REFRESH_INTERVAL_MS);
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
