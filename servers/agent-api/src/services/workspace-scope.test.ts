import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import {
  injectWorkspaceFilter,
  injectWorkspaceUpsert,
  applyWorkspaceScope,
} from './workspace-scope.js';
import {
  enterWithWorkspace,
  runWithWorkspace,
  WORKSPACE_READ_ONLY_MESSAGE,
  type WorkspaceContext,
} from './workspace-context.js';

type QueryLike = {
  filter: Record<string, unknown>;
  update?: Record<string, unknown>;
  options?: Record<string, unknown>;
  getFilter: () => Record<string, unknown>;
  setQuery: (filter: Record<string, unknown>) => void;
  getUpdate?: () => Record<string, unknown> | undefined;
  getOptions?: () => Record<string, unknown> | undefined;
};

function makeQuery(filter: Record<string, unknown>, update?: Record<string, unknown>, options?: Record<string, unknown>): QueryLike {
  const query: QueryLike = {
    filter,
    update,
    options,
    getFilter: () => query.filter,
    setQuery: (next) => {
      query.filter = next;
    },
    getUpdate: () => query.update,
    getOptions: () => query.options,
  };
  return query;
}

const CURRENT = '507f1f77bcf86cd799439011';
const GLOBAL = '507f1f77bcf86cd799439012';
const TENANT = '507f1f77bcf86cd799439013';

const devNormal: WorkspaceContext = {
  id: CURRENT,
  tenantId: TENANT,
  type: 'normal',
  role: 'developer',
  readOnly: false,
  globalWorkspaceId: GLOBAL,
};
const devGlobal: WorkspaceContext = {
  id: GLOBAL,
  tenantId: TENANT,
  type: 'global',
  role: 'developer',
  readOnly: true,
  globalWorkspaceId: GLOBAL,
};

describe('workspace-scope（T-SCOPE）', () => {
  beforeEach(() => {
    enterWithWorkspace(undefined);
  });

  it('T-SCOPE1: 独占型读注入当前工作区可见集', () => {
    const query = makeQuery({ userId: 'u1' });
    runWithWorkspace(devNormal, () => injectWorkspaceFilter(query, {}));
    expect(query.filter).toEqual({
      $and: [{ userId: 'u1' }, { workspaceId: { $in: [CURRENT] } }],
    });
  });

  it('T-SCOPE2: 共享型读注入 [当前, 本租户全局]', () => {
    const query = makeQuery({});
    runWithWorkspace(devNormal, () => injectWorkspaceFilter(query, { shared: true }));
    expect(query.filter).toEqual({
      $and: [{}, { workspaceId: { $in: [CURRENT, GLOBAL] } }],
    });
  });

  it('T-SCOPE3: builtinVisible 放行内置模板', () => {
    const query = makeQuery({});
    runWithWorkspace(devNormal, () =>
      injectWorkspaceFilter(query, { workspaceField: 'resourceWorkspaceId', builtinVisible: true }),
    );
    expect(query.filter).toEqual({
      $and: [
        {},
        {
          $or: [
            { resourceWorkspaceId: { $in: [CURRENT] } },
            { isBuiltin: true },
          ],
        },
      ],
    });
  });

  it('T-SCOPE4: globalScopeVisible 放行平台内置行', () => {
    const query = makeQuery({});
    runWithWorkspace(devNormal, () =>
      injectWorkspaceFilter(query, { shared: true, globalScopeVisible: true }),
    );
    expect(query.filter).toEqual({
      $and: [
        {},
        {
          $or: [
            { workspaceId: { $in: [CURRENT, GLOBAL] } },
            { scope: 'global' },
          ],
        },
      ],
    });
  });

  it('T-SCOPE5: 显式工作区字段不覆盖；无上下文不注入', () => {
    const explicit = makeQuery({ workspaceId: GLOBAL });
    runWithWorkspace(devNormal, () => injectWorkspaceFilter(explicit, { shared: true }));
    expect(explicit.filter).toEqual({ workspaceId: GLOBAL });

    const noStore = makeQuery({});
    enterWithWorkspace(undefined);
    injectWorkspaceFilter(noStore, {});
    expect(noStore.filter).toEqual({});
  });

  it('T-SCOPE6: 写操作共享型也收敛到当前工作区（全局行写被拒）', () => {
    const query = makeQuery({ _id: 'x' });
    runWithWorkspace(devNormal, () => injectWorkspaceFilter(query, { shared: true }, true));
    expect(query.filter).toEqual({
      $and: [{ _id: 'x' }, { workspaceId: { $in: [CURRENT] } }],
    });
  });

  it('T-SCOPE7: upsert 补齐 $setOnInsert 工作区；显式跨工作区拒绝', () => {
    const query = makeQuery(
      { workspaceId: CURRENT },
      { $set: { name: 'x' } },
      { upsert: true },
    );
    runWithWorkspace(devNormal, () => injectWorkspaceUpsert(query, {}));
    expect(query.update).toEqual({ $set: { name: 'x' }, $setOnInsert: { workspaceId: CURRENT } });

    const cross = makeQuery({}, { $set: { workspaceId: GLOBAL } }, { upsert: true });
    expect(() => runWithWorkspace(devNormal, () => injectWorkspaceUpsert(cross, {}))).toThrow(
      'workspace not found',
    );
  });

  it('T-SCOPE8: 只读上下文写拦截文案逐字', () => {
    expect(devGlobal.readOnly).toBe(true);
    expect(WORKSPACE_READ_ONLY_MESSAGE).toBe('global workspace is read-only');
  });

  it('T-SCOPE9: save/validate 路径强制归属当前工作区（共享读不可写全局行）', async () => {
    const schema = new mongoose.Schema({
      name: { type: String },
      tenantId: { type: mongoose.Schema.Types.ObjectId },
      workspaceId: { type: mongoose.Schema.Types.ObjectId },
    });
    applyWorkspaceScope(schema, { shared: true });
    const TestModel = mongoose.model(`WorkspaceScopeDocTest${Date.now()}`, schema);

    // 缺省归属当前工作区
    const doc = new TestModel({ name: 'a' });
    await runWithWorkspace(devNormal, async () => {
      await doc.validate();
      expect(String(doc.workspaceId)).toBe(CURRENT);
    });

    // 显式跨工作区（模拟共享读加载到全局行后 save）
    const foreign = new TestModel({ name: 'b', workspaceId: GLOBAL });
    await runWithWorkspace(devNormal, async () => {
      await expect(foreign.validate()).rejects.toThrow('workspace not found');
    });
  });

  it('T-SCOPE10: 只读上下文 save 被拒绝（global workspace is read-only）', () => {
    const schema = new mongoose.Schema({
      name: { type: String },
      tenantId: { type: mongoose.Schema.Types.ObjectId },
      workspaceId: { type: mongoose.Schema.Types.ObjectId },
    });
    applyWorkspaceScope(schema, {});
    const TestModel = mongoose.model(`WorkspaceScopeReadonlyTest${Date.now()}`, schema);
    const doc = new TestModel({ name: 'c', workspaceId: GLOBAL });
    return runWithWorkspace(devGlobal, async () => {
      await expect(doc.validate()).rejects.toThrow('global workspace is read-only');
    });
  });
});
