import { describe, it, expect, afterEach } from 'vitest';
import {
  config,
  assertRuntimeConfig,
  isWeakAdminPassword,
  normalizeTrustProxy,
  isTrustedProxy,
  ipMatchesCidr,
  parsePositiveInt,
} from './index';

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

  describe('load-workload destroy timeout config (裁决 9)', () => {
    it('defaults cloudControllerDestroyTimeoutMs to 180000', () => {
      expect(config.cloudControllerDestroyTimeoutMs).toBe(180000);
    });

    it('parsePositiveInt falls back for missing/invalid/non-positive values', () => {
      expect(parsePositiveInt(undefined, 180000)).toBe(180000);
      expect(parsePositiveInt('', 180000)).toBe(180000);
      expect(parsePositiveInt('abc', 180000)).toBe(180000);
      expect(parsePositiveInt('0', 180000)).toBe(180000);
      expect(parsePositiveInt('-5', 180000)).toBe(180000);
      expect(parsePositiveInt('250000', 180000)).toBe(250000);
    });
  });

  describe('trusted proxy specification (问题 57)', () => {
    describe('normalizeTrustProxy', () => {
      it('treats empty / false / 0 as no trusted proxy', () => {
        expect(normalizeTrustProxy(undefined)).toBe('');
        expect(normalizeTrustProxy('')).toBe('');
        expect(normalizeTrustProxy('  ')).toBe('');
        expect(normalizeTrustProxy('false')).toBe('');
        expect(normalizeTrustProxy('0')).toBe('');
      });

      it('maps legacy true/1 to loopback-only (no longer unconditional trust)', () => {
        expect(normalizeTrustProxy('true')).toBe('127.0.0.1/8,::1/128');
        expect(normalizeTrustProxy('1')).toBe('127.0.0.1/8,::1/128');
      });

      it('passes a comma-separated IP/CIDR list through', () => {
        expect(normalizeTrustProxy('10.0.0.0/8, 192.168.1.5')).toBe('10.0.0.0/8, 192.168.1.5');
      });
    });

    describe('ipMatchesCidr (master)', () => {
      const cases: Array<[string, string, boolean]> = [
        ['10.1.2.3', '10.0.0.0/8', true],
        ['10.0.0.0', '10.0.0.0/8', true],
        ['10.255.255.255', '10.0.0.0/8', true],
        ['11.0.0.1', '10.0.0.0/8', false],
        ['192.168.1.5', '192.168.1.5', true],
        ['192.168.1.6', '192.168.1.5', false],
        ['172.16.0.1', '172.16.0.0/12', true],
        ['172.32.0.1', '172.16.0.0/12', false],
        ['8.8.8.8', '0.0.0.0/0', true],
        ['10.0.0.1', '10.0.0.0/33', false],
        ['10.0.0.1', '10.0.0.0/abc', false],
        ['10.0.0.1', 'not-an-ip', false],
        // IPv4-mapped IPv6 peer
        ['::ffff:10.1.2.3', '10.0.0.0/8', true],
        // IPv6 exact / /128
        ['::1', '::1', true],
        ['::2', '::1', false],
        ['::1', '::1/128', true],
        ['::1', '::1/64', false],
      ];

      it.each(cases)('ipMatchesCidr(%s, %s) === %s', (ip, cidr, expected) => {
        expect(ipMatchesCidr(ip, cidr)).toBe(expected);
      });
    });

    describe('isTrustedProxy', () => {
      it('parses a comma-separated list and rejects unknown / missing peers', () => {
        const list = '10.0.0.0/8, 192.168.1.5';
        expect(isTrustedProxy('10.9.9.9', list)).toBe(true);
        expect(isTrustedProxy('192.168.1.5', list)).toBe(true);
        expect(isTrustedProxy('192.168.1.6', list)).toBe(false);
        expect(isTrustedProxy(undefined, list)).toBe(false);
        expect(isTrustedProxy(null, list)).toBe(false);
        expect(isTrustedProxy('', list)).toBe(false);
      });

      it('treats an unparseable value (e.g. legacy true) as no trusted proxy', () => {
        expect(isTrustedProxy('10.0.0.1', 'true')).toBe(false);
        expect(isTrustedProxy('10.0.0.1', '')).toBe(false);
      });
    });
  });
});
