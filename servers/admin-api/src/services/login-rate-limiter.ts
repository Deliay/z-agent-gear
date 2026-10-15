export const TOO_MANY_REQUESTS = 'TOO_MANY_REQUESTS';

/** 登录被限速/锁定（问题 7）：上层映射为 GraphQL 错误码 TOO_MANY_REQUESTS。 */
export class LoginRateLimitError extends Error {
  readonly code = TOO_MANY_REQUESTS;

  constructor(readonly retryAfterSeconds: number) {
    super(`登录失败次数过多，请在 ${retryAfterSeconds} 秒后重试`);
    this.name = 'LoginRateLimitError';
  }
}

export interface LoginRateLimiterOptions {
  /** 窗口内允许的最大失败次数 */
  maxAttempts?: number;
  /** 失败计数窗口 */
  windowMs?: number;
  /** 达阈值后的锁定时长 */
  lockoutMs?: number;
  /** 可注入时钟（单测用） */
  now?: () => number;
}

interface Entry {
  attempts: number;
  windowStart: number;
  lockedUntil: number;
}

/**
 * 登录失败限速器（内存实现，问题 7）。
 * 以 `ip:username` 为 key：窗口内失败达阈值即锁定一段时间，成功登录重置计数。
 * 纯内存、无外部依赖，适合管理后台单实例部署；多实例需替换为共享存储。
 */
export class LoginRateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly lockoutMs: number;
  private readonly now: () => number;

  constructor(options: LoginRateLimiterOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.windowMs = options.windowMs ?? 15 * 60 * 1000;
    this.lockoutMs = options.lockoutMs ?? 15 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  /** 被锁定则抛 LoginRateLimitError；否则放行。 */
  assertAllowed(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;

    const now = this.now();
    if (entry.lockedUntil > now) {
      throw new LoginRateLimitError(Math.ceil((entry.lockedUntil - now) / 1000));
    }
    // 锁定已过期：清除过期计数，避免复用陈旧 attempts
    if (entry.lockedUntil > 0 && entry.lockedUntil <= now) {
      this.entries.delete(key);
    }
  }

  recordFailure(key: string): void {
    const now = this.now();
    const entry = this.entries.get(key);
    const withinWindow = entry !== undefined && now - entry.windowStart <= this.windowMs;
    const attempts = withinWindow ? entry!.attempts + 1 : 1;
    const windowStart = withinWindow ? entry!.windowStart : now;
    const lockedUntil = attempts >= this.maxAttempts ? now + this.lockoutMs : 0;

    this.entries.set(key, { attempts, windowStart, lockedUntil });
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  reset(): void {
    this.entries.clear();
  }
}

export const loginRateLimiter = new LoginRateLimiter();
