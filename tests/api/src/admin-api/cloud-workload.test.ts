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
//   - 工作负载一期：paramSchema CRUD（四种类型/默认值/可选项/非法值）、依赖保存
//     （正常/自依赖/环/不存在/超 5）、预制项存在性与幂等（重复查询稳定）、日志 params
//
// 说明：cloud-controller 由 Aspire 以 K8S_ENABLED=false 启动（InMemoryK8sClient），start 后容器
// 无真实工作容器回连，故不会自动产生执行日志——日志用例在直写 Mongo 后经控制面内部 API 读回。

// 契约 CloudWorkload 的公共选择集：既有 CRUD 字段 + 参数/依赖/预制（工作负载一期）。
const WORKLOAD_FIELDS = `
  id name initScript postScript createdAt updatedAt
  paramSchema { key label type options defaultValue }
  dependsOnWorkloadIds
  isPreset
  workloadKind
  harnessType
`;

const LIST = `
  query AdminCloudWorkloads {
    adminCloudWorkloads { ${WORKLOAD_FIELDS} }
  }
`;

const CREATE = `
  mutation AdminCreateCloudWorkload($input: CreateCloudWorkloadInput!) {
    adminCreateCloudWorkload(input: $input) { ${WORKLOAD_FIELDS} }
  }
`;

const UPDATE = `
  mutation AdminUpdateCloudWorkload($id: ID!, $input: UpdateCloudWorkloadInput!) {
    adminUpdateCloudWorkload(id: $id, input: $input) { ${WORKLOAD_FIELDS} }
  }
`;

const DELETE = `mutation AdminDeleteCloudWorkload($id: ID!) { adminDeleteCloudWorkload(id: $id) }`;

