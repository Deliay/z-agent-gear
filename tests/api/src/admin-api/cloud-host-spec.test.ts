import { describe, it, expect, beforeAll } from 'vitest';
import { adminGql, ensureAdminLogin } from './helpers.js';

/**
 * 容器规格后台 API（T-SP-API1）：admin-api 唯一写方 CRUD 与错误文案逐字。
 * 契约：contracts/admin-cloud-spec.graphql；迁移 025 预制 6 款规格。
 */
const ADMIN_SPECS = `
  query {
    adminCloudSpecs {
      id name cpu memoryGi ephemeralStorageGi unlimited whitelistEnabled
      allowedTenantIds isPreset presetKey createdAt updatedAt
    }
  }
`;

const CREATE = `
  mutation Create($input: AdminCloudSpecInput!) {
    adminCreateCloudSpec(input: $input) {
      id name cpu memoryGi ephemeralStorageGi unlimited whitelistEnabled allowedTenantIds isPreset
    }
  }
`;

const UPDATE = `
  mutation Update($id: ID!, $input: AdminCloudSpecInput!) {
    adminUpdateCloudSpec(id: $id, input: $input) {
      id name cpu memoryGi ephemeralStorageGi whitelistEnabled allowedTenantIds
    }
  }
`;

const DELETE = `mutation Delete($id: ID!) { adminDeleteCloudSpec(id: $id) }`;
const DETAIL = `query Detail($id: ID!) { adminCloudSpec(id: $id) { id name } }`;

interface AdminSpec {
  id: string;
  name: string;
  cpu: number;
  memoryGi: number;
  ephemeralStorageGi: number;
  unlimited: boolean;
  whitelistEnabled: boolean;
  allowedTenantIds: string[];
  isPreset: boolean;
  presetKey: string | null;
}

describe('Admin Cloud Spec API (T-SP-API1)', () => {
  let token = '';

  beforeAll(async () => {
    token = await ensureAdminLogin();
    expect(token).toBeTruthy();
  }, 30_000);

  it('未认证 → Not authenticated；认证后可读 6 款预制规格（0C 0G 默认白名单空名单）', async () => {
    const anonymous = await adminGql<{ adminCloudSpecs: AdminSpec[] }>(ADMIN_SPECS);
    expect(anonymous.errors?.[0]?.message).toBe('Not authenticated');

    const authed = await adminGql<{ adminCloudSpecs: AdminSpec[] }>(ADMIN_SPECS, undefined, token);
    expect(authed.errors).toBeUndefined();
    const specs = authed.data!.adminCloudSpecs;
    expect(specs.length).toBeGreaterThanOrEqual(6);
    const unlimited = specs.find((spec) => spec.presetKey === 'unlimited-0c0g');
    expect(unlimited).toMatchObject({
      name: '0C 0G 0G',
      cpu: 0,
      memoryGi: 0,
      ephemeralStorageGi: 0,
      unlimited: true,
      whitelistEnabled: true,
      allowedTenantIds: [],
    });
    const preset8 = specs.find((spec) => spec.presetKey === '8c16g-20g');
    expect(preset8).toMatchObject({ name: '8C 16G 20G', cpu: 8, memoryGi: 16, ephemeralStorageGi: 20 });
  }, 30_000);

  it('创建/更新/删除全流程与错误文案逐字', async () => {
    const name = `api-spec-${Date.now().toString(36)}`;
    const created = await adminGql<{ adminCreateCloudSpec: AdminSpec }>(
      CREATE,
      {
        input: {
          name: `  ${name}  `,
          cpu: 2,
          memoryGi: 4,
          ephemeralStorageGi: 10,
          whitelistEnabled: false,
          allowedTenantIds: [],
        },
      },
      token,
    );
    expect(created.errors).toBeUndefined();
    const spec = created.data!.adminCreateCloudSpec;
    expect(spec).toMatchObject({ name, cpu: 2, memoryGi: 4, ephemeralStorageGi: 10, unlimited: false });
    expect(spec.isPreset).toBe(false);

    // 名称唯一
    const duplicate = await adminGql(CREATE, {
      input: {
        name,
        cpu: 2,
        memoryGi: 4,
        ephemeralStorageGi: 10,
        whitelistEnabled: false,
        allowedTenantIds: [],
      },
    }, token);
    expect(duplicate.errors?.[0]?.message).toBe('spec name already exists');

    // 非法组合（部分为 0）与超上限
    for (const input of [
      { name: `${name}-bad1`, cpu: 0, memoryGi: 4, ephemeralStorageGi: 10 },
      { name: `${name}-bad2`, cpu: 65, memoryGi: 4, ephemeralStorageGi: 10 },
      { name: `${name}-bad3`, cpu: 2, memoryGi: 4, ephemeralStorageGi: 513 },
    ]) {
      const invalid = await adminGql(CREATE, {
        input: { ...input, whitelistEnabled: false, allowedTenantIds: [] },
      }, token);
      expect(invalid.errors?.[0]?.message).toBe('invalid spec resources');
    }

    // 名称必填/超长
    for (const [badName, message] of [
      ['   ', 'name is required'],
      ['x'.repeat(65), 'name is too long'],
    ] as const) {
      const invalid = await adminGql(CREATE, {
        input: { name: badName, cpu: 2, memoryGi: 4, ephemeralStorageGi: 10, whitelistEnabled: false, allowedTenantIds: [] },
      }, token);
      expect(invalid.errors?.[0]?.message).toBe(message);
    }

    // 更新（白名单开启但租户不存在 → 逐字错误）
    const missingTenant = '507f1f77bcf86cd7994390ff';
    const badWhitelist = await adminGql(UPDATE, {
      id: spec.id,
      input: {
        name,
        cpu: 2,
        memoryGi: 4,
        ephemeralStorageGi: 10,
        whitelistEnabled: true,
        allowedTenantIds: [missingTenant],
      },
    }, token);
    expect(badWhitelist.errors?.[0]?.message).toBe('invalid tenant in whitelist');

    const updated = await adminGql<{ adminUpdateCloudSpec: AdminSpec }>(
      UPDATE,
      {
        id: spec.id,
        input: {
          name: `${name}-v2`,
          cpu: 4,
          memoryGi: 8,
          ephemeralStorageGi: 20,
          whitelistEnabled: false,
          allowedTenantIds: [],
        },
      },
      token,
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data!.adminUpdateCloudSpec).toMatchObject({ name: `${name}-v2`, cpu: 4 });

    expect((await adminGql(DETAIL, { id: spec.id }, token)).data!.adminCloudSpec.name).toBe(
      `${name}-v2`,
    );

    const deleted = await adminGql<{ adminDeleteCloudSpec: boolean }>(DELETE, { id: spec.id }, token);
    expect(deleted.errors).toBeUndefined();
    expect(deleted.data!.adminDeleteCloudSpec).toBe(true);
    expect((await adminGql(DETAIL, { id: spec.id }, token)).data!.adminCloudSpec).toBeNull();
  }, 60_000);
});
