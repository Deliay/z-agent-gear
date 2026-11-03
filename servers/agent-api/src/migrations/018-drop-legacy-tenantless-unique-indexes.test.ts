import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as migration from './018-drop-legacy-tenantless-unique-indexes.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-migration-018-test'));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const db = () => mongoose.connection.db!;

beforeEach(async () => {
  await db().dropDatabase();
});

async function indexNames(collection: string): Promise<string[]> {
  return (await db().collection(collection).indexes()).map((index) => index.name ?? '');
}

describe('migration 018-drop-legacy-tenantless-unique-indexes', () => {
  it('exposes the migration name', () => {
    expect(migration.name).toBe('018-drop-legacy-tenantless-unique-indexes');
  });

  it('drops tenantless legacy unique indexes and keeps the tenant-aware ones', async () => {
    await db()
      .collection('mcpservers')
      .createIndex({ userId: 1, name: 1 }, { unique: true, name: 'userId_1_name_1' });
    await db()
      .collection('mcpservers')
      .createIndex({ tenantId: 1, userId: 1, name: 1 }, { unique: true });
    await db()
      .collection('githubaccounts')
      .createIndex({ userId: 1, githubUserId: 1 }, { unique: true, name: 'userId_1_githubUserId_1' });
    await db()
      .collection('githubaccounts')
      .createIndex(
        { tenantId: 1, workspaceId: 1, githubUserId: 1 },
        { unique: true, name: 'uniq_github_account_tenant_workspace_user' },
      );

    await migration.run();

    const mcpIndexes = await indexNames('mcpservers');
    expect(mcpIndexes).not.toContain('userId_1_name_1');
    expect(mcpIndexes).toContain('tenantId_1_userId_1_name_1');

    const githubIndexes = await indexNames('githubaccounts');
    expect(githubIndexes).not.toContain('userId_1_githubUserId_1');
    expect(githubIndexes).toContain('uniq_github_account_tenant_workspace_user');
  });

  it('drops the legacy index even when a custom name was used', async () => {
    await db()
      .collection('mcpservers')
      .createIndex({ userId: 1, name: 1 }, { unique: true, name: 'custom_legacy_name_unique' });

    await migration.run();

    expect(await indexNames('mcpservers')).not.toContain('custom_legacy_name_unique');
  });

  it('is idempotent when the legacy indexes are already gone', async () => {
    await db()
      .collection('mcpservers')
      .createIndex({ tenantId: 1, userId: 1, name: 1 }, { unique: true });

    await expect(migration.run()).resolves.toBeUndefined();
    await expect(migration.run()).resolves.toBeUndefined();
    expect(await indexNames('mcpservers')).toContain('tenantId_1_userId_1_name_1');
  });

  it('allows the same user to have the same server name in two tenants after the drop', async () => {
    const userId = 'user-1';
    await db()
      .collection('mcpservers')
      .createIndex({ userId: 1, name: 1 }, { unique: true, name: 'userId_1_name_1' });
    await db()
      .collection('mcpservers')
      .createIndex({ tenantId: 1, userId: 1, name: 1 }, { unique: true });

    await db().collection('mcpservers').insertOne({ userId, tenantId: 'tenant-a', name: 'agent-workflow-admin-tools' });
    await expect(
      db().collection('mcpservers').insertOne({ userId, tenantId: 'tenant-b', name: 'agent-workflow-admin-tools' }),
    ).rejects.toMatchObject({ code: 11000 });

    await migration.run();

    await db().collection('mcpservers').insertOne({ userId, tenantId: 'tenant-b', name: 'agent-workflow-admin-tools' });
    expect(await db().collection('mcpservers').countDocuments({ userId })).toBe(2);
  });
});
