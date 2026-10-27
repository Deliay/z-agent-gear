import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { applyTenantScope, injectFilter, injectUpdate } from './tenant-scope.js';

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
