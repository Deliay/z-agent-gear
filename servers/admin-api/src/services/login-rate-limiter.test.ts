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
});
