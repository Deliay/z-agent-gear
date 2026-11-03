import { describe, it, expect } from 'vitest';
import { createFrontUser } from '../support/front-users.js';
import { fundFrontUser } from './funding.js';

// 前台云存储 API（需要 Aspire 全量服务；cloud-controller 以 K8S_ENABLED=false 的 InMemory 实现承接 PVC）。
// 覆盖：创建/校验/列表口径/销毁/挂载占用/归档半价报价。
const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const AGENT_BASE = API_URL.replace(/\/graphql\/?$/, '');
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN;
const STORAGE_ENABLED = process.env.CLOUD_STORAGE_ENABLED !== 'false';
const HARNESS_ENABLED = process.env.HARNESS_ENABLED === 'true';

function gql(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  }).then(
    (res) =>
      res.json() as Promise<{ data?: any; errors?: Array<{ message: string }> }>,
  );
}

const CAPABILITIES = `query { cloudStorageCapabilities { enabled } }`;

const LIST = `
  query Storages($onlyAttachable: Boolean, $includeDestroyed: Boolean) {
    cloudStorages(onlyAttachable: $onlyAttachable, includeDestroyed: $includeDestroyed) {
      id name sizeGi status usageBytes usageUpdatedAt
      hourlyCredits hourlyCreditsFull hourlyCreditsArchived
      createdBy { id name }
      createdAt attachedCloudHostId attachedCloudHostName attachedAt
      currentArchive { id fileName status usageBytes startedAt finishedAt failureReason }
      archiveSpace { capacityGi usedGi }
      failureReason destroyedAt
    }
  }
`;

const DETAIL = `
  query Storage($id: ID!) {
    cloudStorage(id: $id) {
      id name sizeGi status hourlyCredits hourlyCreditsFull hourlyCreditsArchived
      currentArchive { id fileName status sourcePvcReleased }
      archiveSpace { capacityGi usedGi }
    }
  }
`;

const QUOTE = `
  query Quote($sizeGi: Int) {
    cloudStorageBillingQuote(sizeGi: $sizeGi) {
      sizeGi availableBalance
      full { hourlyCredits tiers { label amountCredits } }
      archived { hourlyCredits tiers { label amountCredits } }
    }
  }
`;

const CREATE = `
  mutation Create($input: CreateCloudStorageInput!) {
    createCloudStorage(input: $input) {
      id name sizeGi status hourlyCredits hourlyCreditsFull hourlyCreditsArchived
      createdBy { id name } createdAt destroyedAt failureReason
    }
  }
`;

const DESTROY = `mutation Destroy($id: ID!) { destroyCloudStorage(id: $id) { id status destroyedAt } }`;
const RETRY = `mutation Retry($id: ID!) { retryCloudStorageArchive(id: $id) { id status currentArchive { id status } } }`;
const REFRESH = `mutation Refresh($id: ID!) { refreshCloudStorageUsage(id: $id) { id status usageBytes usageUpdatedAt } }`;

const CREATE_HOST = `
  mutation CreateHost($input: CreateCloudHostInput!) {
    createCloudHost(input: $input) {
      id name status storage { id name sizeGi status hourlyCredits } storageRestoring
    }
  }
`;
const STOP_HOST = `mutation Stop($id: ID!, $force: Boolean) { stopCloudHost(id: $id, force: $force) { id status } }`;
const DELETE_HOST = `mutation Delete($id: ID!) { deleteCloudHost(id: $id) }`;
const MY_HOSTS = `query { myCloudHosts { id name status } }`;

async function fundedUser(): Promise<{ token: string; userId: string; username: string }> {
  const user = await createFrontUser();
  await fundFrontUser(user.userId, user.username, 10_000);
  return user;
}

async function newStorage(token: string, name: string, sizeGi = 10): Promise<{ id: string; status: string }> {
  const created = await gql(CREATE, { input: { name, sizeGi } }, token);
  expect(created.errors).toBeUndefined();
  return created.data.createCloudStorage;
}

