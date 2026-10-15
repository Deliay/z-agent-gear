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
  /**
   * 内存中保留的最大 entry 数（问题 49）。攻击者可轮换用户名制造大量 key，
   * 超过上限时按最旧插入顺序驱逐一个，保证 Map 不无界增长。
   */
  maxEntries?: number;
}

interface Entry {
  attempts: number;
  windowStart: number;
  lockedUntil: number;
}

/**
 * 登录失败限速器（内存实现，问题 7）。
 * 以调用方给定的 key（如 `ip:username` 或 `username`）为维度：窗口内失败达阈值即锁定一段时间，
 * 成功登录重置计数。纯内存、无外部依赖，适合管理后台单实例部署；多实例需替换为共享存储。
 *
 * 问题 49 加固：每次记录失败前清理已过期 entry，并设 `maxEntries` 上限兜底驱逐，
 * 避免伪造/轮换 key 导致 Map 无界增长。
 */
export class LoginRateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly lockoutMs: number;
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(options: LoginRateLimiterOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.windowMs = options.windowMs ?? 15 * 60 * 1000;
    this.lockoutMs = options.lockoutMs ?? 15 * 60 * 1000;
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  /** 当前保留的 entry 数（单测断言 Map 有界用）。 */
  get size(): number {
    return this.entries.size;
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
    this.prune(now);
    // 上限兜底：驱逐最旧 entry，防止攻击者轮换 key 使 Map 无界增长
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }

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

  /** 清理「窗口已过期且未处于锁定中」的 entry（问题 49）。 */
  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      const windowExpired = now - entry.windowStart > this.windowMs;
      const unlocked = entry.lockedUntil <= now;
      if (windowExpired && unlocked) {
        this.entries.delete(key);
      }
    }
  }
}

/** 按 `ip:username` 限速的实例：窗口内 5 次失败即锁定（问题 7）。 */
export const loginRateLimiter = new LoginRateLimiter();

/**
 * 按 `username` 全局限速的实例（问题 49）：阈值高于按 IP 的实例（30 次），
 * 用于兜底「攻击者轮换来源 IP / 伪造转发头」的在线暴力破解。
 */
export const usernameLoginRateLimiter = new LoginRateLimiter({ maxAttempts: 30 });
