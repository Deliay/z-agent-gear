import { describe, it, expect } from 'vitest';
import { deriveUsername } from './external-login.js';

describe('deriveUsername', () => {
  it('保留 [a-zA-Z0-9_-]', () => {
    expect(deriveUsername('octo-test_1')).toBe('octo-test_1');
  });

  it('过滤非法字符并截断 20', () => {
    expect(deriveUsername('john.doe@example.com')).toBe('johndoeexamplecom');
    expect(deriveUsername('x'.repeat(40))).toHaveLength(20);
  });

  it('不足 2 字符时补 u_ 前缀', () => {
    expect(deriveUsername('a')).toBe('u_a');
    expect(deriveUsername('!!!')).toBe('u_');
    expect(deriveUsername('!!!').length).toBeGreaterThanOrEqual(2);
  });
});
