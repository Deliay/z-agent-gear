import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { adminGql, ensureAdminLogin } from './helpers.js';

// 工作负载（Workload）GraphQL 套件：T-IA*。
//
// 覆盖契约 contracts/admin-cloud-workload.graphql + admin-cloud-container.graphql 的扩展部分：
//   - CRUD 全量（仅 init / 仅 post / 两者）与校验边界（裁决 12）
//   - 重名 / 更新删除不存在 id 的友好错误
//   - 非管理员（匿名）拒绝
//   - adminCloudContainerWorkloadLogs：控制面可用路径（直写 Mongo 后经 GraphQL 查询，
//     枚举大写、脚本快照、执行顺序）；控制面**不可达降级直读 Mongo** 分支由
//     servers/admin-api/src/graphql/resolvers/cloud-workload.test.ts 的单测锚定
//     （E2E/Aspire 环境无法在运行期摘掉 cloud-controller）
//   - adminStartCloudContainer 携带 workloadIds（合法挂载顺序 / 未知 id 报错 / 缺省不挂载）
//
// 说明：cloud-controller 由 Aspire 以 K8S_ENABLED=false 启动（InMemoryK8sClient），start 后容器
// 无真实工作容器回连，故不会自动产生执行日志——日志用例在直写 Mongo 后经控制面内部 API 读回。

const LIST = `
  query AdminCloudWorkloads {
    adminCloudWorkloads { id name initScript postScript createdAt updatedAt }
  }
`;

const CREATE = `
  mutation AdminCreateCloudWorkload($input: CreateCloudWorkloadInput!) {
    adminCreateCloudWorkload(input: $input) { id name initScript postScript createdAt updatedAt }
  }
`;

const UPDATE = `
  mutation AdminUpdateCloudWorkload($id: ID!, $input: UpdateCloudWorkloadInput!) {
    adminUpdateCloudWorkload(id: $id, input: $input) { id name initScript postScript createdAt updatedAt }
  }
`;

const DELETE = `mutation AdminDeleteCloudWorkload($id: ID!) { adminDeleteCloudWorkload(id: $id) }`;

const LOGS = `
  query AdminCloudContainerWorkloadLogs($containerId: ID!) {
    adminCloudContainerWorkloadLogs(containerId: $containerId) {
      id containerId workloadId workloadName phase status script exitCode log startedAt finishedAt
    }
  }
`;

const START = `
  mutation AdminStartCloudContainer($purpose: CloudContainerPurpose!, $workloadIds: [ID!]) {
    adminStartCloudContainer(purpose: $purpose, workloadIds: $workloadIds) {
      id name status workloads { id name } currentWorkloadName
    }
  }
`;

const DESTROY = `mutation AdminDestroyCloudContainer($id: ID!) { adminDestroyCloudContainer(id: $id) }`;

/** 16 KiB（UTF-8）单脚本上限（裁决 12）；+1 字节即越界。 */
const SCRIPT_MAX_BYTES = 16 * 1024;

interface WorkloadNode {
  id: string;
  name: string;
  initScript: string | null;
  postScript: string | null;
}

interface ContainerNode {
  id: string;
  name: string;
  status: string;
  workloads: WorkloadNode[];
  currentWorkloadName: string | null;
}

let mongo: mongoose.Connection | null = null;

/** 惰性连接共享 Mongo（MONGODB_URI 缺省时返回 null，相关用例跳过）。 */
async function ensureMongo(): Promise<mongoose.Connection | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
  mongo = mongoose.connection;
  return mongo;
}

