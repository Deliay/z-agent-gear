import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Session } from './session.js';
import { Controller } from './controller.js';
import { ControllerKey } from './controller-key.js';
import { CloudHost } from './cloud-host.js';
import { ConfiguredWorkflow } from './configured-workflow.js';
import { WorkflowInstance } from './workflow-instance.js';
import { WorkflowTemplate } from './workflow-template.js';
import { GitHubAccount } from './github-account.js';
import { UserCommitSetting } from './user-commit-setting.js';
import { Provider } from './provider.js';
import { Model } from './model.js';
import { WORKSPACE_ID_COLLECTIONS } from '../migrations/015-team-workspaces.js';
import { runWithWorkspace, type WorkspaceContext } from '../services/workspace-context.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-workspace-isolation-test'));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(
    collections.map(async (collection) => {
      await collection.deleteMany({});
      await collection.dropIndexes().catch(() => undefined);
    }),
  );
});

const TENANT = '507f1f77bcf86cd7994390a1';
const WS_A = '507f1f77bcf86cd7994390b1';
const WS_B = '507f1f77bcf86cd7994390b2';
const WS_GLOBAL = '507f1f77bcf86cd7994390b3';
const BUILTIN_ID = new mongoose.Types.ObjectId();

const adminA: WorkspaceContext = {
  id: WS_A,
  tenantId: TENANT,
  type: 'normal',
  role: 'admin',
  readOnly: false,
  globalWorkspaceId: WS_GLOBAL,
};
const devA: WorkspaceContext = { ...adminA, role: 'developer' };
const devB: WorkspaceContext = { ...adminA, id: WS_B, role: 'developer' };
const devGlobal: WorkspaceContext = {
  id: WS_GLOBAL,
  tenantId: TENANT,
  type: 'global',
  role: 'developer',
  readOnly: true,
  globalWorkspaceId: WS_GLOBAL,
};

interface Case {
  name: string;
  model: mongoose.Model<unknown>;
  field: 'workspaceId' | 'resourceWorkspaceId';
  shared?: boolean;
  builtin?: boolean;
}

const CASES: Case[] = [
  { name: 'sessions', model: Session as unknown as mongoose.Model<unknown>, field: 'workspaceId' },
  { name: 'controllers', model: Controller as unknown as mongoose.Model<unknown>, field: 'workspaceId' },
  { name: 'controllerkeys', model: ControllerKey as unknown as mongoose.Model<unknown>, field: 'workspaceId' },
  { name: 'cloudhosts', model: CloudHost as unknown as mongoose.Model<unknown>, field: 'resourceWorkspaceId' },
  { name: 'configuredworkflows', model: ConfiguredWorkflow as unknown as mongoose.Model<unknown>, field: 'resourceWorkspaceId' },
  { name: 'workflowinstances', model: WorkflowInstance as unknown as mongoose.Model<unknown>, field: 'resourceWorkspaceId' },
  { name: 'workflowtemplates', model: WorkflowTemplate as unknown as mongoose.Model<unknown>, field: 'resourceWorkspaceId', builtin: true },
  { name: 'githubaccounts', model: GitHubAccount as unknown as mongoose.Model<unknown>, field: 'workspaceId', shared: true },
  { name: 'user_commit_settings', model: UserCommitSetting as unknown as mongoose.Model<unknown>, field: 'workspaceId' },
  { name: 'providers', model: Provider as unknown as mongoose.Model<unknown>, field: 'workspaceId', shared: true },
  { name: 'models', model: Model as unknown as mongoose.Model<unknown>, field: 'workspaceId', shared: true },
];

function isSharedType(name: string): boolean {
  return name === 'githubaccounts' || name === 'providers' || name === 'models';
}

/**
 * T-WS 矩阵：11 集合 × 真实 Mongoose 查询中间件 × admin/developer 两档。
 * 断言：普通工作区仅见本工作区；共享型额外见本租户全局；全局上下文仅见全局；
 * 内置模板全工作区可见；角色不放大可见集（admin 通过切换工作区上下文直达）。
 */
describe('workspace-isolation 矩阵（T-WS，真库）', () => {
  it('迁移清单覆盖 11 个资源集合，且集合名与模型一致', () => {
    const modelCollections = CASES.map((item) => item.model.collection.name).sort();
    const migrationCollections = WORKSPACE_ID_COLLECTIONS.map((entry) => entry.collection).sort();
    expect(migrationCollections).toEqual(
      modelCollections.filter((name) => name !== 'providers' && name !== 'models'),
    );
    expect(CASES).toHaveLength(11);
  });

  it.each(CASES)('$name：工作区 / 角色两档可见集', async (testCase) => {
    const collection = mongoose.connection.collection(testCase.model.collection.name);
    const stringField = testCase.name === 'githubaccounts' || testCase.name === 'user_commit_settings';
    const base = {
      tenantId: stringField ? TENANT : new mongoose.Types.ObjectId(TENANT),
      userId: new mongoose.Types.ObjectId(),
      scope: isSharedType(testCase.name) ? 'user' : undefined,
    };
    const ws = (id: string) => (stringField ? id : new mongoose.Types.ObjectId(id));
    await collection.insertOne({ ...base, [testCase.field]: ws(WS_A) });
    await collection.insertOne({ ...base, [testCase.field]: ws(WS_B) });
    await collection.insertOne({ ...base, [testCase.field]: ws(WS_GLOBAL) });
    if (testCase.builtin) {
      await collection.insertOne({
        _id: BUILTIN_ID,
        userId: null,
        tenantId: null,
        isBuiltin: true,
        name: '内置模板',
        resourceWorkspaceId: null,
      });
    }

    const count = (context: WorkspaceContext) =>
      runWithWorkspace(context, async () =>
        testCase.model.countDocuments(
          testCase.builtin
            ? { $or: [{ tenantId: base.tenantId }, { isBuiltin: true }] }
            : { tenantId: base.tenantId },
        ),
      );

    const expectedNormal = testCase.builtin ? 2 : isSharedType(testCase.name) ? 2 : 1;
    expect(await count(adminA)).toBe(expectedNormal);
    expect(await count(devA)).toBe(expectedNormal);
    // 不同工作区上下文只看到自身（不因角色放大）
    expect(await count(devB)).toBe(expectedNormal);
    // 全局上下文：共享型/模板只看到全局（+内置），独占型只看到全局
    const expectedGlobal = testCase.builtin ? 2 : 1;
    expect(await count(devGlobal)).toBe(expectedGlobal);
  });

  it('工作流域字段名与项目工作区语义零冲突', () => {
    expect(WorkflowInstance.schema.path('workspaceId')?.options.ref).toBe('ControllerWorkspace');
    expect(WorkflowInstance.schema.path('resourceWorkspaceId')?.options.ref).toBe('Workspace');
    expect(CloudHost.schema.path('workspaceId')?.options.ref).toBe('ControllerWorkspace');
    expect(CloudHost.schema.path('resourceWorkspaceId')?.options.ref).toBe('Workspace');
    expect(Session.schema.path('workspaceId')?.options.ref).toBe('Workspace');
  });

  it('三集合不挂作用域插件（不在迁移回填清单）', () => {
    const names = WORKSPACE_ID_COLLECTIONS.map((entry) => entry.collection);
    expect(names).not.toContain('tenantmembers');
    expect(names).not.toContain('workspaces');
    expect(names).not.toContain('workspacemembers');
  });
});
