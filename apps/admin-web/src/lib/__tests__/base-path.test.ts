import { describe, it, expect, vi, afterEach } from 'vitest';
import { getBasePath } from '../base-path';

describe('getBasePath', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns empty string for the root base', () => {
    vi.stubEnv('BASE_URL', '/');
    expect(getBasePath()).toBe('');
  });

  it('strips the trailing slash for a sub-path deployment', () => {
    vi.stubEnv('BASE_URL', '/admin/');
    expect(getBasePath()).toBe('/admin');
  });

  it('keeps a base without a trailing slash unchanged', () => {
    vi.stubEnv('BASE_URL', '/admin');
    expect(getBasePath()).toBe('/admin');
  });
});
