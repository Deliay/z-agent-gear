import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as migration from './028-knowledge-base.js';
import { KnowledgeBase } from '../models/knowledge-base.js';
import { KnowledgeBaseDocument } from '../models/knowledge-base-document.js';
import { KnowledgeBaseEvent } from '../models/knowledge-base-event.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-migration-028-test'));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const db = () => mongoose.connection.db!;
const bases = () => db().collection('knowledgebases');
const documents = () => db().collection('knowledgebasedocuments');
const events = () => db().collection('knowledgebaseevents');

beforeEach(async () => {
  await Promise.all([
    bases().drop().catch(() => undefined),
    documents().drop().catch(() => undefined),
    events().drop().catch(() => undefined),
  ]);
});

describe('migration 028 knowledge base', () => {
  it('T-MIG-KB1: 三集合索引名/键与模型声明一致', async () => {
    await migration.createKnowledgeBaseIndexes();

    const baseByName = new Map((await bases().indexes()).map((index) => [index.name, index]));
    expect(baseByName.get('uniq_knowledge_base_workspace_name')).toMatchObject({
      key: { workspaceId: 1, name: 1 },
      unique: true,
    });
    expect(baseByName.get('knowledge_base_tenant_workspace')).toMatchObject({
      key: { tenantId: 1, workspaceId: 1 },
    });

    const docByName = new Map((await documents().indexes()).map((index) => [index.name, index]));
    expect(docByName.get('uniq_knowledge_base_doc_path')).toMatchObject({
      key: { knowledgeBaseId: 1, path: 1 },
      unique: true,
    });

    const eventByName = new Map((await events().indexes()).map((index) => [index.name, index]));
    expect(eventByName.get('knowledge_base_event_recent')).toMatchObject({
      key: { knowledgeBaseId: 1, createdAt: -1 },
    });
    expect(eventByName.get('knowledge_base_event_path_recent')).toMatchObject({
      key: { knowledgeBaseId: 1, path: 1, createdAt: -1 },
    });
  });

  it('T-MIG-KB2: 迁移重跑幂等（不报错、索引数量与定义不变）', async () => {
    await migration.run();
    const snapshot = async () =>
      [
        (await bases().indexes()).map((index) => index.name).sort(),
        (await documents().indexes()).map((index) => index.name).sort(),
        (await events().indexes()).map((index) => index.name).sort(),
      ] as const;
    const first = await snapshot();

    await expect(migration.run()).resolves.toBeUndefined();
    expect(await snapshot()).toEqual(first);
    expect(first[0]).toHaveLength(3); // _id_ + 2
    expect(first[1]).toHaveLength(2); // _id_ + 1
    expect(first[2]).toHaveLength(3); // _id_ + 2
  });

  it('T-MIG-KB3: 名称 028-knowledge-base 且先建后用（模型声明的索引名可被迁移保证）', async () => {
    expect(migration.name).toBe('028-knowledge-base');
    const declaredNames = [
      ...KnowledgeBase.schema.indexes().map(([keys, options]) => options?.name ?? JSON.stringify(keys)),
      ...KnowledgeBaseDocument.schema.indexes().map(([keys, options]) => options?.name ?? JSON.stringify(keys)),
      ...KnowledgeBaseEvent.schema.indexes().map(([keys, options]) => options?.name ?? JSON.stringify(keys)),
    ];
    const migratedNames = migration.KNOWLEDGE_BASE_INDEXES.map((entry) => entry.options.name);
    for (const name of migratedNames) {
      expect(declaredNames).toContain(name);
    }
  });
});
