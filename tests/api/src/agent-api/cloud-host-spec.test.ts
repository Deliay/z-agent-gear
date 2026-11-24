import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { adminGql, ensureAdminLogin } from '../admin-api/helpers.js';
import { createFrontUser } from '../support/front-users.js';
import { fundFrontUser } from './funding.js';

/**
 * 前台容器规格 API（T-SP-API2/3/4）：
 * 可见性过滤、创建链路 specId 服务端强制校验、规格报价。
 * 需要 Aspire 全量服务 + HARNESS_ENABLED=true（创建链路）。
 */
const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const HARNESS_ENABLED = process.env.HARNESS_ENABLED === 'true';

function gql(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  }).then(
    (res) => res.json() as Promise<{ data?: any; errors?: Array<{ message: string }> }>,
  );
}

const SPECS = `
  query {
    cloudHostSpecs { id name cpu memoryGi ephemeralStorageGi unlimited isPreset hourlyCredits }
  }
`;

const QUOTE = `
  query Quote($specId: ID!) {
    cloudHostSpecBillingQuote(specId: $specId) {
      hourlyCredits tiers { label amountCredits } availableBalance
    }
  }
`;

const CREATE_HOST = `
  mutation Create($input: CreateCloudHostInput!) {
    createCloudHost(input: $input) { id name status }
  }
`;

const ADMIN_CREATE = `
  mutation Create($input: AdminCloudSpecInput!) { adminCreateCloudSpec(input: $input) { id name } }
`;
const ADMIN_DELETE = `mutation Delete($id: ID!) { adminDeleteCloudSpec(id: $id) }`;