describe.skipIf(!STORAGE_ENABLED)('Cloud Storage API', () => {
  it('T-CS-CAP: capabilities exposes storage feature', async () => {
    const { token } = await fundedUser();
    const result = await gql(CAPABILITIES, undefined, token);
    expect(result.errors).toBeUndefined();
    expect(result.data.cloudStorageCapabilities).toEqual({ enabled: true });
  });

  it('T-BILL-S1: quote boundaries match the cumulative tiers', async () => {
    const { token } = await fundedUser();
    const expected: Array<[number, number, number]> = [
      [1, 5, 2.5],
      [10, 5, 2.5],
      [11, 6, 3],
      [15, 10, 5],
      [20, 15, 7.5],
      [25, 20, 10],
      [26, 23, 11.5],
      [30, 35, 17.5],
    ];
    for (const [sizeGi, full, archived] of expected) {
      const quote = await gql(QUOTE, { sizeGi }, token);
      expect(quote.errors).toBeUndefined();
      expect(quote.data.cloudStorageBillingQuote.sizeGi).toBe(sizeGi);
      expect(quote.data.cloudStorageBillingQuote.full.hourlyCredits).toBe(full);
      expect(quote.data.cloudStorageBillingQuote.archived.hourlyCredits).toBe(archived);
      expect(quote.data.cloudStorageBillingQuote.full.tiers.length).toBeGreaterThan(0);
    }
  });

  it('T-CS1: rejects empty / over-long names and out-of-range sizes', async () => {
    const { token } = await fundedUser();
    const empty = await gql(CREATE, { input: { name: '   ', sizeGi: 10 } }, token);
    expect(empty.errors?.[0].message).toBe('storage name is required');

    const tooLong = await gql(CREATE, { input: { name: 'a'.repeat(65), sizeGi: 10 } }, token);
    expect(tooLong.errors?.[0].message).toBe('storage name is too long');

    for (const sizeGi of [0, 31]) {
      const invalid = await gql(CREATE, { input: { name: `size-${sizeGi}`, sizeGi } }, token);
      expect(invalid.errors?.[0].message).toBe('storage size must be between 1 and 30 Gi');
    }
  });

  it('T-CS2/CS4/CS5: create → IDLE, duplicate rejected, list口径', async () => {
    const { token } = await fundedUser();
    const name = `cs-${Date.now().toString(36)}`;
    const created = await newStorage(token, name, 10);
    expect(created.status).toBe('IDLE');

    const detail = await gql(DETAIL, { id: created.id }, token);
    expect(detail.errors).toBeUndefined();
    expect(detail.data.cloudStorage).toMatchObject({
      id: created.id,
      name,
      sizeGi: 10,
      status: 'IDLE',
      hourlyCredits: 5,
      hourlyCreditsFull: 5,
      hourlyCreditsArchived: 2.5,
    });
    expect(detail.data.cloudStorage.archiveSpace).toEqual({ capacityGi: 100, usedGi: null });

    // 同工作区重名（大小写不敏感）拒绝
    const duplicate = await gql(CREATE, { input: { name: name.toUpperCase(), sizeGi: 10 } }, token);
    expect(duplicate.errors?.[0].message).toBe('storage name already exists');

    const list = await gql(LIST, { onlyAttachable: true, includeDestroyed: false }, token);
    expect(list.errors).toBeUndefined();
    const ids = list.data.cloudStorages.map((item: { id: string }) => item.id);
    expect(ids).toContain(created.id);
    expect(list.data.cloudStorages.every((item: { status: string }) => ['IDLE', 'ARCHIVED'].includes(item.status))).toBe(true);
  });

  it('T-CS6/CS7: destroy only idle/archived, then moves into the destroyed fold', async () => {
    const { token } = await fundedUser();
    const name = `destroy-${Date.now().toString(36)}`;
    const created = await newStorage(token, name, 5);

    const destroyed = await gql(DESTROY, { id: created.id }, token);
    expect(destroyed.errors).toBeUndefined();
    expect(destroyed.data.destroyCloudStorage.status).toBe('DESTROYED');
    expect(typeof destroyed.data.destroyCloudStorage.destroyedAt).toBe('string');

    const hidden = await gql(LIST, { includeDestroyed: false }, token);
    expect(hidden.data.cloudStorages.map((item: { id: string }) => item.id)).not.toContain(created.id);

    const folded = await gql(LIST, { includeDestroyed: true }, token);
    const found = folded.data.cloudStorages.find((item: { id: string }) => item.id === created.id);
    expect(found?.status).toBe('DESTROYED');

    // 销毁后同名允许重建（名称随 destroyedAt 释放）
    const again = await gql(CREATE, { input: { name, sizeGi: 5 } }, token);
    expect(again.errors).toBeUndefined();
  });

  it('T-CS6: destroy unknown storage → storage not found', async () => {
    const { token } = await fundedUser();
    const missing = await gql(DESTROY, { id: '000000000000000000000000' }, token);
    expect(missing.errors?.[0].message).toBe('storage not found');
  });

  it('T-CS-A2/AR5: refresh/retry reject non-attached storage', async () => {
    const { token } = await fundedUser();
    const created = await newStorage(token, `refresh-${Date.now().toString(36)}`, 5);
    const refreshed = await gql(REFRESH, { id: created.id }, token);
    expect(refreshed.errors?.[0].message).toBe('storage is not attached');

    const retried = await gql(RETRY, { id: created.id }, token);
    expect(retried.errors?.[0].message).toBe('no archive to retry');
  });

  testMounting();
});

