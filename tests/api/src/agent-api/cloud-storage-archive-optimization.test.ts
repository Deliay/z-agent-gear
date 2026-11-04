import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { createFrontUser } from '../support/front-users.js';
import { fundFrontUser } from './funding.js';

// 云存储归档优化 API（需要 Aspire 全量服务；cloud-controller 以 K8S_ENABLED=false 的 InMemory 承接 PVC/Job）。
// 覆盖 API-CSO1（停止不归档 → IDLE）与 API-CSO2（手动归档 → 半价 / 复原 → IDLE / fork → 新存储）。
const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const AGENT_BASE = API_URL.replace(/\/graphql\/?$/, '');
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN;
const MONGO_URI = process.env.MONGODB_URI;
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

const CREATE_STORAGE = `
  mutation Create($input: CreateCloudStorageInput!) {
    createCloudStorage(input: $input) { id name sizeGi status }
  }
`;
const DETAIL = `
  query Storage($id: ID!) {
    cloudStorage(id: $id) {
      id name sizeGi status hourlyCredits hourlyCreditsFull
      currentArchive { id fileName status usageBytes }
      currentRestore { id status failureReason }
      forkedFromStorageId
    }
  }
`;
const ARCHIVE = `mutation($id: ID!) { archiveCloudStorage(id: $id) { id status } }`;
const RESTORE = `mutation($id: ID!) { restoreCloudStorageToArchive(id: $id) { id status currentRestore { id status } } }`;
const FORK = `mutation($id: ID!, $input: ForkCloudStorageInput!) {
  forkCloudStorage(id: $id, input: $input) { id name sizeGi status forkedFromStorageId }
}`;
const CREATE_HOST = `
  mutation CreateHost($input: CreateCloudHostInput!) {
    createCloudHost(input: $input) { id name status containerId storage { id status } }
  }
`;
const STOP_HOST = `
  mutation Stop($id: ID!, $force: Boolean, $archiveStorage: Boolean) {
    stopCloudHost(id: $id, force: $force, archiveStorage: $archiveStorage) { id status }
  }
`;

async function fundedUser(): Promise<{ token: string; userId: string; username: string }> {
  const user = await createFrontUser();
  await fundFrontUser(user.userId, user.username, 10_000);
  return user;
}

async function newStorage(token: string, name: string, sizeGi = 10): Promise<{ id: string }> {
  const created = await gql(CREATE_STORAGE, { input: { name, sizeGi } }, token);
  expect(created.errors).toBeUndefined();
  return created.data.createCloudStorage;
}

async function mongoConnect(): Promise<void> {
  if (mongoose.connection.readyState === 0) await mongoose.connect(MONGO_URI!);
}

async function storageDoc(id: string): Promise<any> {
  await mongoConnect();
  return mongoose.connection
    .collection('cloudstorages')
    .findOne({ _id: new mongoose.Types.ObjectId(id) });
}

