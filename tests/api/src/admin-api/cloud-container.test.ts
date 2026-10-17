import { describe, it, expect, beforeAll } from 'vitest';
import mongoose from 'mongoose';
import { adminGql, ensureAdminLogin } from './helpers.js';

const LIST = `
  query AdminCloudContainers {
    adminCloudContainers {
      id
      name
      status
      purpose
      refId
      createdAt
      connectedAt
      exitedAt
      exitReason
      workloads { id name }
      currentWorkloadName
    }
  }
`;

const START = `
  mutation AdminStartCloudContainer($purpose: CloudContainerPurpose!, $workloadIds: [ID!]) {
    adminStartCloudContainer(purpose: $purpose, workloadIds: $workloadIds) {
      id
      name
      status
      purpose
      createdAt
      workloads { id name }
      currentWorkloadName
    }
  }
`;

const DESTROY = `
  mutation AdminDestroyCloudContainer($id: ID!) {
    adminDestroyCloudContainer(id: $id)
  }
`;

const CONTROL_PLANE = `
  query AdminCloudContainerControlPlane {
    adminCloudContainerControlPlane { online message }
  }
`;

interface ContainerNode {
  id: string;
  name: string;
  status: string;
  purpose: string;
  workloads?: Array<{ id: string; name: string }>;
  currentWorkloadName?: string | null;
}

// 工作负载挂载（T-IA*）：复用 admin-cloud-workload.graphql 的 CRUD 做前置数据。
const CREATE_WORKLOAD = `
  mutation($input: CreateCloudWorkloadInput!) {
    adminCreateCloudWorkload(input: $input) { id name }
  }
`;
const DELETE_WORKLOAD = `mutation($id: ID!) { adminDeleteCloudWorkload(id: $id) }`;

// 说明：控制面（cloud-controller）由 Aspire 以 K8S_ENABLED=false 启动（InMemoryK8sClient）。
// 因此 start 后容器处于 CREATING/CONNECTING（无真实工作容器回连），destroy 幂等返回 true。

/** 直接把容器置为在线（模拟真实回连），用于验证销毁宽限期链路；需要 MONGODB_URI。 */
async function forceContainerOnline(id: string): Promise<boolean> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return false;
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) return false;
  const result = await db
    .collection('cloudcontainers')
    .updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { status: 'online', connectedAt: new Date() } });
  return result.matchedCount > 0;
}