describe('Cloud Host Spec API (T-SP-API2/3/4)', () => {
  let adminToken = '';
  const createdSpecIds: string[] = [];

  beforeAll(async () => {
    adminToken = await ensureAdminLogin();
  }, 30_000);

  async function createSpec(input: Record<string, unknown>): Promise<string> {
    const result = await adminGql<{ adminCreateCloudSpec: { id: string } }>(
      ADMIN_CREATE,
      { input },
      adminToken,
    );
    expect(result.errors, JSON.stringify(result.errors)).toBeUndefined();
    const id = result.data!.adminCreateCloudSpec.id;
    createdSpecIds.push(id);
    return id;
  }

  it('T-SP-API2: 公开规格对全部租户可见；白名单规格仅命中租户可见', async () => {
    const owner = await createFrontUser();
    const other = await createFrontUser();
    const name = `vis-${Date.now().toString(36)}`;
    const whitelistId = await createSpec({
      name,
      cpu: 2,
      memoryGi: 4,
      ephemeralStorageGi: 10,
      whitelistEnabled: true,
      allowedTenantIds: [owner.tenantId],
    });

    const ownerList = await gql(SPECS, undefined, owner.token);
    expect(ownerList.errors).toBeUndefined();
    expect(ownerList.data.cloudHostSpecs.map((spec: { id: string }) => spec.id)).toContain(
      whitelistId,
    );
    // 预制公开规格（8C 16G 20G）对任意租户可见
    expect(ownerList.data.cloudHostSpecs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '8C 16G 20G', hourlyCredits: 820, isPreset: true }),
      ]),
    );

    const otherList = await gql(SPECS, undefined, other.token);
    expect(otherList.data.cloudHostSpecs.map((spec: { id: string }) => spec.id)).not.toContain(
      whitelistId,
    );
    // 白名单规格对非命中租户报价同样不可见
    const otherQuote = await gql(QUOTE, { specId: whitelistId }, other.token);
    expect(otherQuote.errors?.[0]?.message).toBe('spec not found');
  }, 60_000);

  it('T-SP-API3: 规格报价（8C 16G 20G = 820 credits/小时；0C 0G = 0）', async () => {
    const user = await createFrontUser();
    const list = await gql(SPECS, undefined, user.token);
    const eight = list.data.cloudHostSpecs.find(
      (spec: { name: string }) => spec.name === '8C 16G 20G',
    );
    expect(eight).toBeTruthy();
    const quote = await gql(QUOTE, { specId: eight.id }, user.token);
    expect(quote.errors).toBeUndefined();
    expect(quote.data.cloudHostSpecBillingQuote.hourlyCredits).toBe(820);
    expect(
      quote.data.cloudHostSpecBillingQuote.tiers.reduce(
        (acc: number, tier: { amountCredits: number }) => acc + tier.amountCredits,
        0,
      ),
    ).toBe(820);

    const unlimitedId = await createSpec({
      name: `unlimited-${Date.now().toString(36)}`,
      cpu: 0,
      memoryGi: 0,
      ephemeralStorageGi: 0,
      whitelistEnabled: true,
      allowedTenantIds: [user.tenantId],
    });
    const unlimitedQuote = await gql(QUOTE, { specId: unlimitedId }, user.token);
    expect(unlimitedQuote.errors).toBeUndefined();
    expect(unlimitedQuote.data.cloudHostSpecBillingQuote).toMatchObject({
      hourlyCredits: 0,
      tiers: [],
    });
  }, 60_000);

  it.skipIf(!HARNESS_ENABLED)('T-SP-API3: 创建链路拒绝不可见/不存在的 specId', async () => {
    const user = await createFrontUser();
    await fundFrontUser(user.userId, user.username, 10_000);
    const invisible = await createSpec({
      name: `hidden-${Date.now().toString(36)}`,
      cpu: 1,
      memoryGi: 2,
      ephemeralStorageGi: 5,
      whitelistEnabled: true,
      allowedTenantIds: [],
    });

    for (const specId of [invisible, '507f1f77bcf86cd7994390fe']) {
      const created = await gql(
        CREATE_HOST,
        { input: { name: `reject-${Date.now().toString(36)}`, harnessTypes: [], specId } },
        user.token,
      );
      expect(created.errors?.[0]?.message).toBe('spec not found');
    }
  }, 60_000);

  it.skipIf(!HARNESS_ENABLED)('T-SP-API3: 创建链路接受可见 specId 并落快照', async () => {
    const user = await createFrontUser();
    await fundFrontUser(user.userId, user.username, 10_000);
    const list = await gql(SPECS, undefined, user.token);
    const spec = list.data.cloudHostSpecs.find(
      (candidate: { name: string }) => candidate.name === '1C 2G 5G',
    ) ?? list.data.cloudHostSpecs[0];
    const created = await gql(
      CREATE_HOST,
      { input: { name: `spec-ok-${Date.now().toString(36)}`, harnessTypes: [], specId: spec.id } },
      user.token,
    );
    expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
    expect(created.data.createCloudHost.status).toBe('STARTING');
  }, 60_000);

  it.skipIf(!HARNESS_ENABLED)(
    'P1-12: cloudHost(id) 返回规格快照，规格删除后仍可展示',
    async () => {
      const user = await createFrontUser();
      await fundFrontUser(user.userId, user.username, 10_000);
      const specName = `snapshot-${Date.now().toString(36)}`;
      const specId = await createSpec({
        name: specName,
        cpu: 2,
        memoryGi: 4,
        ephemeralStorageGi: 10,
        whitelistEnabled: false,
        allowedTenantIds: [],
      });
      const created = await gql(
        CREATE_HOST,
        { input: { name: `spec-snap-${Date.now().toString(36)}`, harnessTypes: [], specId } },
        user.token,
      );
      expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
      const hostId = created.data.createCloudHost.id as string;

      const detail = `
        query Host($id: ID!) {
          cloudHost(id: $id) {
            id
            spec { id name cpu memoryGi ephemeralStorageGi unlimited hourlyCredits }
          }
        }
      `;
      const before = await gql(detail, { id: hostId }, user.token);
      expect(before.errors).toBeUndefined();
      expect(before.data.cloudHost.spec).toMatchObject({
        id: specId,
        name: specName,
        cpu: 2,
        memoryGi: 4,
        ephemeralStorageGi: 10,
      });
      expect(before.data.cloudHost.spec.hourlyCredits).toBeGreaterThan(0);

      // 删除规格后仍按 cloudhosts 快照展示（不回查规格表）
      await adminGql(ADMIN_DELETE, { id: specId }, adminToken);
      const after = await gql(detail, { id: hostId }, user.token);
      expect(after.errors).toBeUndefined();
      expect(after.data.cloudHost.spec).toMatchObject({ id: specId, name: specName, cpu: 2 });
    },
    60_000,
  );

  // 清理本套件创建的自定义规格（best-effort；预制规格不删除）
  afterAll(async () => {
    for (const id of createdSpecIds) {
      await adminGql(ADMIN_DELETE, { id }, adminToken).catch(() => undefined);
    }
  });
});