async function waitForStorageStatus(
  token: string,
  id: string,
  expected: string,
  timeoutMs = 15_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let latest: any = null;
  while (Date.now() < deadline) {
    const detail = await gql(DETAIL, { id }, token);
    latest = detail.data?.cloudStorage;
    if (latest?.status === expected) return latest;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return latest;
}

async function postInternal(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${AGENT_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INTERNAL_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!STORAGE_ENABLED || !INTERNAL_TOKEN || !MONGO_URI)(
  'Cloud Storage Archive Optimization API',
  () => {
    it.skipIf(!HARNESS_ENABLED)(
      'API-CSO1: stopCloudHost(archiveStorage:false) → 跳过归档标记 + 存储 ATTACHED→IDLE（全价、数据保留）',
      async () => {
        const { token } = await fundedUser();
        const storage = await newStorage(token, `no-archive-${Date.now().toString(36)}`, 10);
        const created = await gql(
          CREATE_HOST,
          {
            input: {
              name: `host-${Date.now().toString(36)}`,
              harnessTypes: ['OPENCODE'],
              storageId: storage.id,
            },
          },
          token,
        );
        expect(created.errors).toBeUndefined();
        const host = created.data.createCloudHost;
        const containerId = host.containerId;
        expect(containerId).toBeTruthy();
        expect(host.storage).toMatchObject({ id: storage.id, status: 'ATTACHED' });

        // ready：让 terminal 联动进入「已 ready」分支（归档/不归档判定前提）。
        const ready = await postInternal(`/internal/cloud-hosts/${host.id}/ready`, {});
        expect(ready.status).toBe(200);

        const stopped = await gql(
          STOP_HOST,
          { id: host.id, force: false, archiveStorage: false },
          token,
        );
        expect(stopped.errors).toBeUndefined();

        // cloud-controller 跳过标记（P1 端到端）：destroy body storageArchive:false 已落库。
        await mongoConnect();
        const container = await mongoose.connection
          .collection('cloudcontainers')
          .findOne({ _id: new mongoose.Types.ObjectId(String(containerId)) });
        expect(container?.storageArchiveSkipped).toBe(true);

        // 模拟 destroy 后 terminal 回调（K8S_ENABLED=false 无真实 worker，由测试投递）。
        const terminal = await postInternal(`/internal/cloud-hosts/${host.id}/terminal`, {
          status: 'stopped',
          storage: { id: storage.id, archiveStatus: null, archiveSkipped: true },
        });
        expect(terminal.status).toBe(200);

        const detail = await waitForStorageStatus(token, storage.id, 'IDLE');
        expect(detail?.status).toBe('IDLE');
        expect(detail?.hourlyCredits).toBe(detail?.hourlyCreditsFull);
        expect(detail?.currentArchive ?? null).toBeNull();
      },
      60_000,
    );

    it(
      'API-CSO2: 手动归档 → 半价；复原 → IDLE；fork → 新存储 IDLE',
      async () => {
        const { token } = await fundedUser();
        const source = await newStorage(token, `archive-${Date.now().toString(36)}`, 10);

        // 手动归档：CAS → ARCHIVING，cloud-controller 存储级 Job 在 InMemory 下不自动完成，
        // 由测试投递与真实 archiver Job 相同的归档成功回调。
        const archived = await gql(ARCHIVE, { id: source.id }, token);
        expect(archived.errors).toBeUndefined();
        let doc = await storageDoc(source.id);
        expect(doc?.status).toBe('ARCHIVING');
        const opId = doc?.currentArchive?.operationId;
        expect(opId).toMatch(/^[a-f0-9]{24}$/);

        const archiveCallback = await postInternal(
          `/internal/cloud-storages/${source.id}/archives`,
          {
            archiveId: doc.currentArchive.archiveId,
            operationId: opId,
            storageId: source.id,
            fileName: doc.currentArchive.fileName,
            path: doc.currentArchive.path,
            status: 'SUCCEEDED',
            usageBytes: 5_368_709_120,
            sourcePvcReleased: true,
          },
        );
        expect(archiveCallback.status).toBe(200);
        let detail = await waitForStorageStatus(token, source.id, 'ARCHIVED');
        expect(detail?.status).toBe('ARCHIVED');
        expect(detail?.hourlyCredits).toBe(detail?.hourlyCreditsFull / 2);
        expect(detail?.currentArchive?.status).toBe('SUCCEEDED');

        // fork：源归档复制新存储；同样投递 restores SUCCEEDED 回调完成 CREATING→IDLE。
        const forkName = `fork-${Date.now().toString(36)}`;
        const forked = await gql(FORK, { id: source.id, input: { name: forkName } }, token);
        expect(forked.errors).toBeUndefined();
        const forkStorage = forked.data.forkCloudStorage;
        expect(forkStorage).toMatchObject({
          name: forkName,
          sizeGi: source.sizeGi,
          status: 'CREATING',
          forkedFromStorageId: source.id,
        });
        let forkDoc = await storageDoc(forkStorage.id);
        const forkOpId = forkDoc?.currentRestore?.operationId;
        expect(forkOpId).toMatch(/^[a-f0-9]{24}$/);
        const forkRestoreCallback = await postInternal(
          `/internal/cloud-storages/${forkStorage.id}/restores`,
          { operationId: forkOpId, storageId: forkStorage.id, status: 'SUCCEEDED' },
        );
        expect(forkRestoreCallback.status).toBe(200);
        const forkDetail = await waitForStorageStatus(token, forkStorage.id, 'IDLE');
        expect(forkDetail?.status).toBe('IDLE');
        expect(forkDetail?.forkedFromStorageId).toBe(source.id);

        // 复原到归档：ARCHIVED 需先回到 IDLE；直写测试夹具（等价于重新挂载后停止不归档/或新建）。
        await mongoConnect();
        await mongoose.connection.collection('cloudstorages').updateOne(
          { _id: new mongoose.Types.ObjectId(source.id) },
          { $set: { status: 'IDLE' } },
        );
        const restored = await gql(RESTORE, { id: source.id }, token);
        expect(restored.errors).toBeUndefined();
        doc = await storageDoc(source.id);
        const restoreOpId = doc?.currentRestore?.operationId;
        expect(restoreOpId).toMatch(/^[a-f0-9]{24}$/);
        const restoreCallback = await postInternal(
          `/internal/cloud-storages/${source.id}/restores`,
          { operationId: restoreOpId, storageId: source.id, status: 'SUCCEEDED', usageBytes: 1024 },
        );
        expect(restoreCallback.status).toBe(200);
        detail = await waitForStorageStatus(token, source.id, 'IDLE');
        expect(detail?.status).toBe('IDLE');
        expect(detail?.currentRestore ?? null).toBeNull();
      },
      90_000,
    );
  },
);
