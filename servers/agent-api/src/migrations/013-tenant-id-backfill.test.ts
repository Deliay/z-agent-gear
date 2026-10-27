import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import * as migration from './013-tenant-id-backfill.js';

interface FakeCollection {
  name: string;
  find: ReturnType<typeof vi.fn>;
  bulkWrite: ReturnType<typeof vi.fn>;
  createIndex: ReturnType<typeof vi.fn>;
}

describe('migration 013 tenantId backfill', () => {
  let collections: Map<string, FakeCollection>;

  beforeEach(() => {
    collections = new Map();
    vi.spyOn(mongoose.connection, 'collection').mockImplementation(((name: string) => {
      let rows: Array<Record<string, unknown>> = [{ _id: 'row-1', userId: 'u1' }];
      const fake: FakeCollection = {
        name,
        find: vi.fn(() => ({
          limit() {
            return this;
          },
          toArray: async () => {
            const current = rows;
            rows = [];
            return current;
          },
        })),
        bulkWrite: vi.fn(async (ops: unknown[]) => ({ modifiedCount: ops.length })),
        createIndex: vi.fn(async () => name),
      };
      collections.set(name, fake);
      return fake;
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('copies userId into tenantId for all 19 collections and keeps userId', async () => {
    await migration.run();

    expect(collections.size).toBe(19);
    for (const fake of collections.values()) {
      expect(fake.find).toHaveBeenCalledWith(
        { userId: { $exists: true }, tenantId: { $exists: false } },
        { projection: { _id: 1, userId: 1 } },
      );
      const [ops] = fake.bulkWrite.mock.calls[0] as unknown as [
        Array<{ updateOne: { filter: unknown; update: unknown } }>,
      ];
      expect(ops[0].updateOne.update).toEqual({ $set: { tenantId: 'u1' } });
    }
  });

  it('ensures 3 tenant-scoped unique indexes and 16 plain tenantId indexes', async () => {
    await migration.run();

    const uniqueCalls: Array<{ collection: string; keys: unknown }> = [];
    for (const fake of collections.values()) {
      for (const call of fake.createIndex.mock.calls) {
        if (call[1]?.unique) uniqueCalls.push({ collection: fake.name, keys: call[0] });
      }
    }
    expect(uniqueCalls).toEqual(
      expect.arrayContaining([
        { collection: 'mcpservers', keys: { tenantId: 1, userId: 1, name: 1 } },
        { collection: 'githubaccounts', keys: { tenantId: 1, userId: 1, githubUserId: 1 } },
        { collection: 'user_commit_settings', keys: { tenantId: 1, userId: 1 } },
      ]),
    );
    expect(uniqueCalls).toHaveLength(3);
  });

  it('is idempotent: second run performs no updates', async () => {
    await migration.run();

    const emptyBulkWrite = vi.fn();
    const emptyFake = {
      find: vi.fn(() => ({
        limit() {
          return this;
        },
        toArray: async () => [],
      })),
      bulkWrite: emptyBulkWrite,
      createIndex: vi.fn(async () => 'idx'),
    };
    vi.spyOn(mongoose.connection, 'collection').mockImplementation((() => emptyFake) as never);

    await migration.run();

    expect(emptyBulkWrite).not.toHaveBeenCalled();
  });

  it('skips rows without userId (filter only selects userId exists)', async () => {
    await migration.run();
    const fake = collections.get('sessions');
    expect(fake?.find).toHaveBeenCalledWith(
      { userId: { $exists: true }, tenantId: { $exists: false } },
      { projection: { _id: 1, userId: 1 } },
    );
  });
});
