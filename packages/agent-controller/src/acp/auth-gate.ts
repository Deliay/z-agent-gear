import { randomUUID } from 'node:crypto';
import { KimiLoginFlow, resolveKimiAuthCacheTtlMs, type KimiLoginHandlers, type KimiLoginTerminal } from '../harness/kimi-login.js';

/** 本期唯一需要登录闸门的 harness 类型。 */
export const KIMI_SERVER_TYPE = 'kimi_code';
/** 统一失败文案（前端原样展示，不新增错误码）。 */
export const AUTH_REQUIRED_MESSAGE = 'Kimi Code 未登录';

export type AuthTrigger = 'probe-options' | 'acp:start' | 'acp:resume';

/** 使用动作因未登录失败（handler 据此在 result 上带 `reason:'auth'`）。 */
export class AuthRequiredError extends Error {
  readonly reason = 'auth' as const;
  constructor(message: string = AUTH_REQUIRED_MESSAGE) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

/** 出站 `harness:login:*` 事件（形状以契约 §2.35–2.37 为准）。 */
export interface HarnessLoginRequiredPayload {
  requestId: string;
  serverType: typeof KIMI_SERVER_TYPE;
  trigger: AuthTrigger;
  url: string;
  userCode: string;
  expiresInSeconds?: number;
}

export type HarnessLoginEmitter = (event: string, payload: Record<string, unknown>) => void;

/** 可注入的登录流程（生产为 KimiLoginFlow，测试用 fake）。 */
export interface KimiLoginFlowLike {
  run(handlers?: KimiLoginHandlers): Promise<KimiLoginTerminal>;
  cancel(): void;
}

export interface AcpAuthGateOptions {
  emit?: HarnessLoginEmitter;
  /** 登录缓存 TTL（默认 KIMI_AUTH_CACHE_TTL_MS / 300000）。 */
  cacheTtlMs?: number;
  now?: () => number;
  createFlow?: () => KimiLoginFlowLike;
  createRequestId?: () => string;
}

/**
 * harness 使用前登录闸门（仅 `kimi_code`，其余 serverType 立即 resolve 零开销）。
 *
 * 单进程 single-flight：同一时刻只有一个 `kimi login` 与一条 `required`；
 * 并发使用动作共享同一 Promise，登录成功后写入进程内 TTL 缓存（无 Redis 依赖）。
 */
export class AcpAuthGate {
  private readonly emit: HarnessLoginEmitter;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly createFlow: () => KimiLoginFlowLike;
  private readonly createRequestId: () => string;

  /** serverType → 缓存到期时间戳。 */
  private readonly cache = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<void>>();
  private current: { requestId: string; flow: KimiLoginFlowLike } | null = null;

  constructor(options: AcpAuthGateOptions = {}) {
    this.emit = options.emit ?? (() => {});
    this.cacheTtlMs = options.cacheTtlMs ?? resolveKimiAuthCacheTtlMs();
    this.now = options.now ?? Date.now;
    this.createRequestId = options.createRequestId ?? randomUUID;
    this.createFlow = options.createFlow ?? (() => new KimiLoginFlow());
  }

  /** 当前进行中的登录 requestId（无登录流程时为 null；供日志/测试）。 */
  get pendingRequestId(): string | null {
    return this.current?.requestId ?? null;
  }

  /** 缓存命中/非 kimi_code 立即 resolve；否则走（或复用）登录流程。 */
  async ensure(serverType: string, trigger: AuthTrigger): Promise<void> {
    if (serverType !== KIMI_SERVER_TYPE) return;
    const expiresAt = this.cache.get(serverType);
    if (expiresAt !== undefined && this.now() < expiresAt) return;
    const existing = this.inflight.get(serverType);
    if (existing) return existing;

    const promise = this.runLogin(serverType, trigger).finally(() => {
      if (this.inflight.get(serverType) === promise) this.inflight.delete(serverType);
    });
    this.inflight.set(serverType, promise);
    return promise;
  }

  private async runLogin(serverType: string, trigger: AuthTrigger): Promise<void> {
    const requestId = this.createRequestId();
    const flow = this.createFlow();
    this.current = { requestId, flow };

    let outcome: KimiLoginTerminal;
    try {
      outcome = await flow.run({
        onDeviceFlow: ({ url, userCode, expiresInSeconds }) => {
          this.emit('harness:login:required', {
            requestId,
            serverType: KIMI_SERVER_TYPE,
            trigger,
            url,
            userCode,
            expiresInSeconds,
          });
        },
      });
    } finally {
      if (this.current?.requestId === requestId) this.current = null;
    }

    if (outcome.state === 'logged-in') {
      this.cache.set(serverType, this.now() + this.cacheTtlMs);
      this.emit('harness:login:succeeded', {
        requestId,
        ...(outcome.account ? { account: outcome.account } : {}),
      });
      return;
    }
    this.emit('harness:login:failed', {
      requestId,
      reason: outcome.reason,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
    throw new AuthRequiredError();
  }

  /** 服务端 `harness:login:cancel` 下行：requestId 不匹配时忽略。 */
  cancel(requestId: string): void {
    if (!requestId || this.current?.requestId !== requestId) return;
    this.current.flow.cancel();
  }

  /** 清空进程内登录状态（测试/调试用；不影响已登录凭证）。 */
  reset(): void {
    this.cache.clear();
    this.inflight.clear();
    this.current = null;
  }
}
