import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ValutNamespace } from '../models/valut-namespace.js';
import { ValutEntry } from '../models/valut-entry.js';
import { ValutRef } from '../models/valut-ref.js';
import { valutService } from './valut-service.js';
import { runWithWorkspace, type WorkspaceContext } from './workspace-context.js';
import { config } from '../config/index.js';
import { encrypt } from './crypto.js';
import { REDACT_PATHS, createLogger } from '../observability/logger.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-valut-service-test'));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const namespaceCollection = () => mongoose.connection.collection('valutnamespaces');
const entryCollection = () => mongoose.connection.collection('valutentries');
const refCollection = () => mongoose.connection.collection('valutrefs');

beforeEach(async () => {
  await namespaceCollection().deleteMany({});
  await entryCollection().deleteMany({});
  await refCollection().deleteMany({});
  await ValutNamespace.create({ name: 'manual', displayName: '自定义密钥', managed: false });
});

const TENANT = '507f1f77bcf86cd7994390a1';
const WS_A = '507f1f77bcf86cd7994390b1';
const WS_B = '507f1f77bcf86cd7994390b2';
const WS_GLOBAL = '507f1f77bcf86cd7994390b3';
const USER = '507f1f77bcf86cd7994390c1';

const ctxA: WorkspaceContext = {
  id: WS_A,
  tenantId: TENANT,
  type: 'normal',
  role: 'admin',
  readOnly: false,
  globalWorkspaceId: WS_GLOBAL,
};
const ctxADev: WorkspaceContext = { ...ctxA, role: 'developer' };
const ctxB: WorkspaceContext = { ...ctxA, id: WS_B };
const ctxGlobalAdmin: WorkspaceContext = {
  id: WS_GLOBAL,
  tenantId: TENANT,
  type: 'global',
  role: 'admin',
  readOnly: false,
  globalWorkspaceId: WS_GLOBAL,
};
const ctxGlobalDev: WorkspaceContext = { ...ctxGlobalAdmin, role: 'developer', readOnly: true };

