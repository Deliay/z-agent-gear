import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as migration from './017-normalize-string-workspace-id.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-migration-017-test'));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const db = () => mongoose.connection.db!;

beforeEach(async () => {
  await db().dropDatabase();
});

const tenantId = new mongoose.Types.ObjectId();

function account(overrides: Record<string, unknown>) {
  return {
    userId: 'user-1',
    tenantId: String(tenantId),
    githubUserId: 1,
    githubLogin: 'octo',
    accessToken: 'token',
    ...overrides,
  };
}

describe('migration 017-normalize-string-workspace-id', () => {
  it('exposes the migration name', () => {
    expect(migration.name).toBe('017-normalize-string-workspace-id');
  });

  it('converts ObjectId workspaceId to String for string-typed collections only', async () => {
    const ws1 = new mongoose.Types.ObjectId();
    const ws2 = new mongoose.Types.ObjectId();
    await db().collection('githubaccounts').insertMany([
      account({ workspaceId: ws1, githubUserId: 1 }),
      account({ userId: 'user-2', workspaceId: String(ws2), githubUserId: 2 }),
    ]);
    await db().collection('user_commit_settings').insertMany([
      { userId: 'user-1', tenantId: String(tenantId), workspaceId: ws1, committerMode: 'unset' },
      { userId: 'user-2', tenantId: String(tenantId), workspaceId: String(ws2), committerMode: 'unset' },
    ]);
    // 非目标集合（ObjectId 口径）不应被改动
    await db().collection('sessions').insertOne({ workspaceId: ws1 });

    const result = await migration.normalizeStringWorkspaceIds();

    expect(result.githubaccounts).toEqual({ converted: 1, deduped: 0 });
    expect(result.user_commit_settings).toEqual({ converted: 1, deduped: 0 });

    const accounts = await db().collection('githubaccounts').find({}).sort({ githubUserId: 1 }).toArray();
    expect(accounts.map((row) => row.workspaceId)).toEqual([String(ws1), String(ws2)]);
    expect(accounts.every((row) => typeof row.workspaceId === 'string')).toBe(true);

    const settings = await db().collection('user_commit_settings').find({}).toArray();
    expect(settings.every((row) => typeof row.workspaceId === 'string')).toBe(true);

    const sessions = await db().collection('sessions').find({}).toArray();
    expect(sessions[0].workspaceId).toBeInstanceOf(mongoose.Types.ObjectId);
  });

  it('drops legacy ObjectId rows when an equivalent String row already exists', async () => {
    const ws = new mongoose.Types.ObjectId();
    // 迁移失败后应用已用 String 口径写入新行
    await db().collection('githubaccounts').insertOne(account({ workspaceId: String(ws), userId: 'new-user' }));
    await db().collection('githubaccounts').insertOne(account({ workspaceId: ws, userId: 'old-user' }));
    await db().collection('user_commit_settings').insertOne({
      userId: 'new-user',
      tenantId: String(tenantId),
      workspaceId: String(ws),
      committerMode: 'co_author',
    });
    await db().collection('user_commit_settings').insertOne({
      userId: 'old-user',
      tenantId: String(tenantId),
      workspaceId: ws,
      committerMode: 'unset',
    });

    const result = await migration.normalizeStringWorkspaceIds();

    expect(result.githubaccounts).toEqual({ converted: 0, deduped: 1 });
    expect(result.user_commit_settings).toEqual({ converted: 0, deduped: 1 });

    const accounts = await db().collection('githubaccounts').find({}).toArray();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].userId).toBe('new-user');
    expect(typeof accounts[0].workspaceId).toBe('string');

    const settings = await db().collection('user_commit_settings').find({}).toArray();
    expect(settings).toHaveLength(1);
    expect(settings[0].userId).toBe('new-user');
    expect(settings[0].committerMode).toBe('co_author');
    expect(typeof settings[0].workspaceId).toBe('string');
  });

  it('dedupes multiple legacy ObjectId rows converted to the same workspace, keeping the newest', async () => {
    const ws = new mongoose.Types.ObjectId();
    await db().collection('user_commit_settings').insertMany([
      { userId: 'old', tenantId: String(tenantId), workspaceId: ws, committerMode: 'unset', updatedAt: new Date('2026-01-01') },
      { userId: 'newest', tenantId: String(tenantId), workspaceId: ws, committerMode: 'human_only', updatedAt: new Date('2026-02-01') },
    ]);

    const result = await migration.normalizeStringWorkspaceIds();

    expect(result.user_commit_settings).toEqual({ converted: 1, deduped: 1 });
    const settings = await db().collection('user_commit_settings').find({}).toArray();
    expect(settings).toHaveLength(1);
    expect(settings[0].userId).toBe('newest');
    expect(settings[0].committerMode).toBe('human_only');
    expect(typeof settings[0].workspaceId).toBe('string');
  });

  it('is idempotent on re-run', async () => {
    const ws = new mongoose.Types.ObjectId();
    await db().collection('githubaccounts').insertOne(account({ workspaceId: ws }));
    await db().collection('user_commit_settings').insertOne({
      userId: 'user-1',
      tenantId: String(tenantId),
      workspaceId: ws,
      committerMode: 'unset',
    });

    await migration.run();
    const first = {
      accounts: await db().collection('githubaccounts').find({}).toArray(),
      settings: await db().collection('user_commit_settings').find({}).toArray(),
    };

    const second = await migration.normalizeStringWorkspaceIds();
    expect(second.githubaccounts).toEqual({ converted: 0, deduped: 0 });
    expect(second.user_commit_settings).toEqual({ converted: 0, deduped: 0 });
    expect(await db().collection('githubaccounts').find({}).toArray()).toEqual(first.accounts);
    expect(await db().collection('user_commit_settings').find({}).toArray()).toEqual(first.settings);
  });
});
