import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { applyTenantScope, injectFilter, injectUpdate } from './tenant-scope.js';
import { runWithWorkspace } from './workspace-context.js';

function fakeQuery(filter: Record<string, unknown>, update?: Record<string, unknown>) {
  const state = { filter, update };
  return {
    getFilter: () => state.filter,
    setQuery: (next: Record<string, unknown>) => {
      state.filter = next;
    },
    getUpdate: () => state.update,
    state,
  };
}

describe('tenant scope plugin', () => {
  it('injects tenantId=userId into query filters', () => {
    const query = fakeQuery({ userId: 'u1' });
    injectFilter(query);
    expect(query.state.filter).toEqual({ userId: 'u1', tenantId: 'u1' });
  });

  it('keeps explicit tenantId (no override)', () => {
    const query = fakeQuery({ userId: 'u1', tenantId: 't9' });
    injectFilter(query);
    expect(query.state.filter).toEqual({ userId: 'u1', tenantId: 't9' });
  });

  it('injects tenantId inside $or branches (workflow template builtin case)', () => {
    const query = fakeQuery({ $or: [{ userId: 'u1' }, { isBuiltin: true }] });
    injectFilter(query);
    expect(query.state.filter).toEqual({
      $or: [{ userId: 'u1', tenantId: 'u1' }, { isBuiltin: true }],
    });
  });

  it('injects tenantId inside $and / nested $or branches', () => {
    const query = fakeQuery({
      $and: [{ $or: [{ userId: 'u1' }, { userId: 'u2' }] }, { status: 'active' }],
    });
    injectFilter(query);
    expect(query.state.filter).toEqual({
      $and: [
        { $or: [{ userId: 'u1', tenantId: 'u1' }, { userId: 'u2', tenantId: 'u2' }] },
        { status: 'active' },
      ],
    });
  });

  it('ignores filters without userId (e.g. _id-only lookups)', () => {
    const query = fakeQuery({ _id: 'x' });
    injectFilter(query);
    expect(query.state.filter).toEqual({ _id: 'x' });
  });

  it('injects tenantId into $set when writing userId', () => {
    const query = fakeQuery({}, { $set: { userId: 'u1', title: 'x' } });
    injectUpdate(query);
    expect(query.state.update).toEqual({ $set: { userId: 'u1', title: 'x', tenantId: 'u1' } });
  });

  it('injects tenantId for top-level userId updates (controller upsert shape)', () => {
    const query = fakeQuery({}, { userId: 'u1', hostname: 'h', $setOnInsert: { name: 'n' } });
    injectUpdate(query);
    expect(query.state.update).toEqual({
      userId: 'u1',
      hostname: 'h',
      tenantId: 'u1',
      $setOnInsert: { name: 'n' },
    });
  });

  it('injects tenantId into $setOnInsert when it carries userId', () => {
    const query = fakeQuery({}, { $set: { status: 'online' }, $setOnInsert: { userId: 'u1' } });
    injectUpdate(query);
    expect(query.state.update).toEqual({
      $set: { status: 'online' },
      $setOnInsert: { userId: 'u1', tenantId: 'u1' },
    });
  });

  it('fills tenantId from userId on document validate', async () => {
    const schema = new mongoose.Schema({
      userId: { type: String, required: true },
      tenantId: { type: String, required: true },
      name: String,
    });
    applyTenantScope(schema);
    const Model = mongoose.model('TenantScopeValidateTest', schema);
    const doc = new Model({ userId: 'u1', name: 'n' });
    await doc.validate();
    expect(doc.tenantId).toBe('u1');
  });

  it('does not apply to schemas without userId/tenantId', () => {
    const schema = new mongoose.Schema({ name: String });
    expect(() => applyTenantScope(schema)).not.toThrow();
  });
});

describe('tenant scope plugin：团队租户请求上下文（阻断-H）', () => {
  const context = {
    id: 'ws-1',
    tenantId: 'team-tenant-1',
    type: 'normal' as const,
    role: 'developer' as const,
    readOnly: false,
    globalWorkspaceId: 'ws-global',
  };

  it('有工作区上下文时注入 context.tenantId（不再复制 userId）', () => {
    const query = fakeQuery({ _id: 'host-1', userId: 'user-1' });
    runWithWorkspace(context, () => injectFilter(query));
    expect(query.state.filter).toEqual({
      _id: 'host-1',
      userId: 'user-1',
      tenantId: 'team-tenant-1',
    });
  });

  it('更新/插入写入 context.tenantId；无上下文仍回退 userId', () => {
    const query = fakeQuery({}, { $set: { userId: 'user-1' } });
    runWithWorkspace(context, () => injectUpdate(query));
    expect((query.state.update as Record<string, unknown>).$set).toEqual({
      userId: 'user-1',
      tenantId: 'team-tenant-1',
    });

    const legacy = fakeQuery({}, { $set: { userId: 'user-1' } });
    injectUpdate(legacy);
    expect((legacy.state.update as Record<string, unknown>).$set).toEqual({
      userId: 'user-1',
      tenantId: 'user-1',
    });
  });
});