async function insertEntryRaw(
  workspaceId: string,
  overrides: Record<string, unknown> = {},
): Promise<mongoose.Types.ObjectId> {
  const _id = new mongoose.Types.ObjectId();
  await entryCollection().insertOne({
    _id,
    tenantId: new mongoose.Types.ObjectId(TENANT),
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    namespace: 'manual',
    key: `raw-${_id.toHexString().slice(-6)}`,
    valueEncrypted: encrypt('raw-secret-value'),
    editable: true,
    deletable: true,
    createdBy: new mongoose.Types.ObjectId(USER),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return _id;
}

describe('valut-service（T-VAL1~4 / T-VAL7，真库）', () => {
  describe('T-VAL1 加密往返与明文边界', () => {
    it('createManualEntry 加密落库，库内文档无 value 明文，resolveValue 往返一致', async () => {
      const plaintext = 'sk-proj-super-secret-123';
      const view = await runWithWorkspace(ctxA, () =>
        valutService.createManualEntry({ key: 'api-key', value: plaintext, createdBy: USER }),
      );

      const raw = await entryCollection().findOne({ _id: new mongoose.Types.ObjectId(view.id) });
      expect(raw).toBeTruthy();
      expect(raw?.valueEncrypted).toMatchObject({
        iv: expect.any(String),
        ciphertext: expect.any(String),
        tag: expect.any(String),
      });
      expect(JSON.stringify(raw)).not.toContain(plaintext);
      expect(raw?.valueEncrypted.ciphertext).not.toContain(plaintext);

      await expect(valutService.resolveValue(view.id)).resolves.toBe(plaintext);
    });

    it('CREDENTIAL_ENCRYPTION_KEY 未配置即抛错（不静默降级）', () => {
      const original = config.credentialEncryptionKey;
      try {
        config.credentialEncryptionKey = '';
        expect(() => encrypt('anything')).toThrow('CREDENTIAL_ENCRYPTION_KEY is not configured');
      } finally {
        config.credentialEncryptionKey = original;
      }
      expect(encrypt('anything').ciphertext).toBeTruthy();
    });

    it('resolveValue 不被任何 resolver 引用（解密仅服务端内部）', () => {
      const dir = resolve(process.cwd(), 'src/graphql/resolvers');
      const files = readdirSync(dir).filter(
        (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
      );
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const source = readFileSync(resolve(dir, file), 'utf-8');
        expect(source, `${file} 不得引用解密入口`).not.toMatch(/resolveValue/);
      }
    });
  });

  describe('T-VAL2 ensureNamespace 注册器', () => {
    it('幂等：重复调用只落一行，service- 前缀 + managed=true', async () => {
      await valutService.ensureNamespace('mcp-bearer-tokens', 'MCP Bearer Tokens');
      await valutService.ensureNamespace('mcp-bearer-tokens', 'MCP Bearer Tokens');

      const docs = await namespaceCollection()
        .find({ name: 'service-mcp-bearer-tokens' })
        .toArray();
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject({ displayName: 'MCP Bearer Tokens', managed: true });
      expect(await namespaceCollection().countDocuments({})).toBe(2); // manual + service
    });

    it('已存在的 namespace 不被覆盖（$setOnInsert 语义）', async () => {
      await valutService.ensureNamespace('demo', '旧展示名');
      await valutService.ensureNamespace('demo', '新展示名');
      const doc = await namespaceCollection().findOne({ name: 'service-demo' });
      expect(doc).toMatchObject({ displayName: '旧展示名', managed: true });
    });
  });

  describe('T-VAL3 createManagedEntry', () => {
    beforeEach(async () => {
      await valutService.ensureNamespace('mcp-bearer-tokens', 'MCP Bearer Tokens');
    });

    it('缺 refId / refLabel 直接抛错', async () => {
      const base = {
        feature: 'mcp-bearer-tokens',
        key: 'bearer',
        value: 'token',
        editable: true,
        deletable: false,
        workspaceId: WS_A,
        tenantId: TENANT,
        createdBy: USER,
      } as const;

      await expect(
        valutService.createManagedEntry({ ...base, refId: '', refLabel: 'L' }),
      ).rejects.toThrow('valut ref is required');
      await expect(
        valutService.createManagedEntry({ ...base, refId: 'mcp-1', refLabel: '' }),
      ).rejects.toThrow('valut ref is required');
      expect(await entryCollection().countDocuments({})).toBe(0);
    });

    it('entry + ref 成对写入，editable/deletable 按传入落库', async () => {
      const view = await runWithWorkspace(ctxA, () =>
        valutService.createManagedEntry({
          feature: 'mcp-bearer-tokens',
          refId: 'mcp-1',
          refLabel: 'MCP One',
          key: 'bearer-mcp-1',
          value: 'token-plain',
          editable: true,
          deletable: false,
          workspaceId: WS_A,
          tenantId: TENANT,
          createdBy: USER,
        }),
      );

      const refs = await refCollection()
        .find({ feature: 'mcp-bearer-tokens', refId: 'mcp-1' })
        .toArray();
      expect(refs).toHaveLength(1);
      expect(String(refs[0].valutEntryId)).toBe(view.id);
      expect(view).toMatchObject({
        namespace: 'service-mcp-bearer-tokens',
        namespaceDisplayName: 'MCP Bearer Tokens',
        key: 'bearer-mcp-1',
        editable: true,
        deletable: false,
      });
      expect(JSON.stringify(view)).not.toContain('token-plain');
      await expect(valutService.resolveValue(view.id)).resolves.toBe('token-plain');
    });

    it('ref 写入失败时补偿删除 entry（D14），不留孤儿', async () => {
      await runWithWorkspace(ctxA, () =>
        valutService.createManagedEntry({
          feature: 'mcp-bearer-tokens',
          refId: 'mcp-dup',
          refLabel: 'First',
          key: 'bearer-first',
          value: 'token-1',
          editable: true,
          deletable: false,
          workspaceId: WS_A,
          tenantId: TENANT,
          createdBy: USER,
        }),
      );

      await expect(
        runWithWorkspace(ctxA, () =>
          valutService.createManagedEntry({
            feature: 'mcp-bearer-tokens',
            refId: 'mcp-dup',
            refLabel: 'Second',
            key: 'bearer-second',
            value: 'token-2',
            editable: true,
            deletable: false,
            workspaceId: WS_A,
            tenantId: TENANT,
            createdBy: USER,
          }),
        ),
      ).rejects.toThrow('valut ref already exists');

      expect(await entryCollection().countDocuments({ key: 'bearer-second' })).toBe(0);
      expect(await entryCollection().countDocuments({})).toBe(1);
      expect(await refCollection().countDocuments({ refId: 'mcp-dup' })).toBe(1);
    });

    it('namespace 不存在时拒绝（防御式）', async () => {
      await expect(
        valutService.createManagedEntry({
          feature: 'unknown-feature',
          refId: 'x',
          refLabel: 'X',
          key: 'k',
          value: 'v',
          editable: true,
          deletable: false,
          workspaceId: WS_A,
          tenantId: TENANT,
          createdBy: USER,
        }),
      ).rejects.toThrow('valut namespace not found');
    });
  });

  describe('T-VAL4 手动 CRUD 与校验文案', () => {
    it('key 校验：trim 后 1..128、禁空白与控制字符', async () => {
      const create = (key: string) =>
        runWithWorkspace(ctxA, () =>
          valutService.createManualEntry({ key, value: 'v', createdBy: USER }),
        );

      await expect(create('')).rejects.toThrow('invalid valut key');
      await expect(create('   ')).rejects.toThrow('invalid valut key');
      await expect(create('a b')).rejects.toThrow('invalid valut key');
      await expect(create('tab\tkey')).rejects.toThrow('invalid valut key');
      await expect(create('line\nbreak')).rejects.toThrow('invalid valut key');
      await expect(create(`${String.fromCharCode(1)}ctrl`)).rejects.toThrow('invalid valut key');
      await expect(create('x'.repeat(129))).rejects.toThrow('invalid valut key');
      await expect(create('x'.repeat(128))).resolves.toMatchObject({ key: 'x'.repeat(128) });
      await expect(create('  trimmed  ')).resolves.toMatchObject({ key: 'trimmed' });
    });

    it('value 校验：1..16384（允许多行）', async () => {
      const create = (key: string, value: string) =>
        runWithWorkspace(ctxA, () =>
          valutService.createManualEntry({ key, value, createdBy: USER }),
        );

      await expect(create('k', '')).rejects.toThrow('invalid valut value');
      await expect(create('k', 'x'.repeat(16385))).rejects.toThrow('invalid valut value');
      await expect(create('k', 'multi\nline\nvalue')).resolves.toMatchObject({ key: 'k' });
      await expect(create('k2', 'x'.repeat(16384))).resolves.toMatchObject({ key: 'k2' });
    });

    it('同工作区同 namespace 重 key 拒绝', async () => {
      await runWithWorkspace(ctxA, () =>
        valutService.createManualEntry({ key: 'dup', value: 'v1', createdBy: USER }),
      );
      await expect(
        runWithWorkspace(ctxA, () =>
          valutService.createManualEntry({ key: 'dup', value: 'v2', createdBy: USER }),
        ),
      ).rejects.toThrow('valut key already exists');
      await expect(
        runWithWorkspace(ctxB, () =>
          valutService.createManualEntry({ key: 'dup', value: 'v3', createdBy: USER }),
        ),
      ).resolves.toMatchObject({ key: 'dup' });
    });

    it('updateValue 仅重写值（key 不变），库内无新明文', async () => {
      const view = await runWithWorkspace(ctxA, () =>
        valutService.createManualEntry({ key: 'api-key', value: 'old-secret', createdBy: USER }),
      );
      const updated = await runWithWorkspace(ctxA, () =>
        valutService.updateValue(view.id, 'new-secret'),
      );

      expect(updated.key).toBe('api-key');
      expect(updated.updatedAt >= view.updatedAt).toBe(true);
      await expect(valutService.resolveValue(view.id)).resolves.toBe('new-secret');
      const raw = await entryCollection().findOne({ _id: new mongoose.Types.ObjectId(view.id) });
      expect(JSON.stringify(raw)).not.toContain('new-secret');
      expect(JSON.stringify(raw)).not.toContain('old-secret');
    });

    it('editable=false 更新拒绝', async () => {
      await valutService.ensureNamespace('mcp-bearer-tokens', 'MCP Bearer Tokens');
      const view = await runWithWorkspace(ctxA, () =>
        valutService.createManagedEntry({
          feature: 'mcp-bearer-tokens',
          refId: 'mcp-ro',
          refLabel: 'RO',
          key: 'ro-key',
          value: 'v1',
          editable: false,
          deletable: true,
          workspaceId: WS_A,
          tenantId: TENANT,
          createdBy: USER,
        }),
      );
      await expect(
        runWithWorkspace(ctxA, () => valutService.updateValue(view.id, 'v2')),
      ).rejects.toThrow('valut entry is not editable');
      await expect(valutService.resolveValue(view.id)).resolves.toBe('v1');
    });

    it('deletable=false 删除拒绝；正常删除同时清理 refs', async () => {
      await valutService.ensureNamespace('mcp-bearer-tokens', 'MCP Bearer Tokens');
      const locked = await runWithWorkspace(ctxA, () =>
        valutService.createManagedEntry({
          feature: 'mcp-bearer-tokens',
          refId: 'mcp-lock',
          refLabel: 'Lock',
          key: 'lock-key',
          value: 'v',
          editable: true,
          deletable: false,
          workspaceId: WS_A,
          tenantId: TENANT,
          createdBy: USER,
        }),
      );
      await expect(
        runWithWorkspace(ctxA, () => valutService.deleteEntry(locked.id)),
      ).rejects.toThrow('valut entry is not deletable');

      // 可删除的托管条目（deletable=true）：删除成功并同时清理其 refs
      const free = await runWithWorkspace(ctxA, () =>
        valutService.createManagedEntry({
          feature: 'mcp-bearer-tokens',
          refId: 'mcp-free',
          refLabel: 'Free',
          key: 'free',
          value: 'v',
          editable: true,
          deletable: true,
          workspaceId: WS_A,
          tenantId: TENANT,
          createdBy: USER,
        }),
      );

      await expect(runWithWorkspace(ctxA, () => valutService.deleteEntry(free.id))).resolves.toBe(
        true,
      );
      expect(
        await entryCollection().countDocuments({ _id: new mongoose.Types.ObjectId(free.id) }),
      ).toBe(0);
      expect(await refCollection().countDocuments({ refId: 'mcp-free' })).toBe(0);
    });

    it('manual 条目存在 refs 时删除拒绝 valut entry has refs', async () => {
      const view = await runWithWorkspace(ctxA, () =>
        valutService.createManualEntry({ key: 'referenced', value: 'v', createdBy: USER }),
      );
      await refCollection().insertOne({
        valutEntryId: new mongoose.Types.ObjectId(view.id),
        feature: 'mcp-bearer-tokens',
        refId: 'mcp-ref-manual',
        refLabel: 'MCP',
        tenantId: new mongoose.Types.ObjectId(TENANT),
        workspaceId: new mongoose.Types.ObjectId(WS_A),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await expect(
        runWithWorkspace(ctxA, () => valutService.deleteEntry(view.id)),
      ).rejects.toThrow('valut entry has refs');
      expect(
        await entryCollection().countDocuments({ _id: new mongoose.Types.ObjectId(view.id) }),
      ).toBe(1);
    });
  });

  describe('T-VAL5 工作区权限矩阵（服务层）', () => {
    it('普通工作区 developer 成员读写通过', async () => {
      const view = await runWithWorkspace(ctxADev, () =>
        valutService.createManualEntry({ key: 'dev-key', value: 'v', createdBy: USER }),
      );
      await expect(
        runWithWorkspace(ctxADev, () => valutService.updateValue(view.id, 'v2')),
      ).resolves.toMatchObject({ key: 'dev-key' });
      const groups = await runWithWorkspace(ctxADev, () => valutService.listGrouped());
      expect(groups.flatMap((group) => group.entries).map((entry) => entry.key)).toContain(
        'dev-key',
      );
    });

    it('全局工作区 developer：读通、写拒（global workspace is read-only）', async () => {
      await runWithWorkspace(ctxGlobalAdmin, () =>
        valutService.createManualEntry({ key: 'global-key', value: 'v', createdBy: USER }),
      );

      const groups = await runWithWorkspace(ctxGlobalDev, () => valutService.listGrouped());
      const globalKeys = groups.flatMap((group) => group.entries).map((entry) => entry.key);
      expect(globalKeys).toContain('global-key');

      await expect(
        runWithWorkspace(ctxGlobalDev, () =>
          valutService.createManualEntry({ key: 'dev-create', value: 'v', createdBy: USER }),
        ),
      ).rejects.toThrow('global workspace is read-only');

      const existing = groups.flatMap((group) => group.entries).find((e) => e.key === 'global-key');
      expect(existing).toBeTruthy();
      await expect(
        runWithWorkspace(ctxGlobalDev, () => valutService.updateValue(existing!.id, 'v2')),
      ).rejects.toThrow('global workspace is read-only');
      await expect(
        runWithWorkspace(ctxGlobalDev, () => valutService.deleteEntry(existing!.id)),
      ).rejects.toThrow('global workspace is read-only');
      await expect(
        runWithWorkspace(ctxGlobalDev, () =>
          valutService.createManagedEntry({
            feature: 'mcp-bearer-tokens',
            refId: 'x',
            refLabel: 'X',
            key: 'k',
            value: 'v',
            editable: true,
            deletable: false,
            workspaceId: WS_GLOBAL,
            tenantId: TENANT,
            createdBy: USER,
          }),
        ),
      ).rejects.toThrow('global workspace is read-only');
    });

    it('跨工作区 id → Not found；不存在 id → valut entry not found', async () => {
      const inA = await runWithWorkspace(ctxA, () =>
        valutService.createManualEntry({ key: 'a-key', value: 'v', createdBy: USER }),
      );
      await insertEntryRaw(WS_B, { key: 'b-key' });
      const bDoc = await entryCollection().findOne({ key: 'b-key' });
      expect(bDoc).toBeTruthy();
      const bId = String(bDoc!._id);
      const missing = new mongoose.Types.ObjectId().toHexString();

      await expect(runWithWorkspace(ctxA, () => valutService.updateValue(bId, 'x'))).rejects.toThrow(
        'Not found',
      );
      await expect(runWithWorkspace(ctxA, () => valutService.deleteEntry(bId))).rejects.toThrow(
        'Not found',
      );
      await expect(runWithWorkspace(ctxA, () => valutService.resolveValue(bId))).rejects.toThrow(
        'Not found',
      );
      await expect(
        runWithWorkspace(ctxA, () => valutService.deleteEntryCascade(bId)),
      ).rejects.toThrow('Not found');

      await expect(runWithWorkspace(ctxA, () => valutService.updateValue(missing, 'x'))).rejects.toThrow(
        'valut entry not found',
      );
      await expect(runWithWorkspace(ctxA, () => valutService.deleteEntry(missing))).rejects.toThrow(
        'valut entry not found',
      );
      await expect(runWithWorkspace(ctxA, () => valutService.resolveValue(missing))).rejects.toThrow(
        'valut entry not found',
      );
      await expect(runWithWorkspace(ctxA, () => valutService.resolveValue('not-an-id'))).rejects.toThrow(
        'valut entry not found',
      );

      await expect(runWithWorkspace(ctxA, () => valutService.resolveValue(inA.id))).resolves.toBe('v');
    });
  });

  describe('listGrouped / listManualOptions', () => {
    it('按 namespace 聚合、refs 批量一次反查、装配体无 value', async () => {
      await valutService.ensureNamespace('mcp-bearer-tokens', 'MCP Bearer Tokens');
      await runWithWorkspace(ctxA, () =>
        valutService.createManualEntry({ key: 'manual-1', value: 'plain-a', createdBy: USER }),
      );
      const managed = await runWithWorkspace(ctxA, () =>
        valutService.createManagedEntry({
          feature: 'mcp-bearer-tokens',
          refId: 'mcp-1',
          refLabel: 'MCP One',
          key: 'bearer-1',
          value: 'plain-b',
          editable: true,
          deletable: false,
          workspaceId: WS_A,
          tenantId: TENANT,
          createdBy: USER,
        }),
      );
      await refCollection().insertOne({
        valutEntryId: new mongoose.Types.ObjectId(managed.id),
        feature: 'other-feature',
        refId: 'other-1',
        refLabel: 'Other',
        tenantId: new mongoose.Types.ObjectId(TENANT),
        workspaceId: new mongoose.Types.ObjectId(WS_A),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const findSpy = vi.spyOn(ValutRef, 'find');
      const groups = await runWithWorkspace(ctxA, () => valutService.listGrouped());
      expect(findSpy).toHaveBeenCalledTimes(1);
      findSpy.mockRestore();

      expect(groups.map((group) => group.namespace.name)).toEqual([
        'manual',
        'service-mcp-bearer-tokens',
      ]);
      const manualGroup = groups.find((group) => group.namespace.name === 'manual')!;
      expect(manualGroup.namespace).toMatchObject({ displayName: '自定义密钥', managed: false });
      expect(manualGroup.entries.map((entry) => entry.key)).toEqual(['manual-1']);

      const managedGroup = groups.find(
        (group) => group.namespace.name === 'service-mcp-bearer-tokens',
      )!;
      expect(managedGroup.namespace).toMatchObject({
        displayName: 'MCP Bearer Tokens',
        managed: true,
      });
      const managedEntry = managedGroup.entries[0];
      expect(managedEntry.refs).toHaveLength(2);
      expect(managedEntry.refs.map((ref) => ref.refId).sort()).toEqual(['mcp-1', 'other-1']);
      expect(managedEntry.refs[0]).toMatchObject({
        feature: expect.any(String),
        refLabel: expect.any(String),
        createdAt: expect.any(String),
      });

      expect(JSON.stringify(groups)).not.toContain('plain-a');
      expect(JSON.stringify(groups)).not.toContain('plain-b');
      expect(JSON.stringify(groups)).not.toContain('valueEncrypted');
    });

    it('跨工作区不可见（独占型可见集）', async () => {
      await insertEntryRaw(WS_B, { key: 'only-b' });
      await runWithWorkspace(ctxA, () =>
        valutService.createManualEntry({ key: 'only-a', value: 'v', createdBy: USER }),
      );

      const groupsA = await runWithWorkspace(ctxA, () => valutService.listGrouped());
      const keysA = groupsA.flatMap((group) => group.entries).map((entry) => entry.key);
      expect(keysA).toContain('only-a');
      expect(keysA).not.toContain('only-b');

      const groupsB = await runWithWorkspace(ctxB, () => valutService.listGrouped());
      const keysB = groupsB.flatMap((group) => group.entries).map((entry) => entry.key);
      expect(keysB).toContain('only-b');
      expect(keysB).not.toContain('only-a');
    });

    it('listManualOptions 仅 manual、仅当前工作区（服务层强制）', async () => {
      await valutService.ensureNamespace('mcp-bearer-tokens', 'MCP Bearer Tokens');
      await runWithWorkspace(ctxA, () =>
        valutService.createManualEntry({ key: 'a-manual', value: 'v', createdBy: USER }),
      );
      await runWithWorkspace(ctxA, () =>
        valutService.createManagedEntry({
          feature: 'mcp-bearer-tokens',
          refId: 'mcp-a',
          refLabel: 'MCP A',
          key: 'a-service',
          value: 'v',
          editable: true,
          deletable: false,
          workspaceId: WS_A,
          tenantId: TENANT,
          createdBy: USER,
        }),
      );
      await insertEntryRaw(WS_B, { key: 'b-manual' });

      const options = await runWithWorkspace(ctxA, () => valutService.listManualOptions());
      expect(options.map((entry) => entry.key)).toEqual(['a-manual']);
      expect(JSON.stringify(options)).not.toContain('"value"');

      await expect(valutService.listManualOptions()).resolves.toEqual([]);
    });
  });

  describe('删除联动原语（Phase 2 依赖）', () => {
    it('removeRef 按 feature+refId 解除引用；deleteEntryCascade 忽略 deletable 强制级联', async () => {
      await valutService.ensureNamespace('mcp-bearer-tokens', 'MCP Bearer Tokens');
      const view = await runWithWorkspace(ctxA, () =>
        valutService.createManagedEntry({
          feature: 'mcp-bearer-tokens',
          refId: 'mcp-cascade',
          refLabel: 'MCP',
          key: 'cascade-key',
          value: 'v',
          editable: true,
          deletable: false,
          workspaceId: WS_A,
          tenantId: TENANT,
          createdBy: USER,
        }),
      );

      await expect(valutService.removeRef('mcp-bearer-tokens', 'mcp-cascade')).resolves.toBe(true);
      expect(await refCollection().countDocuments({ refId: 'mcp-cascade' })).toBe(0);
      await expect(valutService.removeRef('mcp-bearer-tokens', 'mcp-cascade')).resolves.toBe(false);

      await expect(runWithWorkspace(ctxA, () => valutService.deleteEntryCascade(view.id))).resolves.toBe(
        true,
      );
      expect(
        await entryCollection().countDocuments({ _id: new mongoose.Types.ObjectId(view.id) }),
      ).toBe(0);
      await expect(runWithWorkspace(ctxA, () => valutService.deleteEntryCascade(view.id))).resolves.toBe(
        false,
      );
    });
  });

  describe('Phase 2 ref/元数据原语（custom-mcp-service 依赖）', () => {
    it('inspectEntry 返回 {id,namespace,workspaceId}，出参无 value；跨工作区/缺失按 loadEntry 口径', async () => {
      const view = await runWithWorkspace(ctxA, () =>
        valutService.createManualEntry({ key: 'inspect-key', value: 'v', createdBy: USER }),
      );
      const meta = await runWithWorkspace(ctxA, () => valutService.inspectEntry(view.id));
      expect(meta).toEqual({ id: view.id, namespace: 'manual', workspaceId: WS_A });
      expect(JSON.stringify(meta)).not.toContain('valueEncrypted');

      await insertEntryRaw(WS_B, { key: 'b-inspect' });
      const bDoc = await entryCollection().findOne({ key: 'b-inspect' });
      await expect(
        runWithWorkspace(ctxA, () => valutService.inspectEntry(String(bDoc!._id))),
      ).rejects.toThrow('Not found');
      await expect(
        runWithWorkspace(ctxA, () =>
          valutService.inspectEntry(new mongoose.Types.ObjectId().toHexString()),
        ),
      ).rejects.toThrow('valut entry not found');
      await expect(runWithWorkspace(ctxA, () => valutService.inspectEntry('not-an-id'))).rejects.toThrow(
        'valut entry not found',
      );
    });

    it('createRef 建 ref（可见性同口径）；重复 → valut ref already exists；缺参 → valut ref is required', async () => {
      const view = await runWithWorkspace(ctxA, () =>
        valutService.createManualEntry({ key: 'ref-key', value: 'v', createdBy: USER }),
      );
      await runWithWorkspace(ctxA, () =>
        valutService.createRef({
          entryId: view.id,
          feature: 'mcp-bearer-tokens',
          refId: 'mcp-x',
          refLabel: 'MCP X',
        }),
      );
      const refs = await refCollection()
        .find({ feature: 'mcp-bearer-tokens', refId: 'mcp-x' })
        .toArray();
      expect(refs).toHaveLength(1);
      expect(String(refs[0].valutEntryId)).toBe(view.id);
      expect(String(refs[0].workspaceId)).toBe(WS_A);

      await expect(
        runWithWorkspace(ctxA, () =>
          valutService.createRef({
            entryId: view.id,
            feature: 'mcp-bearer-tokens',
            refId: 'mcp-x',
            refLabel: 'Again',
          }),
        ),
      ).rejects.toThrow('valut ref already exists');
      await expect(
        runWithWorkspace(ctxA, () =>
          valutService.createRef({ entryId: view.id, feature: '', refId: 'y', refLabel: 'Y' }),
        ),
      ).rejects.toThrow('valut ref is required');
      await expect(
        runWithWorkspace(ctxA, () =>
          valutService.createRef({ entryId: view.id, feature: 'f', refId: 'y', refLabel: '' }),
        ),
      ).rejects.toThrow('valut ref is required');

      await insertEntryRaw(WS_B, { key: 'b-ref' });
      const bDoc = await entryCollection().findOne({ key: 'b-ref' });
      await expect(
        runWithWorkspace(ctxA, () =>
          valutService.createRef({
            entryId: String(bDoc!._id),
            feature: 'mcp-bearer-tokens',
            refId: 'mcp-b',
            refLabel: 'B',
          }),
        ),
      ).rejects.toThrow('Not found');

      await expect(
        runWithWorkspace(ctxGlobalDev, () =>
          valutService.createRef({
            entryId: view.id,
            feature: 'f',
            refId: 'r',
            refLabel: 'R',
          }),
        ),
      ).rejects.toThrow('global workspace is read-only');
    });

    it('loadEntryNamespaces 批量返回可见条目 namespace（缺失/跨工作区/非法 id 跳过）', async () => {
      const view = await runWithWorkspace(ctxA, () =>
        valutService.createManualEntry({ key: 'ns-key', value: 'v', createdBy: USER }),
      );
      await insertEntryRaw(WS_B, { key: 'b-ns' });
      const bDoc = await entryCollection().findOne({ key: 'b-ns' });
      const missing = new mongoose.Types.ObjectId().toHexString();

      const namespaces = await runWithWorkspace(ctxA, () =>
        valutService.loadEntryNamespaces([view.id, String(bDoc!._id), missing, 'not-an-id']),
      );
      expect(namespaces.get(view.id)).toBe('manual');
      expect(namespaces.has(String(bDoc!._id))).toBe(false);
      expect(namespaces.has(missing)).toBe(false);
      expect(namespaces.has('not-an-id')).toBe(false);

      await expect(valutService.loadEntryNamespaces([])).resolves.toEqual(new Map());
    });
  });

  describe('T-VAL7 日志脱敏（D4 精确路径）', () => {
    it('REDACT_PATHS 含三条精确路径、不含裸 *.value', () => {
      expect(REDACT_PATHS).toContain('*.newToken');
      expect(REDACT_PATHS).toContain('*.input.value');
      expect(REDACT_PATHS).toContain('*.input.newToken');
      expect(REDACT_PATHS).not.toContain('*.value');
      expect(REDACT_PATHS).not.toContain('value');
    });

    it('含 input.value / newToken 的日志对象被脱敏，普通 value 字段不误伤', () => {
      const chunks: string[] = [];
      const log = createLogger({
        destination: { write: (chunk: string) => chunks.push(chunk) },
      });

      log.info(
        {
          component: 'valut',
          valut: { input: { key: 'api-key', value: 'PLAINTEXT-VALUE', newToken: 'PLAINTEXT-TOKEN' } },
          auth: { newToken: 'PLAINTEXT-AUTH-TOKEN' },
        },
        'valut mutation',
      );
      log.info({ value: 'billing-line-item', metrics: { value: 42 } }, 'metering tick');

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).not.toContain('PLAINTEXT-VALUE');
      expect(chunks[0]).not.toContain('PLAINTEXT-TOKEN');
      expect(chunks[0]).not.toContain('PLAINTEXT-AUTH-TOKEN');
      expect(chunks[0]).toContain('[REDACTED]');
      expect(chunks[0]).toContain('api-key');

      expect(chunks[1]).toContain('billing-line-item');
      expect(chunks[1]).toContain('42');
    });
  });
});
