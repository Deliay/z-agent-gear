import { describe, it, expect, beforeAll, afterEach } from 'vitest';
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

// 工作负载一期：`workloads` 选择入参（含参数、隐式依赖展开）
const START_SELECTION = `
  mutation AdminStartCloudContainerSelection($purpose: CloudContainerPurpose!, $workloads: [CloudWorkloadSelectionInput!]) {
    adminStartCloudContainer(purpose: $purpose, workloads: $workloads) {
      id
      name
      status
      purpose
      workloads { id name }
      currentWorkloadName
    }
  }
`;

const START_BOTH = `
  mutation AdminStartCloudContainerBoth($purpose: CloudContainerPurpose!, $workloadIds: [ID!], $workloads: [CloudWorkloadSelectionInput!]) {
    adminStartCloudContainer(purpose: $purpose, workloadIds: $workloadIds, workloads: $workloads) {
      id
    }
  }
`;

const LOGS = `
  query AdminCloudContainerWorkloadLogs($containerId: ID!) {
    adminCloudContainerWorkloadLogs(containerId: $containerId) {
      id
      workloadName
      params
    }
  }
`;

interface StoredPlanEntry {
  workloadId: string;
  params: Record<string, unknown>;
  implicit: boolean;
  required: boolean;
}

/**
 * 直读 `cloudcontainers` 落库文档，返回派生 `workloadIds` 与 `workloadPlan`（含参数/隐式标记）。
 * 需要 MONGODB_URI；缺省返回 null，调用方 skipIf 跳过。
 */