describe('Admin Cloud Workload API', () => {
  let token = '';
  const hasMongo = Boolean(process.env.MONGODB_URI);
  const createdIds: string[] = [];
  const startedContainers: string[] = [];

  beforeAll(async () => {
    token = await ensureAdminLogin();
  });

  afterEach(async () => {
    // 清理本用例创建的工作负载与容器，避免污染列表断言
    while (createdIds.length > 0) {
      const id = createdIds.pop()!;
      await adminGql(DELETE, { id }, token).catch(() => {});
    }
    while (startedContainers.length > 0) {
      const id = startedContainers.pop()!;
      await adminGql(DESTROY, { id }, token).catch(() => {});
    }
  });

  function uniqueName(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createWorkload(input: {
    name: string;
    initScript?: string | null;
    postScript?: string | null;
  }): Promise<WorkloadNode> {
    const res = await adminGql<{ adminCreateCloudWorkload: WorkloadNode }>(CREATE, { input }, token);
    expect(res.errors, JSON.stringify(res.errors)).toBeUndefined();
    const workload = res.data!.adminCreateCloudWorkload;
    createdIds.push(workload.id);
    return workload;
  }

  it('T-IA: rejects anonymous workload operations (guard regression)', async () => {
    const list = await adminGql(LIST);
    expect(list.errors?.[0].message).toBe('Not authenticated');

    const create = await adminGql(CREATE, { input: { name: 'x', initScript: 'echo ok' } });
    expect(create.errors?.[0].message).toBe('Not authenticated');

    const update = await adminGql(UPDATE, { id: 'x', input: { name: 'y' } });
    expect(update.errors?.[0].message).toBe('Not authenticated');

    const remove = await adminGql(DELETE, { id: 'x' });
    expect(remove.errors?.[0].message).toBe('Not authenticated');

    const logs = await adminGql(LOGS, { containerId: 'x' });
    expect(logs.errors?.[0].message).toBe('Not authenticated');
  });

  it('T-IA: creates, lists, updates and deletes workloads (init / post / both)', async () => {
    const onlyInit = await createWorkload({ name: uniqueName('wl-init'), initScript: 'echo init-a' });
    expect(onlyInit.initScript).toBe('echo init-a');
    expect(onlyInit.postScript).toBeNull();

    const onlyPost = await createWorkload({ name: uniqueName('wl-post'), postScript: 'echo post-a' });
    expect(onlyPost.initScript).toBeNull();
    expect(onlyPost.postScript).toBe('echo post-a');

    const bothName = uniqueName('wl-both');
    const both = await createWorkload({ name: bothName, initScript: 'echo init-b', postScript: 'echo post-b' });
    expect(both.initScript).toBe('echo init-b');
    expect(both.postScript).toBe('echo post-b');
    // 契约时间字段为 ISO 字符串
    expect(typeof both.createdAt).toBe('string');
    expect(Number.isNaN(Date.parse(both.createdAt))).toBe(false);

    const listed = await adminGql<{ adminCloudWorkloads: WorkloadNode[] }>(LIST, undefined, token);
    expect(listed.errors).toBeUndefined();
    const ids = listed.data!.adminCloudWorkloads.map((w) => w.id);
    expect(ids).toContain(onlyInit.id);
    expect(ids).toContain(onlyPost.id);
    expect(ids).toContain(both.id);

    // 编辑：显式传 null 清空 init，只保留 post（合并式校验允许）
    const updated = await adminGql<{ adminUpdateCloudWorkload: WorkloadNode }>(
      UPDATE,
      { id: both.id, input: { name: `${bothName}-v2`, initScript: null } },
      token,
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data!.adminUpdateCloudWorkload.name).toBe(`${bothName}-v2`);
    expect(updated.data!.adminUpdateCloudWorkload.initScript).toBeNull();
    expect(updated.data!.adminUpdateCloudWorkload.postScript).toBe('echo post-b');

    const removed = await adminGql<{ adminDeleteCloudWorkload: boolean }>(DELETE, { id: onlyInit.id }, token);
    expect(removed.errors).toBeUndefined();
    expect(removed.data!.adminDeleteCloudWorkload).toBe(true);

    const afterList = await adminGql<{ adminCloudWorkloads: Array<{ id: string }> }>(LIST, undefined, token);
    expect(afterList.data!.adminCloudWorkloads.some((w) => w.id === onlyInit.id)).toBe(false);
  });

  it('T-IA: rejects empty / over-long names and double-empty scripts', async () => {
    const emptyName = await adminGql(CREATE, { input: { name: '   ', initScript: 'echo ok' } }, token);
    expect(emptyName.errors?.[0].message).toBe('name is required');

    const tooLongName = await adminGql(
      CREATE,
      { input: { name: 'x'.repeat(65), initScript: 'echo ok' } },
      token,
    );
    expect(tooLongName.errors?.[0].message).toBe('name must be at most 64 characters');

    const bothEmpty = await adminGql(
      CREATE,
      { input: { name: uniqueName('wl-empty'), initScript: null, postScript: '   ' } },
      token,
    );
    expect(bothEmpty.errors?.[0].message).toBe('at least one script is required');
  });

  it('T-IA: rejects scripts exceeding 16 KiB (initScript / postScript)', async () => {
    const oversized = 'a'.repeat(SCRIPT_MAX_BYTES + 1);

    const initTooBig = await adminGql(
      CREATE,
      { input: { name: uniqueName('wl-big-init'), initScript: oversized } },
      token,
    );
    expect(initTooBig.errors?.[0].message).toBe('initScript must be at most 16 KiB');

    const postTooBig = await adminGql(
      CREATE,
      { input: { name: uniqueName('wl-big-post'), postScript: oversized } },
      token,
    );
    expect(postTooBig.errors?.[0].message).toBe('postScript must be at most 16 KiB');
  });

  it('T-IA: accepts boundary values (exactly 64-char name and exactly 16 KiB script)', async () => {
    // 恰好 64 字符且唯一
    const name = `b${Date.now().toString(36)}`.padEnd(64, 'x').slice(0, 64);
    expect(name).toHaveLength(64);
    const script = 'a'.repeat(SCRIPT_MAX_BYTES);
    expect(Buffer.byteLength(script, 'utf8')).toBe(SCRIPT_MAX_BYTES);

    const workload = await createWorkload({ name, initScript: script });
    expect(workload.name).toBe(name);
    expect(workload.initScript).toHaveLength(SCRIPT_MAX_BYTES);
  });

  it('T-IA: maps duplicate names to a friendly error on create and rename', async () => {
    const name = uniqueName('wl-dup');
    await createWorkload({ name, initScript: 'echo ok' });

    const duplicate = await adminGql(CREATE, { input: { name, initScript: 'echo ok' } }, token);
    expect(duplicate.errors?.[0].message).toBe('Workload name already exists');

    const other = await createWorkload({ name: uniqueName('wl-other'), initScript: 'echo ok' });
    const rename = await adminGql(UPDATE, { id: other.id, input: { name } }, token);
    expect(rename.errors?.[0].message).toBe('Workload name already exists');
  });

  it('T-IA: reports not-found for update / delete of a missing id', async () => {
    const missing = new mongoose.Types.ObjectId().toString();

    const update = await adminGql(UPDATE, { id: missing, input: { name: 'nope' } }, token);
    expect(update.errors?.[0].message).toBe('Workload not found');

    const removed = await adminGql<{ adminDeleteCloudWorkload: boolean }>(DELETE, { id: missing }, token);
    expect(removed.errors).toBeUndefined();
    expect(removed.data!.adminDeleteCloudWorkload).toBe(false);
  });

  it('T-IA: returns [] logs for a container without execution records', async () => {
    const started = await adminGql<{ adminStartCloudContainer: ContainerNode }>(START, { purpose: 'IDLE' }, token);
    expect(started.errors).toBeUndefined();
    const container = started.data!.adminStartCloudContainer;
    startedContainers.push(container.id);

    const logs = await adminGql<{ adminCloudContainerWorkloadLogs: unknown[] }>(
      LOGS,
      { containerId: container.id },
      token,
    );
    expect(logs.errors, JSON.stringify(logs.errors)).toBeUndefined();
    expect(logs.data!.adminCloudContainerWorkloadLogs).toEqual([]);
  });

  it.skipIf(!hasMongo)(
    'T-IA: queries workload logs (uppercase enums, script snapshot, execution order)',
    async () => {
      const conn = await ensureMongo();
      expect(conn).not.toBeNull();

      const started = await adminGql<{ adminStartCloudContainer: ContainerNode }>(START, { purpose: 'IDLE' }, token);
      expect(started.errors).toBeUndefined();
      const container = started.data!.adminStartCloudContainer;
      startedContainers.push(container.id);

      const db = conn!.db;
      expect(db).toBeDefined();
      const collection = db!.collection('cloudworkloadlogs');
      const containerId = new mongoose.Types.ObjectId(container.id);
      const workloadId = new mongoose.Types.ObjectId();
      const base = Date.now() - 60_000;
      // 显式递增 createdAt 保证执行顺序稳定（与 cloud-controller 写入口径一致）
      await collection.insertMany([
        {
          containerId,
          workloadId,
          workloadName: 'setup-node',
          phase: 'init',
          status: 'success',
          script: 'echo "hello init"',
          exitCode: 0,
          log: 'hello init\n',
          startedAt: new Date(base),
          finishedAt: new Date(base + 1000),
          createdAt: new Date(base),
          updatedAt: new Date(base + 1000),
        },
        {
          containerId,
          workloadId,
          workloadName: 'cleanup-deps',
          phase: 'post',
          status: 'failed',
          script: 'echo "cleanup"',
          exitCode: 2,
          log: 'cleanup failed\n',
          startedAt: new Date(base + 2000),
          finishedAt: new Date(base + 3000),
          createdAt: new Date(base + 2000),
          updatedAt: new Date(base + 3000),
        },
      ]);

      const logs = await adminGql<{
        adminCloudContainerWorkloadLogs: Array<{
          containerId: string;
          workloadId: string;
          workloadName: string;
          phase: string;
          status: string;
          script: string;
          exitCode: number | null;
          log: string;
          startedAt: string | null;
          finishedAt: string | null;
        }>;
      }>(LOGS, { containerId: container.id }, token);

      expect(logs.errors, JSON.stringify(logs.errors)).toBeUndefined();
      const records = logs.data!.adminCloudContainerWorkloadLogs;
      expect(records).toHaveLength(2);

      // 按 createdAt 升序 = 执行顺序（init 在前，post 在后）
      expect(records.map((r) => r.workloadName)).toEqual(['setup-node', 'cleanup-deps']);
      expect(records.map((r) => r.phase)).toEqual(['INIT', 'POST']);
      expect(records.map((r) => r.status)).toEqual(['SUCCESS', 'FAILED']);
      // 脚本内容快照留档
      expect(records[0].script).toBe('echo "hello init"');
      expect(records[1].script).toBe('echo "cleanup"');
      expect(records[0].containerId).toBe(container.id);
      expect(records[0].workloadId).toBe(workloadId.toString());
      expect(records[0].exitCode).toBe(0);
      expect(records[1].exitCode).toBe(2);
      expect(records[0].log).toBe('hello init\n');
      expect(typeof records[0].startedAt).toBe('string');

      // 清理直写记录，避免下一轮列表断言污染
      await collection.deleteMany({ containerId });
    },
  );

  it('T-IA: starts a container with workloadIds preserving the selection order', async () => {
    const first = await createWorkload({ name: uniqueName('wl-mount-a'), initScript: 'echo a' });
    const second = await createWorkload({ name: uniqueName('wl-mount-b'), postScript: 'echo b' });

    const started = await adminGql<{ adminStartCloudContainer: ContainerNode }>(
      START,
      { purpose: 'IDLE', workloadIds: [second.id, first.id] },
      token,
    );
    expect(started.errors, JSON.stringify(started.errors)).toBeUndefined();
    const container = started.data!.adminStartCloudContainer;
    startedContainers.push(container.id);

    // 按 workloadIds 顺序返回（顺序 = 提交顺序，而非创建顺序）
    expect(container.workloads.map((w) => w.name)).toEqual([second.name, first.name]);
    expect(container.workloads.map((w) => w.id)).toEqual([second.id, first.id]);
    // 无真实回连（K8S_ENABLED=false）→ 不处于初始化中
    expect(container.currentWorkloadName).toBeNull();
  });

  it('T-IA: rejects an unknown workloadId when starting a container', async () => {
    const unknownId = new mongoose.Types.ObjectId().toString();
    const started = await adminGql(START, { purpose: 'IDLE', workloadIds: [unknownId] }, token);
    expect(started.errors).toBeDefined();
    expect(started.errors![0].message).toContain('INVALID_WORKLOAD');
  });

  it('T-IA: starts without workloads by default (empty workloads)', async () => {
    const started = await adminGql<{ adminStartCloudContainer: ContainerNode }>(START, { purpose: 'IDLE' }, token);
    expect(started.errors).toBeUndefined();
    const container = started.data!.adminStartCloudContainer;
    startedContainers.push(container.id);
    expect(container.workloads).toEqual([]);
    expect(container.currentWorkloadName).toBeNull();
  });
});
