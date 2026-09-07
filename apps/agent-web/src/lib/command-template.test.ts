import { describe, it, expect } from 'vitest';
import { buildControllerCommand, type Pm2Result } from './command-template';

describe('buildControllerCommand', () => {
  const testKey = 'test-controller-key-123';

  describe('npm', () => {
    it('global region', () => {
      const result = buildControllerCommand({ pm: 'npm', region: 'global', key: testKey });
      expect(result).toBe(
        `npx agent-gear --key ${testKey} --server https://zag-ctrl-api.fffdan.com`
      );
    });

    it('cn region', () => {
      const result = buildControllerCommand({ pm: 'npm', region: 'cn', key: testKey });
      expect(result).toBe(
        `npx agent-gear --key ${testKey} --server https://ctrl.zag.cn.fffdan.com`
      );
    });
  });

  describe('pnpm', () => {
    it('global region', () => {
      const result = buildControllerCommand({ pm: 'pnpm', region: 'global', key: testKey });
      expect(result).toBe(
        `pnpm dlx agent-gear --key ${testKey} --server https://zag-ctrl-api.fffdan.com`
      );
    });

    it('cn region', () => {
      const result = buildControllerCommand({ pm: 'pnpm', region: 'cn', key: testKey });
      expect(result).toBe(
        `pnpm dlx agent-gear --key ${testKey} --server https://ctrl.zag.cn.fffdan.com`
      );
    });
  });

  describe('bun', () => {
    it('global region', () => {
      const result = buildControllerCommand({ pm: 'bun', region: 'global', key: testKey });
      expect(result).toBe(
        `bunx agent-gear --key ${testKey} --server https://zag-ctrl-api.fffdan.com`
      );
    });

    it('cn region', () => {
      const result = buildControllerCommand({ pm: 'bun', region: 'cn', key: testKey });
      expect(result).toBe(
        `bunx agent-gear --key ${testKey} --server https://ctrl.zag.cn.fffdan.com`
      );
    });
  });

  describe('pm2', () => {
    it('global region', () => {
      const result = buildControllerCommand({ pm: 'pm2', region: 'global', key: testKey }) as Pm2Result;
      expect(result).toHaveProperty('installHint');
      expect(result).toHaveProperty('pm2ConfigJson');
      expect(result.installHint).toBe('npm install -g agent-gear');

      const config = JSON.parse(result.pm2ConfigJson);
      expect(config).toEqual({
        apps: [
          {
            name: 'agent-gear',
            script: 'agent-gear',
            env: {
              ZAG_CONTROLLER_KEY: testKey,
              ZAG_SERVER_ENDPOINT: 'https://zag-ctrl-api.fffdan.com',
            },
          },
        ],
      });
    });

    it('cn region', () => {
      const result = buildControllerCommand({ pm: 'pm2', region: 'cn', key: testKey }) as Pm2Result;
      expect(result).toHaveProperty('installHint');
      expect(result).toHaveProperty('pm2ConfigJson');
      expect(result.installHint).toBe('npm install -g agent-gear');

      const config = JSON.parse(result.pm2ConfigJson);
      expect(config).toEqual({
        apps: [
          {
            name: 'agent-gear',
            script: 'agent-gear',
            env: {
              ZAG_CONTROLLER_KEY: testKey,
              ZAG_SERVER_ENDPOINT: 'https://ctrl.zag.cn.fffdan.com',
            },
          },
        ],
      });
    });

    it('pm2 config JSON contains ZAG_CONTROLLER_KEY', () => {
      const result = buildControllerCommand({ pm: 'pm2', region: 'global', key: testKey }) as Pm2Result;
      expect(result.pm2ConfigJson).toContain('ZAG_CONTROLLER_KEY');
    });

    it('pm2 config JSON contains ZAG_SERVER_ENDPOINT', () => {
      const result = buildControllerCommand({ pm: 'pm2', region: 'global', key: testKey }) as Pm2Result;
      expect(result.pm2ConfigJson).toContain('ZAG_SERVER_ENDPOINT');
    });

    it('pm2 config JSON is parseable', () => {
      const result = buildControllerCommand({ pm: 'pm2', region: 'global', key: testKey }) as Pm2Result;
      expect(() => JSON.parse(result.pm2ConfigJson)).not.toThrow();
    });
  });
});