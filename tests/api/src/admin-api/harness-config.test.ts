import { describe, it, expect, beforeAll } from 'vitest';
import { adminGql, ensureAdminLogin } from './helpers.js';

/**
 * Harness 平台配置后台 API（T-HCA-API1 / T-HCA-API2）。
 *
 * 契约：`contracts/admin-harness.graphql`
 * - `harnessconfigs` 唯一写方 admin-api；agent-api 只读镜像；
 * - `adminHarnessConfigs` 恒返回三 Harness（未配置以默认 `/compact` 归一）；
 * - `upsertHarnessConfig` 校验失败逐字 `invalid compact command`。
 */
const ADMIN_HARNESS_CONFIGS = `
  query AdminHarnessConfigs {
    adminHarnessConfigs { harnessType compactCommand updatedAt }
  }
`;

const UPSERT_HARNESS_CONFIG = `
  mutation UpsertHarnessConfig($harnessType: HarnessType!, $compactCommand: String!) {
    upsertHarnessConfig(harnessType: $harnessType, compactCommand: $compactCommand) {
      harnessType compactCommand updatedAt
    }
  }
`;

const HARNESS_TYPES = ['OPENCODE', 'KIMI_CODE', 'DEEPSEEK_HARNESS'] as const;

interface HarnessConfigData {
  harnessType: string;
  compactCommand: string;
  updatedAt: string;
}

describe('Admin Harness Config API (T-HCA-API)', () => {
  let token = '';

  beforeAll(async () => {
    token = await ensureAdminLogin();
    expect(token).toBeTruthy();
  }, 30_000);

  it('T-HCA-API1: 未认证 → Not authenticated；认证后返回三 Harness（默认 /compact）', async () => {
    const anonymous = await adminGql<{ adminHarnessConfigs: HarnessConfigData[] }>(ADMIN_HARNESS_CONFIGS);
    expect(anonymous.errors?.[0]?.message).toBe('Not authenticated');

    const authed = await adminGql<{ adminHarnessConfigs: HarnessConfigData[] }>(ADMIN_HARNESS_CONFIGS, undefined, token);
    expect(authed.errors).toBeUndefined();
    const configs = authed.data!.adminHarnessConfigs;
    expect(configs.map((c) => c.harnessType).sort()).toEqual([...HARNESS_TYPES].sort());
    for (const config of configs) {
      expect(typeof config.compactCommand).toBe('string');
      expect(config.compactCommand.startsWith('/')).toBe(true);
      expect(config.updatedAt).toBeTruthy();
    }
  }, 30_000);

  it('T-HCA-API2: 校验矩阵逐字 invalid compact command；合法 upsert 后回读；重复 upsert 幂等更新', async () => {
    const invalidValues = ['', '   ', 'x'.repeat(65), 'compact'];
    for (const value of invalidValues) {
      const res = await adminGql(UPSERT_HARNESS_CONFIG, { harnessType: 'OPENCODE', compactCommand: value }, token);
      expect(res.errors?.[0]?.message).toBe('invalid compact command');
    }

    const updated = await adminGql<{ upsertHarnessConfig: HarnessConfigData }>(
      UPSERT_HARNESS_CONFIG,
      { harnessType: 'KIMI_CODE', compactCommand: '  /compact-kimi  ' },
      token,
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data!.upsertHarnessConfig).toMatchObject({
      harnessType: 'KIMI_CODE',
      // trim 后落库
      compactCommand: '/compact-kimi',
    });

    const listed = await adminGql<{ adminHarnessConfigs: HarnessConfigData[] }>(ADMIN_HARNESS_CONFIGS, undefined, token);
    const kimi = listed.data!.adminHarnessConfigs.find((c) => c.harnessType === 'KIMI_CODE');
    expect(kimi?.compactCommand).toBe('/compact-kimi');

    // 重复 upsert 幂等更新（不报「配置已存在」）
    const again = await adminGql<{ upsertHarnessConfig: HarnessConfigData }>(
      UPSERT_HARNESS_CONFIG,
      { harnessType: 'KIMI_CODE', compactCommand: '/compact-kimi-2' },
      token,
    );
    expect(again.errors).toBeUndefined();
    expect(again.data!.upsertHarnessConfig.compactCommand).toBe('/compact-kimi-2');

    // 还原为默认值，避免影响其他用例/环境
    await adminGql(UPSERT_HARNESS_CONFIG, { harnessType: 'KIMI_CODE', compactCommand: '/compact' }, token);
  }, 30_000);
});