const LOGS = `
  query AdminCloudContainerWorkloadLogs($containerId: ID!) {
    adminCloudContainerWorkloadLogs(containerId: $containerId) {
      id containerId workloadId workloadName phase status script params required exitCode log startedAt finishedAt
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

interface ParamFieldNode {
  key: string;
  label: string;
  type: string;
  options: string[];
  defaultValue: unknown;
}

interface WorkloadNode {
  id: string;
  name: string;
  initScript: string | null;
  postScript: string | null;
  paramSchema?: ParamFieldNode[];
  dependsOnWorkloadIds?: string[];
  isPreset?: boolean;
  workloadKind?: string;
  harnessType?: string | null;
}

interface ParamFieldInput {
  key: string;
  label: string;
  type: string;
  options?: string[];
  defaultValue: unknown;
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
    paramSchema?: ParamFieldInput[];
    dependsOnWorkloadIds?: string[];
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
          params: { version: '20', package_manager: ['pnpm'] },
          required: true,
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
          params: Record<string, unknown>;
          required: boolean;
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
      // 参数快照留档（含默认值）；历史记录无 params 归一为 {}
      expect(records[0].params).toEqual({ version: '20', package_manager: ['pnpm'] });
      expect(records[1].params).toEqual({});
      // required 快照留档（历史缺省 false）
      expect(records[0].required).toBe(true);
      expect(records[1].required).toBe(false);
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

  // -------------------------------------------------------------------------
  // 工作负载一期：paramSchema CRUD（T-W8/T-W9）
  // -------------------------------------------------------------------------

  it('T-IA: saves and echoes a paramSchema with all four field types', async () => {
    const workload = await createWorkload({
      name: uniqueName('wl-params'),
      initScript: 'echo params',
      paramSchema: [
        { key: 'mode', label: '模式', type: 'SELECT', options: ['fast', 'slow'], defaultValue: 'fast' },
        { key: 'features', label: '特性', type: 'MULTI_SELECT', options: ['x1', 'x2', 'x3'], defaultValue: ['x1', 'x3'] },
        // 非下拉类型即使传了 options 也应归一为 []
        { key: 'version', label: '版本', type: 'TEXT', options: ['ignored'], defaultValue: '22' },
        { key: 'verbose', label: '详细', type: 'BOOLEAN', options: ['ignored'], defaultValue: false },
      ],
    });

    expect(workload.paramSchema).toEqual([
      { key: 'mode', label: '模式', type: 'SELECT', options: ['fast', 'slow'], defaultValue: 'fast' },
      { key: 'features', label: '特性', type: 'MULTI_SELECT', options: ['x1', 'x2', 'x3'], defaultValue: ['x1', 'x3'] },
      { key: 'version', label: '版本', type: 'TEXT', options: [], defaultValue: '22' },
      { key: 'verbose', label: '详细', type: 'BOOLEAN', options: [], defaultValue: false },
    ]);
    expect(workload.isPreset).toBe(false);
    expect(workload.dependsOnWorkloadIds).toEqual([]);
  });

  it('T-IA: updates paramSchema defaults and can clear it (empty form)', async () => {
    const workload = await createWorkload({
      name: uniqueName('wl-param-update'),
      initScript: 'echo',
      paramSchema: [
        { key: 'mode', label: '模式', type: 'SELECT', options: ['fast', 'slow'], defaultValue: 'fast' },
      ],
    });

    const updated = await adminGql<{ adminUpdateCloudWorkload: WorkloadNode }>(
      UPDATE,
      {
        id: workload.id,
        input: {
          paramSchema: [
            { key: 'mode', label: '模式', type: 'SELECT', options: ['fast', 'slow'], defaultValue: 'slow' },
            { key: 'verbose', label: '详细', type: 'BOOLEAN', defaultValue: true },
          ],
        },
      },
      token,
    );
    expect(updated.errors, JSON.stringify(updated.errors)).toBeUndefined();
    expect(updated.data!.adminUpdateCloudWorkload.paramSchema).toEqual([
      { key: 'mode', label: '模式', type: 'SELECT', options: ['fast', 'slow'], defaultValue: 'slow' },
      { key: 'verbose', label: '详细', type: 'BOOLEAN', options: [], defaultValue: true },
    ]);

    // 空表单 → 无参数配置
    const cleared = await adminGql<{ adminUpdateCloudWorkload: WorkloadNode }>(
      UPDATE,
      { id: workload.id, input: { paramSchema: [] } },
      token,
    );
    expect(cleared.errors).toBeUndefined();
    expect(cleared.data!.adminUpdateCloudWorkload.paramSchema).toEqual([]);
  });

  it('T-IA: rejects illegal paramSchema entries with field-path errors', async () => {
    const cases: Array<{ label: string; paramSchema: ParamFieldInput[]; message: string }> = [
      {
        label: 'key 非法',
        paramSchema: [{ key: '1bad', label: 'L', type: 'TEXT', defaultValue: 'x' }],
        message: 'paramSchema[0].key is invalid',
      },
      {
        label: 'label 为空',
        paramSchema: [{ key: 'ok', label: '', type: 'TEXT', defaultValue: 'x' }],
        message: 'paramSchema[0].label is invalid',
      },
      {
        label: 'label 超长',
        paramSchema: [{ key: 'ok', label: 'L'.repeat(65), type: 'TEXT', defaultValue: 'x' }],
        message: 'paramSchema[0].label is invalid',
      },
      {
        label: 'options 为空',
        paramSchema: [{ key: 'ok', label: 'L', type: 'SELECT', options: [], defaultValue: 'a' }],
        message: 'paramSchema[0].options is invalid',
      },
      {
        label: 'options 重复',
        paramSchema: [{ key: 'ok', label: 'L', type: 'SELECT', options: ['a', 'a'], defaultValue: 'a' }],
        message: 'paramSchema[0].options is invalid',
      },
      {
        label: 'options 超限',
        paramSchema: [
          {
            key: 'ok',
            label: 'L',
            type: 'SELECT',
            options: Array.from({ length: 51 }, (_, i) => `o${i}`),
            defaultValue: 'o0',
          },
        ],
        message: 'paramSchema[0].options is invalid',
      },
      {
        label: 'SELECT 默认值不在可选项内',
        paramSchema: [{ key: 'ok', label: 'L', type: 'SELECT', options: ['a'], defaultValue: 'b' }],
        message: 'paramSchema[0].defaultValue is invalid',
      },
      {
        label: 'MULTI_SELECT 默认值非数组',
        paramSchema: [{ key: 'ok', label: 'L', type: 'MULTI_SELECT', options: ['a'], defaultValue: 'a' }],
        message: 'paramSchema[0].defaultValue is invalid',
      },
      {
        label: 'BOOLEAN 默认值类型不符',
        paramSchema: [{ key: 'ok', label: 'L', type: 'BOOLEAN', defaultValue: 'true' }],
        message: 'paramSchema[0].defaultValue is invalid',
      },
      {
        label: 'key 重复',
        paramSchema: [
          { key: 'ok', label: 'L', type: 'TEXT', defaultValue: 'x' },
          { key: 'ok', label: 'L2', type: 'TEXT', defaultValue: 'y' },
        ],
        message: 'paramSchema[1].key is duplicated',
      },
      {
        label: '参数数量超限',
        paramSchema: Array.from({ length: 21 }, (_, i) => ({
          key: `p${i}`,
          label: 'L',
          type: 'TEXT',
          defaultValue: 'x',
        })),
        message: 'too many parameters',
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const res = await adminGql(
        CREATE,
        {
          input: {
            name: uniqueName(`wl-bad-param-${index}`),
            initScript: 'echo',
            paramSchema: testCase.paramSchema,
          },
        },
        token,
      );
      expect(res.errors?.[0].message, testCase.label).toBe(testCase.message);
    }
  });

  // -------------------------------------------------------------------------
  // 工作负载一期：依赖保存（T-W10）
  // -------------------------------------------------------------------------

  it('T-IA: saves dependencies in configuration order and dedupes them', async () => {
    const depA = await createWorkload({ name: uniqueName('wl-dep-a'), initScript: 'echo a' });
    const depB = await createWorkload({ name: uniqueName('wl-dep-b'), initScript: 'echo b' });
    const parent = await createWorkload({
      name: uniqueName('wl-dep-parent'),
      initScript: 'echo parent',
      dependsOnWorkloadIds: [depA.id, depB.id, depA.id],
    });
    expect(parent.dependsOnWorkloadIds).toEqual([depA.id, depB.id]);
  });

  it('T-IA: rejects self dependency', async () => {
    const workload = await createWorkload({ name: uniqueName('wl-self'), initScript: 'echo' });
    const res = await adminGql(UPDATE, { id: workload.id, input: { dependsOnWorkloadIds: [workload.id] } }, token);
    expect(res.errors?.[0].message).toBe('workload cannot depend on itself');
  });

  it('T-IA: rejects a dependency cycle', async () => {
    const a = await createWorkload({ name: uniqueName('wl-cyc-a'), initScript: 'echo a' });
    // b 依赖 a
    const b = await createWorkload({
      name: uniqueName('wl-cyc-b'),
      initScript: 'echo b',
      dependsOnWorkloadIds: [a.id],
    });
    // 再把 a 指向 b → 成环，应被拒绝并返回环路径
    const cyclic = await adminGql(UPDATE, { id: a.id, input: { dependsOnWorkloadIds: [b.id] } }, token);
    expect(cyclic.errors?.[0].message).toContain('dependency cycle detected');
  });

  it('T-IA: rejects missing and too many dependencies', async () => {
    const missing = await adminGql(
      CREATE,
      {
        input: {
          name: uniqueName('wl-missing-dep'),
          initScript: 'echo',
          dependsOnWorkloadIds: [new mongoose.Types.ObjectId().toString()],
        },
      },
      token,
    );
    expect(missing.errors?.[0].message).toBe('dependency workload not found');

    const many = await adminGql(
      CREATE,
      {
        input: {
          name: uniqueName('wl-many-dep'),
          initScript: 'echo',
          dependsOnWorkloadIds: Array.from({ length: 6 }, () =>
            new mongoose.Types.ObjectId().toString(),
          ),
        },
      },
      token,
    );
    expect(many.errors?.[0].message).toBe('too many dependencies');
  });

  // -------------------------------------------------------------------------
  // 工作负载一期：预制项存在性与幂等（T-MIG1/T-MIG2）
  // -------------------------------------------------------------------------

  it('T-IA: exposes the eight preset workloads with stable ids (idempotent)', async () => {
    const first = await adminGql<{ adminCloudWorkloads: WorkloadNode[] }>(LIST, undefined, token);
    expect(first.errors).toBeUndefined();
    const all = first.data!.adminCloudWorkloads;
    const byName = new Map(all.map((workload) => [workload.name, workload]));

    for (const name of ['Docker', 'Node.js', '.NET', 'Aspire', 'OpenCode（Harness）', 'Kimi Code（Harness）', 'DeepSeek Harness（Harness）', 'Github']) {
      const preset = byName.get(name);
      expect(preset, `preset ${name} should exist`).toBeTruthy();
      expect(preset!.isPreset, `preset ${name} isPreset`).toBe(true);
      // 迁移只补缺不覆盖：同名预制项只应存在一个
      expect(all.filter((workload) => workload.name === name)).toHaveLength(1);
    }

    const docker = byName.get('Docker')!;
    const dotnet = byName.get('.NET')!;
    const aspire = byName.get('Aspire')!;
    // Aspire 依赖 Docker → .NET（顺序即初始化顺序）
    expect(aspire.dependsOnWorkloadIds).toEqual([docker.id, dotnet.id]);

    const nodejs = byName.get('Node.js')!;
    expect(nodejs.paramSchema?.map((field) => field.key)).toEqual(['version', 'package_manager']);
    expect(nodejs.paramSchema?.[0]).toMatchObject({ type: 'TEXT', defaultValue: '22' });
    expect(nodejs.paramSchema?.[1]).toMatchObject({
      type: 'MULTI_SELECT',
      options: ['npm', 'pnpm', 'bun', 'yarn'],
      defaultValue: ['npm'],
    });

    // 重复查询稳定：预制项 ID 集合不变（迁移不会重复写入/重建）
    const second = await adminGql<{ adminCloudWorkloads: WorkloadNode[] }>(LIST, undefined, token);
    const presetIds = (list: WorkloadNode[]) =>
      list.filter((workload) => workload.isPreset).map((workload) => workload.id).sort();
    expect(presetIds(second.data!.adminCloudWorkloads)).toEqual(presetIds(all));
    expect(presetIds(all)).toHaveLength(8);

    // T-ADM-WL-API1：分类透出（standard → STANDARD/null，harness → HARNESS/<slug>）
    expect(docker.workloadKind).toBe('STANDARD');
    expect(docker.harnessType).toBeNull();
    const harness = byName.get('OpenCode（Harness）')!;
    expect(harness.workloadKind).toBe('HARNESS');
    expect(harness.harnessType).toBe('opencode');
    const kimi = byName.get('Kimi Code（Harness）')!;
    expect(kimi.workloadKind).toBe('HARNESS');
    expect(kimi.harnessType).toBe('kimi_code');
    expect(kimi.paramSchema).toEqual([]);
    expect(kimi.initScript).toContain('@moonshot-ai/kimi-code@2.3.2');
    expect(kimi.initScript).toContain('kimi --version');
    expect(kimi.initScript).not.toContain('agent-gear harness prepare');
    const deepseek = byName.get('DeepSeek Harness（Harness）')!;
    expect(deepseek.workloadKind).toBe('HARNESS');
    expect(deepseek.harnessType).toBe('deepseek_harness');
    expect(deepseek.paramSchema).toEqual([]);
    expect(deepseek.initScript).toContain(
      'npm install -g "@deepseek-ai/dsh@${DSH_CLI_VERSION}" "@deepseek-ai/dsh-acp-app@${DSH_ACP_APP_VERSION}"',
    );
    expect(deepseek.initScript).toContain('dsh --version');
    expect(deepseek.initScript).toContain('agent-gear harness prepare');
    expect(deepseek.dependsOnWorkloadIds).toEqual([]);
    for (const workload of all) {
      expect(['STANDARD', 'HARNESS']).toContain(workload.workloadKind);
    }
  });

  it('T-IA: preset .NET uses the apt-based init script (migration 002 upgrade)', async () => {
    const res = await adminGql<{ adminCloudWorkloads: WorkloadNode[] }>(LIST, undefined, token);
    expect(res.errors).toBeUndefined();
    const dotnet = res.data!.adminCloudWorkloads.find((workload) => workload.name === '.NET');
    expect(dotnet, 'preset .NET should exist').toBeTruthy();
    const script = dotnet!.initScript ?? '';
    // apt 版：apt-get install + 默认包名，且不再依赖 dotnet-install.sh
    expect(script).toContain('apt-get install');
    expect(script).toContain('dotnet10');
    expect(script).not.toContain('dotnet-install.sh');
  });

  it('T-IA: preset Aspire uses the proxied-package init script (migration 004 upgrade)', async () => {
    // 内网缓存代理安装包直链（与迁移 004 ASPIRE_CLI_URL_DEFAULT 一致）
    const aspireCliUrlDefault =
      'https://nexus.internal.fffdan.com/repository/misc-cache/dotnet/aspire-cli-linux-x64.tar.gz';

    const res = await adminGql<{ adminCloudWorkloads: WorkloadNode[] }>(LIST, undefined, token);
    expect(res.errors).toBeUndefined();
    const aspire = res.data!.adminCloudWorkloads.find((workload) => workload.name === 'Aspire');
    expect(aspire, 'preset Aspire should exist').toBeTruthy();

    // 下载地址成为可见参数，默认值为内网代理安装包直链
    const param = aspire!.paramSchema?.find((field) => field.key === 'aspire_cli_url');
    expect(param, 'aspire_cli_url param should exist').toBeTruthy();
    expect(param).toMatchObject({
      key: 'aspire_cli_url',
      label: 'Aspire CLI 下载地址',
      type: 'TEXT',
      options: [],
      defaultValue: aspireCliUrlDefault,
    });

    // 脚本直连下载解压，且不再引用官方安装渠道（脚本内不内置默认地址）
    const script = aspire!.initScript ?? '';
    expect(script).toContain('curl -fsSL');
    expect(script).toContain('tar -xzf');
    expect(script).not.toContain('install.sh');
    expect(script).not.toContain('aspire.dev');
    expect(script).not.toContain('aka.ms');
    expect(script).not.toContain('ASPIRE_INSTALL_URL');

    // 重复查询预制项 ID 集合稳定（迁移不重复写入/重建）
    const second = await adminGql<{ adminCloudWorkloads: WorkloadNode[] }>(LIST, undefined, token);
    const aspireIds = (list: WorkloadNode[]) =>
      list.filter((workload) => workload.name === 'Aspire').map((workload) => workload.id).sort();
    expect(aspireIds(second.data!.adminCloudWorkloads)).toEqual(
      aspireIds(res.data!.adminCloudWorkloads),
    );
  });
});