describe('Admin Cloud Container API', () => {
  let token = '';
  const hasMongo = Boolean(process.env.MONGODB_URI);

  beforeAll(async () => {
    token = await ensureAdminLogin();
  });

  it('T-IA5: rejects anonymous list / start / destroy', async () => {
    const list = await adminGql(LIST);
    expect(list.errors?.[0].message).toBe('Not authenticated');

    const start = await adminGql(START, { purpose: 'IDLE' });
    expect(start.errors?.[0].message).toBe('Not authenticated');

    const destroy = await adminGql(DESTROY, { id: 'x' });
    expect(destroy.errors?.[0].message).toBe('Not authenticated');
  });

  it('T-IA1: lists cloud containers via the control plane', async () => {
    const body = await adminGql<{ adminCloudContainers: ContainerNode[] }>(LIST, undefined, token);
    expect(body.errors).toBeUndefined();
    expect(Array.isArray(body.data!.adminCloudContainers)).toBe(true);
  });

  it('T-IA2: reports control plane online=true on the control-plane field', async () => {
    const body = await adminGql<{ adminCloudContainerControlPlane: { online: boolean; message: string | null } }>(
      CONTROL_PLANE,
      undefined,
      token,
    );
    expect(body.errors).toBeUndefined();
    expect(body.data!.adminCloudContainerControlPlane.online).toBe(true);
  });

  it('T-IA6: rejects non-idle purpose with explicit message', async () => {
    const body = await adminGql(START, { purpose: 'WORKFLOW' }, token);
    expect(body.errors?.[0].message).toBe('该任务类型暂未开放');
  });

  it('T-IA7: starts a container carrying workloadIds (selection order preserved)', async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const first = await adminGql<{ adminCreateCloudWorkload: { id: string; name: string } }>(
      CREATE_WORKLOAD,
      { input: { name: `mount-a-${suffix}`, initScript: 'echo a' } },
      token,
    );
    const second = await adminGql<{ adminCreateCloudWorkload: { id: string; name: string } }>(
      CREATE_WORKLOAD,
      { input: { name: `mount-b-${suffix}`, postScript: 'echo b' } },
      token,
    );
    expect(first.errors, JSON.stringify(first.errors)).toBeUndefined();
    expect(second.errors, JSON.stringify(second.errors)).toBeUndefined();
    const a = first.data!.adminCreateCloudWorkload;
    const b = second.data!.adminCreateCloudWorkload;

    try {
      // 传入顺序 [b, a]，期望列表按提交顺序返回
      const started = await adminGql<{ adminStartCloudContainer: ContainerNode }>(
        START,
        { purpose: 'IDLE', workloadIds: [b.id, a.id] },
        token,
      );
      expect(started.errors, JSON.stringify(started.errors)).toBeUndefined();
      const container = started.data!.adminStartCloudContainer;
      expect(container.workloads?.map((w) => w.id)).toEqual([b.id, a.id]);
      expect(container.currentWorkloadName ?? null).toBeNull();

      // 列表也返回 workloads / currentWorkloadName 字段
      const listed = await adminGql<{ adminCloudContainers: ContainerNode[] }>(LIST, undefined, token);
      const row = listed.data!.adminCloudContainers.find((c) => c.id === container.id);
      expect(row?.workloads?.map((w) => w.id)).toEqual([b.id, a.id]);

      await adminGql(DESTROY, { id: container.id }, token);
    } finally {
      await adminGql(DELETE_WORKLOAD, { id: a.id }, token).catch(() => {});
      await adminGql(DELETE_WORKLOAD, { id: b.id }, token).catch(() => {});
    }
  });

  it('T-IA8: rejects an unknown workloadId when starting a container', async () => {
    const unknownId = new mongoose.Types.ObjectId().toString();
    const body = await adminGql(START, { purpose: 'IDLE', workloadIds: [unknownId] }, token);
    expect(body.errors).toBeDefined();
    expect(body.errors![0].message).toContain('INVALID_WORKLOAD');
  });

  it('T-IA9: starts with an empty workloads list when no workloadIds are passed', async () => {
    const started = await adminGql<{ adminStartCloudContainer: ContainerNode }>(
      START,
      { purpose: 'IDLE' },
      token,
    );
    expect(started.errors, JSON.stringify(started.errors)).toBeUndefined();
    const container = started.data!.adminStartCloudContainer;
    expect(container.workloads).toEqual([]);
    expect(container.currentWorkloadName ?? null).toBeNull();
    await adminGql(DESTROY, { id: container.id }, token);
  });

  it('T-IA3/T-IA4: starts an idle container then destroys it', async () => {
    const started = await adminGql<{ adminStartCloudContainer: ContainerNode }>(START, { purpose: 'IDLE' }, token);
    expect(started.errors).toBeUndefined();
    const container = started.data!.adminStartCloudContainer;
    expect(container.purpose).toBe('IDLE');
    expect(['CREATING', 'CONNECTING']).toContain(container.status);

    const listed = await adminGql<{ adminCloudContainers: ContainerNode[] }>(LIST, undefined, token);
    expect(listed.data!.adminCloudContainers.some((c) => c.id === container.id)).toBe(true);

    const destroyed = await adminGql<{ adminDestroyCloudContainer: boolean }>(DESTROY, { id: container.id }, token);
    expect(destroyed.errors).toBeUndefined();
    expect(destroyed.data!.adminDestroyCloudContainer).toBe(true);

    const after = await adminGql<{ adminCloudContainers: Array<{ id: string; status: string }> }>(LIST, undefined, token);
    const row = after.data!.adminCloudContainers.find((c) => c.id === container.id);
    expect(row?.status).toBe('EXITED');
  });

  it.skipIf(!hasMongo)(
    'P0-1: online container destroy survives the shutdown grace without a false timeout',
    async () => {
      const started = await adminGql<{ adminStartCloudContainer: ContainerNode }>(START, { purpose: 'IDLE' }, token);
      expect(started.errors).toBeUndefined();
      const id = started.data!.adminStartCloudContainer.id;

      let destroyed = false;
      try {
        const forced = await forceContainerOnline(id);
        // 显式断言，避免 MONGODB_URI 存在但连接/写入失败时静默通过
        expect(forced).toBe(true);

        const startedAt = Date.now();
        const result = await adminGql<{ adminDestroyCloudContainer: boolean }>(DESTROY, { id }, token);
        const elapsed = Date.now() - startedAt;
        destroyed = true;

        expect(result.errors).toBeUndefined();
        expect(result.data!.adminDestroyCloudContainer).toBe(true);
        // cloud-controller 对在线容器等待 shutdown 宽限期（约 10s）后才响应
        expect(elapsed).toBeGreaterThanOrEqual(9000);
        // admin-api 销毁专用超时（30s）内完成，未误报 CONTROL_PLANE_UNAVAILABLE
        expect(elapsed).toBeLessThan(29000);
      } finally {
        // 任何早退/断言失败路径都必须兜底销毁已启动的容器，避免残留污染后续列表断言
        if (!destroyed) {
          await adminGql(DESTROY, { id }, token).catch(() => {});
        }
      }
    },
    40000,
  );
});
