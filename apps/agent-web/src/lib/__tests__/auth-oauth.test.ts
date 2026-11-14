import { describe, it, expect } from 'vitest';
import {
  mapIdentityChoiceError,
  mapOauthError,
  oauthAuthorizeUrl,
} from '../auth-oauth';

describe('lib/auth-oauth（T-OBO-LIB）', () => {
  it('前台错误码映射（already_bound 前台文案独立 + provider_already_bound）', () => {
    expect(mapOauthError('already_bound')).toBe('该身份已被其他账户绑定');
    expect(mapOauthError('provider_already_bound')).toBe('当前账户已绑定该登录方式');
    expect(mapOauthError('invalid_bind_ticket')).toBe('绑定已过期，请重新发起');
    expect(mapOauthError('unknown')).toBe('unknown');
    expect(mapOauthError(null)).toBe('');
  });

  it('身份选择页 / 绑定管理 mutation 文案映射', () => {
    expect(mapIdentityChoiceError('invalid or expired pending token')).toBe(
      '登录状态已过期，请重新登录',
    );
    expect(mapIdentityChoiceError('identity already bound')).toBe('该身份已被其他账户绑定');
    expect(mapIdentityChoiceError('provider already bound')).toBe(
      '当前账户已绑定该登录方式',
    );
    expect(mapIdentityChoiceError('provider unavailable')).toBe('该登录方式已停用');
    expect(mapIdentityChoiceError('provision failed')).toBe('账户开通失败，请联系管理员');
    expect(mapIdentityChoiceError('cannot unbind last login method')).toContain(
      '唯一的登录方式',
    );
    // 验密失败与登录页一致：原样展示
    expect(mapIdentityChoiceError('Invalid username or password')).toBe(
      'Invalid username or password',
    );
    expect(mapIdentityChoiceError(undefined)).toBe('');
  });

  it('授权 URL 组装：front / front-bind(ticket)', () => {
    const front = oauthAuthorizeUrl('p1', 'front');
    expect(front).toContain('/api/auth/oauth/p1/authorize?surface=front');

    const bind = oauthAuthorizeUrl('p 2', 'front-bind', 'fb-1');
    expect(bind).toContain('/api/auth/oauth/p%202/authorize?');
    expect(bind).toContain('surface=front-bind');
    expect(bind).toContain('ticket=fb-1');
  });
});