function testMounting(): void {
  describe.skipIf(!HARNESS_ENABLED || !INTERNAL_TOKEN)('Cloud Storage mounting', () => {
    it('T-CS-A1/A3: attaches to exactly one cloud host and blocks destroy while attached', async () => {
      const { token } = await fundedUser();
      const storage = await newStorage(token, `mount-${Date.now().toString(36)}`, 8);

      const first = await gql(
        CREATE_HOST,
        { input: { name: `host-${Date.now().toString(36)}`, harnessTypes: [], storageId: storage.id } },
        token,
      );
      expect(first.errors).toBeUndefined();
      const hostId = first.data.createCloudHost.id;
      expect(first.data.createCloudHost.storage).toMatchObject({
        id: storage.id,
        sizeGi: 8,
        status: 'ATTACHED',
      });
      expect(first.data.createCloudHost.storageRestoring).toBe(false);

      // 已被挂载 → 不再是可挂载候选
      const attachable = await gql(LIST, { onlyAttachable: true }, token);
      expect(attachable.data.cloudStorages.map((item: { id: string }) => item.id)).not.toContain(storage.id);

      // 并发/重复挂载被拒绝
      const second = await gql(
        CREATE_HOST,
        { input: { name: `host2-${Date.now().toString(36)}`, harnessTypes: [], storageId: storage.id } },
        token,
      );
      expect(second.errors?.[0].message).toBe('storage is not attachable');

      // 已挂载不可销毁
      const blocked = await gql(DESTROY, { id: storage.id }, token);
      expect(blocked.errors?.[0].message).toBe('storage is attached');

      // 清理：停止并删除云电脑
      await gql(STOP_HOST, { id: hostId, force: true }, token);
      await gql(DELETE_HOST, { id: hostId }, token);
    });

    it('T-CS-AR1/AR2: stopping the host archives the storage and switches to half price', async () => {
      const { token } = await fundedUser();
      const storage = await newStorage(token, `archive-${Date.now().toString(36)}`, 6);
      const created = await gql(
        CREATE_HOST,
        { input: { name: `host-${Date.now().toString(36)}`, harnessTypes: ['OPENCODE'], storageId: storage.id } },
        token,
      );
      expect(created.errors).toBeUndefined();
      const hostId = created.data.createCloudHost.id;

      // 模拟 cloud-controller 销毁完成后的 terminal 回调（K8S_ENABLED=false 时无真实 worker 上线，
      // 归档触发不会自动发生）：先 ready（设置 readyAt，归档联动才生效），再 terminal 携带
      // storage.archiveStatus=pending → ATTACHED→ARCHIVING，同时把云电脑推进到 STOPPED。
      const ready = await fetch(`${AGENT_BASE}/internal/cloud-hosts/${hostId}/ready`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INTERNAL_TOKEN}` },
        body: JSON.stringify({}),
      });
      expect(ready.status).toBe(200);

      const terminal = await fetch(`${AGENT_BASE}/internal/cloud-hosts/${hostId}/terminal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INTERNAL_TOKEN}` },
        body: JSON.stringify({ status: 'stopped', storage: { id: storage.id, archiveStatus: 'pending' } }),
      });
      expect(terminal.status).toBe(200);

      let status = '';
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const detail = await gql(DETAIL, { id: storage.id }, token);
        status = detail.data?.cloudStorage?.status ?? '';
        if (status === 'ARCHIVING') break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(status).toBe('ARCHIVING');

      const archiveId = 'b'.repeat(24);
      const callback = await fetch(`${AGENT_BASE}/internal/cloud-storages/${storage.id}/archives`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INTERNAL_TOKEN}` },
        body: JSON.stringify({
          archiveId,
          storageId: storage.id,
          cloudHostId: hostId,
          fileName: 'my-host-20261102-153012.tar.gz2',
          path: `/archive/${'a'.repeat(24)}/${storage.id}/my-host-20261102-153012.tar.gz2`,
          status: 'SUCCEEDED',
          usageBytes: 5368709120,
          sourcePvcReleased: false,
        }),
      });
      expect(callback.status).toBe(200);

      const archived = await gql(DETAIL, { id: storage.id }, token);
      expect(archived.data.cloudStorage.status).toBe('ARCHIVED');
      expect(archived.data.cloudStorage.hourlyCredits).toBe(2.5); // 6Gi 全价 5（≤10Gi 固定档）→ 归档半价 2.5
      expect(archived.data.cloudStorage.currentArchive.status).toBe('SUCCEEDED');
      expect(archived.data.cloudStorage.currentArchive.sourcePvcReleased).toBe(false);

      // 第二轮：已归档 → 再挂载（费率回 FULL）→ 再归档（新 archiveId 不被旧 SUCCEEDED 阻断）
      const second = await gql(
        CREATE_HOST,
        { input: { name: `host2-${Date.now().toString(36)}`, harnessTypes: ['OPENCODE'], storageId: storage.id } },
        token,
      );
      expect(second.errors).toBeUndefined();
      const hostId2 = second.data.createCloudHost.id;
      const attachedAgain = await gql(DETAIL, { id: storage.id }, token);
      expect(attachedAgain.data.cloudStorage.status).toBe('ATTACHED');
      // 挂载期间按全价（不是归档半价）
      expect(attachedAgain.data.cloudStorage.hourlyCredits).toBe(5);

      const ready2 = await fetch(`${AGENT_BASE}/internal/cloud-hosts/${hostId2}/ready`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INTERNAL_TOKEN}` },
        body: JSON.stringify({}),
      });
      expect(ready2.status).toBe(200);
      const archiveId2 = 'd'.repeat(24);
      const terminal2 = await fetch(`${AGENT_BASE}/internal/cloud-hosts/${hostId2}/terminal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INTERNAL_TOKEN}` },
        body: JSON.stringify({
          status: 'stopped',
          storage: { id: storage.id, archiveStatus: 'pending', archiveId: archiveId2 },
        }),
      });
      expect(terminal2.status).toBe(200);

      const callback2 = await fetch(`${AGENT_BASE}/internal/cloud-storages/${storage.id}/archives`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INTERNAL_TOKEN}` },
        body: JSON.stringify({
          archiveId: archiveId2,
          storageId: storage.id,
          cloudHostId: hostId2,
          fileName: 'my-host-20261102-160000.tar.gz2',
          path: `/archive/${'a'.repeat(24)}/${storage.id}/my-host-20261102-160000.tar.gz2`,
          status: 'SUCCEEDED',
          usageBytes: 1024,
        }),
      });
      expect(callback2.status).toBe(200);
      const archivedAgain = await gql(DETAIL, { id: storage.id }, token);
      expect(archivedAgain.data.cloudStorage.status).toBe('ARCHIVED');
      expect(archivedAgain.data.cloudStorage.currentArchive.id).toBe(archiveId2);
      expect(archivedAgain.data.cloudStorage.hourlyCredits).toBe(2.5);

      await gql(DELETE_HOST, { id: hostId2 }, token);
      await gql(DELETE_HOST, { id: hostId }, token);
    }, 60_000);
  });
}
