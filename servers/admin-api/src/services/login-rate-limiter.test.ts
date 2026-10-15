import { describe, it, expect } from 'vitest';
import { LoginRateLimiter, LoginRateLimitError } from './login-rate-limiter';

describe('LoginRateLimiter (问题 7)', () => {
  it('allows attempts below the threshold and locks at the threshold', () => {
    const now = 0;
    const limiter = new LoginRateLimiter({ maxAttempts: 3, windowMs: 1000, lockoutMs: 5000, now: () => now });
    const key = 'ip:admin';

    limiter.recordFailure(key);
    limiter.recordFailure(key);
    expect(() => limiter.assertAllowed(key)).not.toThrow();

    limiter.recordFailure(key);
    expect(() => limiter.assertAllowed(key)).toThrow(LoginRateLimitError);
  });

  it('reports retryAfterSeconds based on the remaining lockout', () => {
    let now = 1000;
    const limiter = new LoginRateLimiter({ maxAttempts: 1, windowMs: 10000, lockoutMs: 5000, now: () => now });
    limiter.recordFailure('k');

    now = 3000;
    try {
      limiter.assertAllowed('k');
      throw new Error('expected lockout');
    } catch (err) {
      expect(err).toBeInstanceOf(LoginRateLimitError);
      expect((err as LoginRateLimitError).retryAfterSeconds).toBe(3);
      expect((err as LoginRateLimitError).code).toBe('TOO_MANY_REQUESTS');
    }
  });

  it('unlocks once the lockout window elapses', () => {
    let now = 0;
    const limiter = new LoginRateLimiter({ maxAttempts: 1, windowMs: 1000, lockoutMs: 1000, now: () => now });
    limiter.recordFailure('k');
    expect(() => limiter.assertAllowed('k')).toThrow();

    now = 1001;
    expect(() => limiter.assertAllowed('k')).not.toThrow();
  });

  it('resets the counter on a successful login', () => {
    const now = 0;
    const limiter = new LoginRateLimiter({ maxAttempts: 2, windowMs: 1000, lockoutMs: 1000, now: () => now });
    limiter.recordFailure('k');
    limiter.recordSuccess('k');
    limiter.recordFailure('k');
    expect(() => limiter.assertAllowed('k')).not.toThrow();
  });

  it('keys are independent (different username not affected)', () => {
    const now = 0;
    const limiter = new LoginRateLimiter({ maxAttempts: 1, windowMs: 1000, lockoutMs: 1000, now: () => now });
    limiter.recordFailure('ip:admin');
    expect(() => limiter.assertAllowed('ip:other')).not.toThrow();
  });

  it('问题 49: prunes expired entries so the Map cannot grow unbounded', () => {
    let now = 0;
    const limiter = new LoginRateLimiter({ windowMs: 1000, lockoutMs: 1000, now: () => now });
    for (let i = 0; i < 50; i += 1) {
      limiter.recordFailure(`forged-${i}`);
    }
    expect(limiter.size).toBe(50);

    // 窗口过期后再次记录会先清理所有陈旧 key
    now = 5000;
    limiter.recordFailure('fresh');
    expect(limiter.size).toBe(1);
    expect(limiter.size).toBeLessThanOrEqual(1);
  });

  it('问题 49: hard caps entry count via maxEntries eviction', () => {
    const now = 0;
    const limiter = new LoginRateLimiter({
      windowMs: 60 * 60 * 1000,
      lockoutMs: 60 * 60 * 1000,
      maxEntries: 100,
      now: () => now,
    });
    for (let i = 0; i < 1000; i += 1) {
      limiter.recordFailure(`rotating-${i}`);
    }
    expect(limiter.size).toBeLessThanOrEqual(100);
  });
});