async function readStoredPlan(
  containerId: string,
): Promise<{ workloadIds: string[]; plan: StoredPlanEntry[] } | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) return null;
  const doc = await db
    .collection('cloudcontainers')
    .findOne({ _id: new mongoose.Types.ObjectId(containerId) });
  const plan = (doc?.workloadPlan ?? []) as Array<{
    workloadId: unknown;
    params?: Record<string, unknown>;
    implicit?: unknown;
    required?: unknown;
  }>;
  return {
    workloadIds: ((doc?.workloadIds ?? []) as unknown[]).map(String),
    plan: plan.map((entry) => ({
      workloadId: String(entry.workloadId),
      params: entry.params ?? {},
      implicit: entry.implicit === true,
      required: entry.required === true,
    })),
  };
}

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

  const cleanupWorkloadIds: string[] = [];
  const cleanupContainerIds: string[] = [];

  afterEach(async () => {
    while (cleanupContainerIds.length > 0) {
      await adminGql(DESTROY, { id: cleanupContainerIds.pop()! }, token).catch(() => {});
    }
    while (cleanupWorkloadIds.length > 0) {
      await adminGql(DELETE_WORKLOAD, { id: cleanupWorkloadIds.pop()! }, token).catch(() => {});
    }
  });

  function uniqueName(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  interface CreatedWorkload {
    id: string;
    name: string;
  }

  async function createWorkload(input: {
    name: string;
    initScript?: string | null;
    postScript?: string | null;
    paramSchema?: Array<{
      key: string;
      label: string;
      type: string;
      options?: string[];
      defaultValue: unknown;
    }>;
    dependsOnWorkloadIds?: string[];
  }): Promise<CreatedWorkload> {
    const res = await adminGql<{ adminCreateCloudWorkload: CreatedWorkload }>(
      CREATE_WORKLOAD,
      { input },
      token,
    );
    expect(res.errors, JSON.stringify(res.errors)).toBeUndefined();
    const workload = res.data!.adminCreateCloudWorkload;
    cleanupWorkloadIds.push(workload.id);
    return workload;
  }

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

  // -------------------------------------------------------------------------
  // 工作负载一期：adminStartCloudContainer(workloads)（T-WP1~T-WP7 / T-W12）
  // -------------------------------------------------------------------------

  it.skipIf(!hasMongo)(
    'T-IA10: expands implicit dependencies in topological order with default params',
    async () => {
      const dep = await createWorkload({
        name: uniqueName('sel-dep'),
        initScript: 'echo dep',
        paramSchema: [{ key: 'version', label: '版本', type: 'TEXT', options: [], defaultValue: '22' }],
      });
      const parent = await createWorkload({
        name: uniqueName('sel-parent'),
        initScript: 'echo parent',
        dependsOnWorkloadIds: [dep.id],
      });

      const started = await adminGql<{ adminStartCloudContainer: ContainerNode }>(
        START_SELECTION,
        { purpose: 'IDLE', workloads: [{ workloadId: parent.id }] },
        token,
      );
      expect(started.errors, JSON.stringify(started.errors)).toBeUndefined();
      const container = started.data!.adminStartCloudContainer;
      cleanupContainerIds.push(container.id);

      // 依赖先于依赖方（后序 DFS），且隐式依赖只出现一次
      expect(container.workloads?.map((w) => w.id)).toEqual([dep.id, parent.id]);

      const stored = await readStoredPlan(container.id);
      expect(stored).not.toBeNull();
      expect(stored!.workloadIds).toEqual([dep.id, parent.id]);
      expect(stored!.plan).toEqual([
        { workloadId: dep.id, params: { version: '22' }, implicit: true, required: false },
        { workloadId: parent.id, params: {}, implicit: false, required: false },
      ]);
    },
  );

  it.skipIf(!hasMongo)(
    'T-IA11: explicit selection overrides implicit defaults (dedupe, single occurrence)',
    async () => {
      const dep = await createWorkload({
        name: uniqueName('sel-ov-dep'),
        initScript: 'echo dep',
        paramSchema: [{ key: 'version', label: '版本', type: 'TEXT', options: [], defaultValue: '22' }],
      });
      const parent = await createWorkload({
        name: uniqueName('sel-ov-parent'),
        initScript: 'echo parent',
        dependsOnWorkloadIds: [dep.id],
      });

      // 同时显式选择依赖方与依赖：依赖只执行一次，且使用显式参数（覆盖默认值）
      const started = await adminGql<{ adminStartCloudContainer: ContainerNode }>(
        START_SELECTION,
        {
          purpose: 'IDLE',
          workloads: [{ workloadId: parent.id }, { workloadId: dep.id, params: { version: '20' } }],
        },
        token,
      );
      expect(started.errors, JSON.stringify(started.errors)).toBeUndefined();
      const container = started.data!.adminStartCloudContainer;
      cleanupContainerIds.push(container.id);

      expect(container.workloads?.map((w) => w.id)).toEqual([dep.id, parent.id]);

      const stored = await readStoredPlan(container.id);
      expect(stored!.plan).toEqual([
        { workloadId: dep.id, params: { version: '20' }, implicit: false, required: false },
        { workloadId: parent.id, params: {}, implicit: false, required: false },
      ]);
    },
  );

  it.skipIf(!hasMongo)(
    'T-IA-REQ: passes workloads[].required through to the stored plan (default false, non-boolean tolerated)',
    async () => {
      const must = await createWorkload({ name: uniqueName('req-must'), initScript: 'echo must' });
      const opt = await createWorkload({ name: uniqueName('req-opt'), initScript: 'echo opt' });

      const started = await adminGql<{ adminStartCloudContainer: ContainerNode }>(
        START_SELECTION,
        {
          purpose: 'IDLE',
          workloads: [
            { workloadId: must.id, required: true },
            { workloadId: opt.id },
          ],
        },
        token,
      );
      expect(started.errors, JSON.stringify(started.errors)).toBeUndefined();
      const container = started.data!.adminStartCloudContainer;
      cleanupContainerIds.push(container.id);

      const stored = await readStoredPlan(container.id);
      expect(stored).not.toBeNull();
      expect(stored!.plan).toEqual([
        { workloadId: must.id, params: {}, implicit: false, required: true },
        { workloadId: opt.id, params: {}, implicit: false, required: false },
      ]);
    },
  );

  it.skipIf(!hasMongo)(
    'T-IA-REQ: workloadIds-only compatibility path stores required=false (no must semantics)',
    async () => {
      const workload = await createWorkload({ name: uniqueName('req-legacy'), initScript: 'echo x' });
      const started = await adminGql<{ adminStartCloudContainer: ContainerNode }>(
        START,
        { purpose: 'IDLE', workloadIds: [workload.id] },
        token,
      );
      expect(started.errors, JSON.stringify(started.errors)).toBeUndefined();
      const container = started.data!.adminStartCloudContainer;
      cleanupContainerIds.push(container.id);

      const stored = await readStoredPlan(container.id);
      expect(stored).not.toBeNull();
      expect(stored!.plan.every((entry) => entry.required === false)).toBe(true);
    },
  );

  it('T-IA12: rejects an expanded plan exceeding 10 workloads', async () => {
    // 链式依赖 c1 <- c2 <- ... <- c11，仅显式选择尾节点，展开后为 11 条（> 10）
    let previous: CreatedWorkload | null = null;
    let tail: CreatedWorkload | null = null;
    for (let i = 0; i < 11; i += 1) {
      const workload = await createWorkload({
        name: uniqueName(`sel-chain-${i}`),
        initScript: 'echo chain',
        dependsOnWorkloadIds: previous ? [previous.id] : [],
      });
      previous = workload;
      tail = workload;
    }

    const started = await adminGql(START_SELECTION, { purpose: 'IDLE', workloads: [{ workloadId: tail!.id }] }, token);
    expect(started.errors).toBeDefined();
    expect(started.errors![0].message).toContain('expanded workloads exceed 10');
  });

  it('T-IA13: rejects unknown parameter and invalid parameter value', async () => {
    const text = await createWorkload({
      name: uniqueName('sel-text'),
      initScript: 'echo',
      paramSchema: [{ key: 'version', label: '版本', type: 'TEXT', options: [], defaultValue: '22' }],
    });
    const unknown = await adminGql(
      START_SELECTION,
      { purpose: 'IDLE', workloads: [{ workloadId: text.id, params: { nope: 'x' } }] },
      token,
    );
    expect(unknown.errors?.[0].message).toBe('unknown parameter: nope');

    const select = await createWorkload({
      name: uniqueName('sel-select'),
      initScript: 'echo',
      paramSchema: [{ key: 'mode', label: '模式', type: 'SELECT', options: ['a', 'b'], defaultValue: 'a' }],
    });
    const invalid = await adminGql(
      START_SELECTION,
      { purpose: 'IDLE', workloads: [{ workloadId: select.id, params: { mode: 'c' } }] },
      token,
    );
    expect(invalid.errors?.[0].message).toBe('invalid value for parameter mode');
  });

  it('T-IA14: rejects duplicate workload selection', async () => {
    const workload = await createWorkload({ name: uniqueName('sel-dup'), initScript: 'echo' });
    const started = await adminGql(
      START_SELECTION,
      { purpose: 'IDLE', workloads: [{ workloadId: workload.id }, { workloadId: workload.id }] },
      token,
    );
    expect(started.errors?.[0].message).toBe('duplicate workload selection');
  });

  it('T-IA15: rejects providing workloadIds and workloads together', async () => {
    const workload = await createWorkload({ name: uniqueName('sel-both'), initScript: 'echo' });
    const started = await adminGql(
      START_BOTH,
      { purpose: 'IDLE', workloadIds: [workload.id], workloads: [{ workloadId: workload.id }] },
      token,
    );
    expect(started.errors?.[0].message).toBe('workloadIds and workloads cannot both be provided');
  });

  it('T-IA16: rejects an unknown explicit workload selection', async () => {
    const unknownId = new mongoose.Types.ObjectId().toString();
    const started = await adminGql(
      START_SELECTION,
      { purpose: 'IDLE', workloads: [{ workloadId: unknownId }] },
      token,
    );
    expect(started.errors?.[0].message).toBe('workload not found');
  });

  it('T-IA17: rejects a dependency removed after it was configured', async () => {
    const dep = await createWorkload({ name: uniqueName('sel-gone-dep'), initScript: 'echo' });
    const parent = await createWorkload({
      name: uniqueName('sel-gone-parent'),
      initScript: 'echo',
      dependsOnWorkloadIds: [dep.id],
    });

    // 删除依赖后启动：定义快照不再包含依赖 → 运行时兜底报依赖不存在
    await adminGql(DELETE_WORKLOAD, { id: dep.id }, token);

    const started = await adminGql(
      START_SELECTION,
      { purpose: 'IDLE', workloads: [{ workloadId: parent.id }] },
      token,
    );
    expect(started.errors?.[0].message).toContain('dependency workload not found');
  });

  it.skipIf(!hasMongo)(
    'T-IA18: returns the parameter snapshot in workload logs',
    async () => {
      const started = await adminGql<{ adminStartCloudContainer: ContainerNode }>(
        START,
        { purpose: 'IDLE' },
        token,
      );
      expect(started.errors).toBeUndefined();
      const container = started.data!.adminStartCloudContainer;
      cleanupContainerIds.push(container.id);

      const uri = process.env.MONGODB_URI!;
      if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
      const db = mongoose.connection.db!;
      const containerId = new mongoose.Types.ObjectId(container.id);
      const workloadId = new mongoose.Types.ObjectId();
      const now = new Date();
      await db.collection('cloudworkloadlogs').insertOne({
        containerId,
        workloadId,
        workloadName: 'with-params',
        phase: 'init',
        status: 'success',
        script: 'echo params',
        params: { version: '20', package_manager: ['pnpm'] },
        exitCode: 0,
        log: '',
        startedAt: now,
        finishedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      try {
        const logs = await adminGql<{
          adminCloudContainerWorkloadLogs: Array<{ workloadName: string; params: Record<string, unknown> }>;
        }>(LOGS, { containerId: container.id }, token);
        expect(logs.errors, JSON.stringify(logs.errors)).toBeUndefined();
        expect(logs.data!.adminCloudContainerWorkloadLogs[0].params).toEqual({
          version: '20',
          package_manager: ['pnpm'],
        });
      } finally {
        await db.collection('cloudworkloadlogs').deleteMany({ containerId });
      }
    },
  );
});
