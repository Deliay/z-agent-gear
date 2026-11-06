import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as migration from './023-valut-foundations.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-migration-023-test'));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

/** D12 四集合：valutnamespaces / valutentries / valutrefs / custommcpservers */
const FOUR_COLLECTIONS = ['valutnamespaces', 'valutentries', 'valutrefs', 'custommcpservers'];

const collection = (name: string) => mongoose.connection.db!.collection(name);

beforeEach(async () => {
  for (const name of FOUR_COLLECTIONS) {
    await collection(name).drop().catch(() => undefined);
  }
});

interface IndexSnapshotEntry {
  name?: string;
  key: Record<string, unknown>;
  unique: boolean;
}

async function indexSnapshot(): Promise<Record<string, IndexSnapshotEntry[]>> {
  const snapshot: Record<string, IndexSnapshotEntry[]> = {};
  for (const name of FOUR_COLLECTIONS) {
    const indexes = (await collection(name).indexes().catch(() => [])) as Array<{
      name?: string;
      key: Record<string, unknown>;
      unique?: boolean;
    }>;
    snapshot[name] = indexes
      .map((index) => ({ name: index.name, key: index.key, unique: index.unique === true }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  return snapshot;
}

function findIndex(entries: IndexSnapshotEntry[], name: string): IndexSnapshotEntry {
  const hit = entries.find((entry) => entry.name === name);
  if (!hit) throw new Error(`index ${name} not found: ${entries.map((e) => e.name).join(', ')}`);
  return hit;
}

describe('migration 023 valut foundations（T-MIG23）', () => {
  it('T-MIG23-1: 幂等播种 manual namespace（displayName「自定义密钥」，managed=false）', async () => {
    await migration.run();
    const manual = await collection('valutnamespaces').findOne({ name: 'manual' });
    expect(manual).toMatchObject({ name: 'manual', displayName: '自定义密钥', managed: false });
    expect(await collection('valutnamespaces').countDocuments({ name: 'manual' })).toBe(1);
  });

  it('T-MIG23-2: 四集合索引齐备（名称、键、唯一性与模型声明同名）', async () => {
    await migration.run();

    const namespaces = findIndex(
      await indexSnapshot().then((s) => s.valutnamespaces),
      'uniq_valut_namespace_name',
    );
    expect(namespaces).toMatchObject({ key: { name: 1 }, unique: true });

    const entries = await indexSnapshot().then((s) => s.valutentries);
    expect(findIndex(entries, 'uniq_valut_entry_workspace_namespace_key')).toMatchObject({
      key: { workspaceId: 1, namespace: 1, key: 1 },
      unique: true,
    });

    const refs = await indexSnapshot().then((s) => s.valutrefs);
    expect(findIndex(refs, 'uniq_valut_ref_feature_refid')).toMatchObject({
      key: { feature: 1, refId: 1 },
      unique: true,
    });
    expect(findIndex(refs, 'valut_ref_entry')).toMatchObject({
      key: { valutEntryId: 1 },
      unique: false,
    });

    const customMcps = await indexSnapshot().then((s) => s.custommcpservers);
    expect(findIndex(customMcps, 'uniq_custom_mcp_workspace_name')).toMatchObject({
      key: { workspaceId: 1, name: 1 },
      unique: true,
    });
  });

  it('T-MIG23-3: 重复执行零变更（索引快照一致、manual 单行）', async () => {
    await migration.run();
    const first = await indexSnapshot();
    const firstManualCount = await collection('valutnamespaces').countDocuments({ name: 'manual' });

    await expect(migration.run()).resolves.toBeUndefined();

    const second = await indexSnapshot();
    expect(second).toEqual(first);
    expect(await collection('valutnamespaces').countDocuments({ name: 'manual' })).toBe(
      firstManualCount,
    );
    expect(firstManualCount).toBe(1);
  });

  it('T-MIG23-4: 已存在的 manual 行不被覆盖（$setOnInsert 幂等语义）', async () => {
    await collection('valutnamespaces').insertOne({
      name: 'manual',
      displayName: '历史展示名',
      managed: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await migration.run();

    const manual = await collection('valutnamespaces').findOne({ name: 'manual' });
    expect(manual).toMatchObject({ displayName: '历史展示名', managed: true });
    expect(await collection('valutnamespaces').countDocuments({ name: 'manual' })).toBe(1);
  });
});
