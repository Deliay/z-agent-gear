import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isNetworkAuthError } from '../auth-error';

describe('isNetworkAuthError', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('matches explicit connection-failure phrases', () => {
    expect(isNetworkAuthError(new Error('Failed to fetch'))).toBe(true);
    expect(isNetworkAuthError(new Error('Network error'))).toBe(true);
    expect(isNetworkAuthError(new Error('Load failed'))).toBe(true);
    expect(isNetworkAuthError(new Error('connect ECONNREFUSED 127.0.0.1:10003'))).toBe(true);
    expect(isNetworkAuthError(new Error('request timed out'))).toBe(true);
  });

  it('treats an empty message as connection failure (no business text)', () => {
    expect(isNetworkAuthError(new Error(''))).toBe(true);
  });

  it('honours an explicit networkError property', () => {
    const err = Object.assign(new Error('something odd'), { networkError: {} });
    expect(isNetworkAuthError(err)).toBe(true);
  });

  it('does NOT misclassify business errors that merely mention fetch/network/timeout words', () => {
    expect(isNetworkAuthError(new Error('用户名或密码错误'))).toBe(false);
    expect(isNetworkAuthError(new Error('Network policy denied'))).toBe(false);
    expect(isNetworkAuthError(new Error('Timeout must be positive'))).toBe(false);
    expect(isNetworkAuthError(new Error('failed to create provider: duplicate name'))).toBe(false);
  });
});
