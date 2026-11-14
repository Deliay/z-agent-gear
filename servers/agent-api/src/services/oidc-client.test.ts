import { describe, it, expect } from 'vitest';
import { normalizeOidcClaims } from './oidc-client.js';

describe('normalizeOidcClaims', () => {
  it('优先 preferred_username', () => {
    expect(
      normalizeOidcClaims({ sub: 'abc123', preferred_username: 'alice', email: 'a@b.com', name: 'Alice' }),
    ).toEqual({ subject: 'abc123', externalUsername: 'alice', displayName: 'Alice' });
  });

  it('回退 email 本地段', () => {
    expect(normalizeOidcClaims({ sub: 'abc123', email: ' bob@example.com ' })).toEqual({
      subject: 'abc123',
      externalUsername: ' bob',
      displayName: null,
    });
  });

  it('再回退 sub 前 8', () => {
    expect(normalizeOidcClaims({ sub: '1234567890' })).toEqual({
      subject: '1234567890',
      externalUsername: '12345678',
      displayName: null,
    });
  });

  it('缺少 sub 抛错', () => {
    expect(() => normalizeOidcClaims({})).toThrow();
  });
});
