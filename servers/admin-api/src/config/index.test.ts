import { describe, it, expect, afterEach } from 'vitest';
import { config, assertRuntimeConfig, isWeakAdminPassword } from './index';

describe('config (问题 4 / 问题 26 / 问题 47)', () => {
  const originalInitialPassword = config.initialAdminPassword;
  const originalJwtSecret = config.adminJwtSecret;

  afterEach(() => {
    config.initialAdminPassword = originalInitialPassword;
    config.adminJwtSecret = originalJwtSecret;
  });

  describe('isWeakAdminPassword', () => {
    it('rejects the legacy hardcoded default and known weak passwords', () => {
      expect(isWeakAdminPassword('admin1234567')).toBe(true);
      expect(isWeakAdminPassword('admin')).toBe(true);
      expect(isWeakAdminPassword('password123')).toBe(true);
      expect(isWeakAdminPassword('changeme')).toBe(true);
    });

    it('rejects the publicly documented dev default (问题 47)', () => {
      expect(isWeakAdminPassword('dev-admin-init-password')).toBe(true);
    });

    it('rejects too-short and blank passwords', () => {
      expect(isWeakAdminPassword('short')).toBe(true);
      expect(isWeakAdminPassword('           ')).toBe(true);
    });

    it('accepts a sufficiently strong password', () => {
      expect(isWeakAdminPassword('ConfiguredStrongPass123')).toBe(false);
    });
  });

  describe('assertRuntimeConfig', () => {
    it('accepts a strong ADMIN_INITIAL_PASSWORD', () => {
      config.initialAdminPassword = 'ConfiguredStrongPass123';
      expect(() => assertRuntimeConfig()).not.toThrow();
    });

    it('rejects the legacy hardcoded default password (CWE-798)', () => {
      config.initialAdminPassword = 'admin1234567';
      expect(() => assertRuntimeConfig()).toThrow(/ADMIN_INITIAL_PASSWORD is too weak/);
    });

    it('rejects the publicly documented dev default password (问题 47)', () => {
      config.initialAdminPassword = 'dev-admin-init-password';
      expect(() => assertRuntimeConfig()).toThrow(/ADMIN_INITIAL_PASSWORD is too weak/);
    });

    it('rejects a too-short configured password', () => {
      config.initialAdminPassword = 'short';
      expect(() => assertRuntimeConfig()).toThrow(/ADMIN_INITIAL_PASSWORD is too weak/);
    });

    it('rejects a whitespace-only configured password', () => {
      config.initialAdminPassword = '           ';
      expect(() => assertRuntimeConfig()).toThrow(/ADMIN_INITIAL_PASSWORD is too weak/);
    });

    it('allows an unset initial password (random generation path)', () => {
      config.initialAdminPassword = '';
      expect(() => assertRuntimeConfig()).not.toThrow();
    });

    it('rejects the publicly documented dev default ADMIN_JWT_SECRET (问题 47)', () => {
      config.adminJwtSecret = 'dev-admin-secret-change-in-production';
      expect(() => assertRuntimeConfig()).toThrow(/ADMIN_JWT_SECRET is a known default\/weak secret/);
    });

    it('accepts a strong ADMIN_JWT_SECRET', () => {
      config.adminJwtSecret = 'a'.repeat(48);
      expect(() => assertRuntimeConfig()).not.toThrow();
    });
  });
});
