import { describe, it, expect } from 'vitest';
import { config } from '../config/index.js';
import {
  validateClientId,
  validateClientSecret,
  validateDisplayName,
  validateIssuer,
  validateScopes,
  oauthCallbackUrl,
} from './auth-provider.js';

describe('auth-provider 校验（T-AP）', () => {
  it('displayName trim 1..64', () => {
    expect(validateDisplayName('  Corp SSO  ')).toBe('Corp SSO');
    expect(() => validateDisplayName('')).toThrow();
    expect(() => validateDisplayName('x'.repeat(65))).toThrow();
  });

  it('issuer 必须是合法 http(s) URL 且去除尾斜杠', () => {
    expect(validateIssuer('https://idp.example.com/')).toBe('https://idp.example.com');
    expect(() => validateIssuer('not-a-url')).toThrow();
    expect(() => validateIssuer('ftp://idp.example.com')).toThrow();
  });

  it('生产环境强制 https issuer', () => {
    const original = config.nodeEnv;
    config.nodeEnv = 'production';
    try {
      expect(() => validateIssuer('http://idp.local')).toThrow('https');
    } finally {
      config.nodeEnv = original;
    }
  });

  it('clientId 非空且 ≤256', () => {
    expect(validateClientId(' client ')).toBe('client');
    expect(() => validateClientId('')).toThrow();
    expect(() => validateClientId('x'.repeat(257))).toThrow();
  });

  it('clientSecret 必填', () => {
    expect(validateClientSecret('secret')).toBe('secret');
    expect(() => validateClientSecret('')).toThrow();
  });

  it('scopes 非空', () => {
    expect(validateScopes(' openid email ')).toBe('openid email');
    expect(() => validateScopes('')).toThrow();
  });

  it('callbackUrl = agent-api 对外地址 + 统一回调路径', () => {
    const original = config.agentApiPublicUrl;
    config.agentApiPublicUrl = 'https://api.example.com/';
    try {
      expect(oauthCallbackUrl()).toBe('https://api.example.com/api/auth/oauth/callback');
    } finally {
      config.agentApiPublicUrl = original;
    }
  });
});
