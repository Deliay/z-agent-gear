import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ValutNamespace } from '../models/valut-namespace.js';
import { CustomMcpServer } from '../models/custom-mcp-server.js';
import {
  customMcpService,
  type CreateCustomMcpServerParams,
  type UpdateCustomMcpServerParams,
} from './custom-mcp-service.js';
import { valutService } from './valut-service.js';
import { runWithWorkspace, type WorkspaceContext } from './workspace-context.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-custom-mcp-service-test'));
  // 唯一索引 uniq_custom_mcp_workspace_name 就绪后再跑重名用例（防 index 构建竞态）
  await CustomMcpServer.init();
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const mcpCollection = () => mongoose.connection.collection('custommcpservers');
const namespaceCollection = () => mongoose.connection.collection('valutnamespaces');
const entryCollection = () => mongoose.connection.collection('valutentries');
const refCollection = () => mongoose.connection.collection('valutrefs');

beforeEach(async () => {
  await mcpCollection().deleteMany({});
  await namespaceCollection().deleteMany({});
  await entryCollection().deleteMany({});
  await refCollection().deleteMany({});
  await ValutNamespace.create({ name: 'manual', displayName: '自定义密钥', managed: false });
  await valutService.ensureNamespace('mcp-bearer-tokens', 'MCP Bearer Tokens');
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

function input(overrides: Partial<CreateCustomMcpServerParams> = {}): CreateCustomMcpServerParams {
  return {
    name: 'mcp-a',
    endpoint: 'https://mcp-a.example.com/mcp',
    auth: { type: 'none' },
    customHeaders: [{ key: 'X-Api-Key', values: ['v1'] }],
    createdBy: USER,
    ...overrides,
  };
}

function patch(overrides: Partial<UpdateCustomMcpServerParams> = {}): Partial<UpdateCustomMcpServerParams> {
  return overrides;
}

async function createNone(name = 'mcp-a', ctx: WorkspaceContext = ctxA) {
  return runWithWorkspace(ctx, () => customMcpService.create(input({ name })));
}

async function createBearerNew(name = 'mcp-a', token = 'tok-plain-1', ctx: WorkspaceContext = ctxA) {
  return runWithWorkspace(ctx, () =>
    customMcpService.create(input({ name, auth: { type: 'bearer', newToken: token } })),
  );
}

async function createBearerRef(name: string, entryId: string, ctx: WorkspaceContext = ctxA) {
  return runWithWorkspace(ctx, () =>
    customMcpService.create(input({ name, auth: { type: 'bearer', existingEntryId: entryId } })),
  );
}

async function createManualEntry(ctx: WorkspaceContext, key: string) {
  return runWithWorkspace(ctx, () =>
    valutService.createManualEntry({ key, value: `value-${key}`, createdBy: USER }),
  );
}

async function createServiceEntry(ctx: WorkspaceContext, refId: string) {
  return runWithWorkspace(ctx, () =>
    valutService.createManagedEntry({
      feature: 'mcp-bearer-tokens',
      refId,
      refLabel: `svc-${refId}`,
      key: `svc-${refId}`,
      value: 'service-value',
      editable: true,
      deletable: false,
      workspaceId: ctx.id,
      tenantId: ctx.tenantId,
      createdBy: USER,
    }),
  );
}

async function rawMcp(id: string) {
  return mcpCollection().findOne({ _id: new mongoose.Types.ObjectId(id) });
}

/** 联动不变量：ref 必有 entry；带 bearerValutEntryId 的 MCP 必有 entry 且有 ref。 */
async function assertNoOrphanLinks(): Promise<void> {
  const refs = await refCollection().find({}).toArray();
  for (const ref of refs) {
    const entry = await entryCollection().findOne({ _id: ref.valutEntryId });
    expect(entry, `orphan ref refId=${String(ref.refId)}`).toBeTruthy();
  }
  const mcps = await mcpCollection().find({ bearerValutEntryId: { $ne: null } }).toArray();
  for (const mcp of mcps) {
    const entry = await entryCollection().findOne({ _id: mcp.bearerValutEntryId });
    expect(entry, `dangling bearerValutEntryId mcp=${String(mcp.name)}`).toBeTruthy();
    const ref = await refCollection().findOne({
      feature: 'mcp-bearer-tokens',
      refId: String(mcp._id),
    });
    expect(ref, `missing ref mcp=${String(mcp.name)}`).toBeTruthy();
  }
}

describe('custom-mcp-service（T-CMCP1~5，真库）', () => {
  describe('T-CMCP1 bearer 新建', () => {
    it('bearer+newToken：先建 entry+ref（refId=预生成 MCP id）再落 MCP 一次成型，entry 落 service-*、editable/deletable 正确、ref 指向 MCP', async () => {
      const view = await createBearerNew('mcp-a', 'tok-plain-1');

      expect(view).toMatchObject({
        name: 'mcp-a',
        authType: 'bearer',
        bearerEntryManaged: true,
        endpoint: 'https://mcp-a.example.com/mcp',
      });
      expect(view.bearerEntryId).toBeTruthy();

      const mcp = await rawMcp(view.id);
      expect(mcp).toBeTruthy();
      expect(String(mcp!.bearerValutEntryId)).toBe(view.bearerEntryId);

      const entry = await entryCollection().findOne({
        _id: new mongoose.Types.ObjectId(view.bearerEntryId!),
      });
      expect(entry).toMatchObject({
        namespace: 'service-mcp-bearer-tokens',
        key: 'mcp-a',
        editable: true,
        deletable: false,
        workspaceId: new mongoose.Types.ObjectId(WS_A),
        tenantId: new mongoose.Types.ObjectId(TENANT),
      });
      // 库内文档无 token 明文
      expect(JSON.stringify(entry)).not.toContain('tok-plain-1');

      const ref = await refCollection().findOne({
        feature: 'mcp-bearer-tokens',
        refId: view.id,
      });
      expect(ref).toBeTruthy();
      expect(String(ref!.valutEntryId)).toBe(view.bearerEntryId);
      expect(ref!.refLabel).toBe('mcp-a');
      expect(String(ref!.workspaceId)).toBe(WS_A);

      await expect(valutService.resolveValue(view.bearerEntryId!)).resolves.toBe('tok-plain-1');
      // 出参无明文
      expect(JSON.stringify(view)).not.toContain('tok-plain-1');
      await assertNoOrphanLinks();
    });

    it('bearer+newToken：落 MCP 失败 → entry/ref 已回滚（不留悬空行与半态 MCP）', async () => {
      // 同名 MCP 已存在：entry 先建之后首次 save 撞 uniq_custom_mcp_workspace_name
      await createNone('dup-bearer');

      await expect(createBearerNew('dup-bearer', 'orphan-token')).rejects.toThrow('invalid mcp name');

      // 补偿：已建 entry+ref 被 deleteEntryCascade 回收，仅剩既有 MCP
      expect(await mcpCollection().countDocuments({})).toBe(1);
      expect(await entryCollection().countDocuments({})).toBe(0);
      expect(await refCollection().countDocuments({})).toBe(0);
      await assertNoOrphanLinks();
    });

    it('auth.type=none：直接落库，无 Valut 条目与 ref', async () => {
      const view = await createNone();
      expect(view).toMatchObject({
        authType: 'none',
        bearerEntryId: null,
        bearerEntryManaged: null,
      });
      expect(view.customHeaders).toEqual([{ key: 'X-Api-Key', values: ['v1'] }]);
      expect(await entryCollection().countDocuments({})).toBe(0);
      expect(await refCollection().countDocuments({})).toBe(0);
    });

    it('customHeaders 省略 → 空数组出参；description 缺省 → null', async () => {
      const view = await runWithWorkspace(ctxA, () =>
        customMcpService.create(
          input({ name: 'mcp-plain', customHeaders: undefined, description: undefined }),
        ),
      );
      expect(view.customHeaders).toEqual([]);
      expect(view.description).toBeNull();
      expect(view.workspaceId).toBe(WS_A);
      expect(view.createdBy).toBe(USER);
      expect(typeof view.createdAt).toBe('string');
      expect(typeof view.updatedAt).toBe('string');
    });
  });

  describe('T-CMCP2 bearer 引用', () => {
    it('引用 manual：仅建 ref，条目保留，无 service 条目', async () => {
      const manual = await createManualEntry(ctxA, 'manual-ref-1');
      const view = await createBearerRef('mcp-ref', manual.id);

      expect(view).toMatchObject({
        authType: 'bearer',
        bearerEntryId: manual.id,
        bearerEntryManaged: false,
      });
      const ref = await refCollection().findOne({ feature: 'mcp-bearer-tokens', refId: view.id });
      expect(ref).toBeTruthy();
      expect(String(ref!.valutEntryId)).toBe(manual.id);
      expect(await entryCollection().countDocuments({ namespace: 'service-mcp-bearer-tokens' })).toBe(
        0,
      );
      expect(
        await entryCollection().countDocuments({ _id: new mongoose.Types.ObjectId(manual.id) }),
      ).toBe(1);
      await assertNoOrphanLinks();
    });

    it('引用非 manual（service-*）→ bearer entry must be manual namespace，且不落 MCP', async () => {
      const managed = await createServiceEntry(ctxA, 'other-mcp');
      await expect(createBearerRef('mcp-bad-ref', managed.id)).rejects.toThrow(
        'bearer entry must be manual namespace',
      );
      expect(await mcpCollection().countDocuments({})).toBe(0);
    });

    it('引用跨工作区条目 → Not found，且不落 MCP', async () => {
      const foreign = await createManualEntry(ctxB, 'manual-b');
      await expect(createBearerRef('mcp-x-ws', foreign.id)).rejects.toThrow('Not found');
      expect(await mcpCollection().countDocuments({})).toBe(0);
    });

    it('引用不存在条目 → valut entry not found，且不落 MCP', async () => {
      const missing = new mongoose.Types.ObjectId().toHexString();
      await expect(createBearerRef('mcp-missing-ref', missing)).rejects.toThrow(
        'valut entry not found',
      );
      await expect(createBearerRef('mcp-invalid-ref', 'not-an-id')).rejects.toThrow(
        'valut entry not found',
      );
      expect(await mcpCollection().countDocuments({})).toBe(0);
    });

    it('多条 MCP 共引同一条目：各自独立 ref（{feature,refId} 唯一）', async () => {
      const manual = await createManualEntry(ctxA, 'manual-shared');
      const first = await createBearerRef('mcp-share-1', manual.id);
      const second = await createBearerRef('mcp-share-2', manual.id);

      const refs = await refCollection()
        .find({ valutEntryId: new mongoose.Types.ObjectId(manual.id) })
        .toArray();
      expect(refs).toHaveLength(2);
      expect(new Set(refs.map((ref) => ref.refId))).toEqual(new Set([first.id, second.id]));
      expect(
        await entryCollection().countDocuments({ _id: new mongoose.Types.ObjectId(manual.id) }),
      ).toBe(1);
      await assertNoOrphanLinks();
    });
  });

  describe('T-CMCP3 删除级联', () => {
    it('删除自建：级联删 entry+ref 与 MCP，返回 true；二次删除拒绝', async () => {
      const mcp = await createBearerNew('del-self', 'del-token');
      const entryId = new mongoose.Types.ObjectId(mcp.bearerEntryId!);

      await expect(runWithWorkspace(ctxA, () => customMcpService.delete(mcp.id))).resolves.toBe(
        true,
      );
      expect(await mcpCollection().countDocuments({ _id: new mongoose.Types.ObjectId(mcp.id) })).toBe(
        0,
      );
      expect(await entryCollection().countDocuments({ _id: entryId })).toBe(0);
      expect(await refCollection().countDocuments({ refId: mcp.id })).toBe(0);

      await expect(runWithWorkspace(ctxA, () => customMcpService.delete(mcp.id))).rejects.toThrow(
        'custom mcp server not found',
      );
    });

    it('删除引用 manual：仅删 ref，条目保留，MCP 删除', async () => {
      const manual = await createManualEntry(ctxA, 'manual-del');
      const mcp = await createBearerRef('del-ref', manual.id);

      await expect(runWithWorkspace(ctxA, () => customMcpService.delete(mcp.id))).resolves.toBe(
        true,
      );
      expect(await mcpCollection().countDocuments({ _id: new mongoose.Types.ObjectId(mcp.id) })).toBe(
        0,
      );
      expect(await refCollection().countDocuments({ refId: mcp.id })).toBe(0);
      expect(
        await entryCollection().countDocuments({ _id: new mongoose.Types.ObjectId(manual.id) }),
      ).toBe(1);
      await expect(valutService.resolveValue(manual.id)).resolves.toBe('value-manual-del');
      await assertNoOrphanLinks();
    });

    it('删除 auth=none：仅删 MCP', async () => {
      const mcp = await createNone('del-none');
      await expect(runWithWorkspace(ctxA, () => customMcpService.delete(mcp.id))).resolves.toBe(
        true,
      );
      expect(await mcpCollection().countDocuments({})).toBe(0);
      expect(await entryCollection().countDocuments({})).toBe(0);
      expect(await refCollection().countDocuments({})).toBe(0);
    });

    it('并发删除只级联一次（deletedCount===1 凭证）', async () => {
      const mcp = await createBearerNew('del-concurrent', 'con-token');
      const entryId = new mongoose.Types.ObjectId(mcp.bearerEntryId!);
      const spy = vi.spyOn(valutService, 'deleteEntryCascade');
      try {
        const results = await Promise.allSettled([
          runWithWorkspace(ctxA, () => customMcpService.delete(mcp.id)),
          runWithWorkspace(ctxA, () => customMcpService.delete(mcp.id)),
        ]);

        for (const result of results) {
          if (result.status === 'rejected') {
            expect((result.reason as Error).message).toBe('custom mcp server not found');
          }
        }
        const values = results
          .filter((result): result is PromiseFulfilledResult<boolean> => result.status === 'fulfilled')
          .map((result) => result.value);
        expect(values.filter((value) => value === true)).toHaveLength(1);
        for (const value of values) expect(typeof value).toBe('boolean');

        // 级联只执行一次（输家不重复级联）
        expect(spy).toHaveBeenCalledTimes(1);
        expect(await entryCollection().countDocuments({ _id: entryId })).toBe(0);
        expect(await refCollection().countDocuments({ refId: mcp.id })).toBe(0);
        expect(
          await mcpCollection().countDocuments({ _id: new mongoose.Types.ObjectId(mcp.id) }),
        ).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('跨工作区 id → Not found；不存在 id → custom mcp server not found', async () => {
      const inB = await createNone('b-only', ctxB);
      await expect(runWithWorkspace(ctxA, () => customMcpService.delete(inB.id))).rejects.toThrow(
        'Not found',
      );
      expect(await mcpCollection().countDocuments({ _id: new mongoose.Types.ObjectId(inB.id) })).toBe(
        1,
      );

      const missing = new mongoose.Types.ObjectId().toHexString();
      await expect(runWithWorkspace(ctxA, () => customMcpService.delete(missing))).rejects.toThrow(
        'custom mcp server not found',
      );
      await expect(runWithWorkspace(ctxA, () => customMcpService.delete('not-an-id'))).rejects.toThrow(
        'custom mcp server not found',
      );
    });
  });

  describe('T-CMCP4 编辑', () => {
    it('自建 token 就地更新值（旧值不回显），entry/ref 不变', async () => {
      const mcp = await createBearerNew('edit-self', 'old-token');
      const updated = await runWithWorkspace(ctxA, () =>
        customMcpService.update(mcp.id, patch({ auth: { type: 'bearer', newToken: 'new-token' } })),
      );

      expect(updated.bearerEntryId).toBe(mcp.bearerEntryId);
      expect(updated.bearerEntryManaged).toBe(true);
      expect(JSON.stringify(updated)).not.toContain('old-token');
      expect(JSON.stringify(updated)).not.toContain('new-token');
      await expect(valutService.resolveValue(mcp.bearerEntryId!)).resolves.toBe('new-token');
      expect(await entryCollection().countDocuments({ namespace: 'service-mcp-bearer-tokens' })).toBe(
        1,
      );
      expect(await refCollection().countDocuments({ refId: mcp.id })).toBe(1);
      await assertNoOrphanLinks();
    });

    it('manual 引用就地改值拒绝 bearer entry not editable in place，值与关联不变', async () => {
      const manual = await createManualEntry(ctxA, 'manual-inplace');
      const mcp = await createBearerRef('edit-ref', manual.id);

      await expect(
        runWithWorkspace(ctxA, () =>
          customMcpService.update(mcp.id, patch({ auth: { type: 'bearer', newToken: 'try-edit' } })),
        ),
      ).rejects.toThrow('bearer entry not editable in place');
      await expect(valutService.resolveValue(manual.id)).resolves.toBe('value-manual-inplace');
      expect(String((await rawMcp(mcp.id))!.bearerValutEntryId)).toBe(manual.id);
      expect(await refCollection().countDocuments({ refId: mcp.id })).toBe(1);
    });

    it('换绑 自建→manual：旧条目级联删、新 ref 建立、无孤儿', async () => {
      const mcp = await createBearerNew('rebind-self', 'self-token');
      const manual = await createManualEntry(ctxA, 'manual-rebind-1');
      const oldEntryId = new mongoose.Types.ObjectId(mcp.bearerEntryId!);

      const updated = await runWithWorkspace(ctxA, () =>
        customMcpService.update(
          mcp.id,
          patch({ auth: { type: 'bearer', existingEntryId: manual.id } }),
        ),
      );
      expect(updated).toMatchObject({ bearerEntryId: manual.id, bearerEntryManaged: false });

      // 旧自建条目级联删除（entry + ref 均不留）
      expect(await entryCollection().countDocuments({ _id: oldEntryId })).toBe(0);
      expect(await refCollection().countDocuments({ valutEntryId: oldEntryId })).toBe(0);
      // 新 ref 建立、manual 条目保留
      const refs = await refCollection().find({ refId: mcp.id }).toArray();
      expect(refs).toHaveLength(1);
      expect(String(refs[0].valutEntryId)).toBe(manual.id);
      expect(await entryCollection().countDocuments({ _id: new mongoose.Types.ObjectId(manual.id) })).toBe(
        1,
      );
      await assertNoOrphanLinks();
    });

    it('换绑 manual→另一 manual：旧 ref 仅删、旧条目保留、新 ref 建立', async () => {
      const first = await createManualEntry(ctxA, 'manual-first');
      const second = await createManualEntry(ctxA, 'manual-second');
      const mcp = await createBearerRef('rebind-manual', first.id);

      const updated = await runWithWorkspace(ctxA, () =>
        customMcpService.update(
          mcp.id,
          patch({ auth: { type: 'bearer', existingEntryId: second.id } }),
        ),
      );
      expect(updated.bearerEntryId).toBe(second.id);

      expect(
        await refCollection().countDocuments({
          refId: mcp.id,
          valutEntryId: new mongoose.Types.ObjectId(first.id),
        }),
      ).toBe(0);
      expect(
        await refCollection().countDocuments({
          refId: mcp.id,
          valutEntryId: new mongoose.Types.ObjectId(second.id),
        }),
      ).toBe(1);
      expect(await entryCollection().countDocuments({ _id: new mongoose.Types.ObjectId(first.id) })).toBe(
        1,
      );
      await assertNoOrphanLinks();
    });

    it('换绑 updateOne 抛错 → 无孤儿（旧关联完好、新 ref 未建）', async () => {
      const mcp = await createBearerNew('rebind-db-fail', 'rfail-token');
      const manual = await createManualEntry(ctxA, 'manual-rebind-fail');
      const oldEntryId = new mongoose.Types.ObjectId(mcp.bearerEntryId!);

      const spy = vi
        .spyOn(CustomMcpServer, 'updateOne')
        .mockRejectedValueOnce(new Error('db down'));
      try {
        await expect(
          runWithWorkspace(ctxA, () =>
            customMcpService.update(
              mcp.id,
              patch({ auth: { type: 'bearer', existingEntryId: manual.id } }),
            ),
          ),
        ).rejects.toThrow('db down');
      } finally {
        spy.mockRestore();
      }

      // 持久化失败 → 有副作用步骤尚未执行：旧关联完好、无新 ref、无孤儿
      expect(String((await rawMcp(mcp.id))!.bearerValutEntryId)).toBe(mcp.bearerEntryId);
      expect(await entryCollection().countDocuments({ _id: oldEntryId })).toBe(1);
      expect(
        await refCollection().countDocuments({ refId: mcp.id, valutEntryId: oldEntryId }),
      ).toBe(1);
      expect(
        await refCollection().countDocuments({
          valutEntryId: new mongoose.Types.ObjectId(manual.id),
        }),
      ).toBe(0);
      await assertNoOrphanLinks();
    });

    it('解绑 updateOne 抛错 → 无孤儿（旧条目与 ref 均保留）', async () => {
      const mcp = await createBearerNew('detach-db-fail', 'dfail-token');
      const oldEntryId = new mongoose.Types.ObjectId(mcp.bearerEntryId!);

      const spy = vi
        .spyOn(CustomMcpServer, 'updateOne')
        .mockRejectedValueOnce(new Error('db down'));
      try {
        await expect(
          runWithWorkspace(ctxA, () => customMcpService.update(mcp.id, patch({ auth: { type: 'none' } }))),
        ).rejects.toThrow('db down');
      } finally {
        spy.mockRestore();
      }

      const doc = await rawMcp(mcp.id);
      expect(doc!.authType).toBe('bearer');
      expect(String(doc!.bearerValutEntryId)).toBe(mcp.bearerEntryId);
      expect(await entryCollection().countDocuments({ _id: oldEntryId })).toBe(1);
      expect(await refCollection().countDocuments({ refId: mcp.id })).toBe(1);
      await assertNoOrphanLinks();
    });

    it('换绑 createRef 失败 → 回滚持久化并恢复旧 ref（旧关联完好、新条目无 ref）', async () => {
      const mcp = await createBearerNew('rebind-ref-fail', 'refail-token');
      const manual = await createManualEntry(ctxA, 'manual-ref-fail');
      const oldEntryId = new mongoose.Types.ObjectId(mcp.bearerEntryId!);

      const spy = vi.spyOn(valutService, 'createRef').mockRejectedValueOnce(new Error('ref boom'));
      try {
        await expect(
          runWithWorkspace(ctxA, () =>
            customMcpService.update(
              mcp.id,
              patch({ auth: { type: 'bearer', existingEntryId: manual.id } }),
            ),
          ),
        ).rejects.toThrow('ref boom');
      } finally {
        spy.mockRestore();
      }

      // 副作用失败补偿：回滚本次 $set + 恢复旧 ref（换绑方向不留孤儿）
      expect(String((await rawMcp(mcp.id))!.bearerValutEntryId)).toBe(mcp.bearerEntryId);
      expect(await entryCollection().countDocuments({ _id: oldEntryId })).toBe(1);
      expect(
        await refCollection().countDocuments({ refId: mcp.id, valutEntryId: oldEntryId }),
      ).toBe(1);
      expect(
        await refCollection().countDocuments({
          valutEntryId: new mongoose.Types.ObjectId(manual.id),
        }),
      ).toBe(0);
      await assertNoOrphanLinks();
    });

    it('换绑到 service 条目拒绝；换绑到同一 manual 幂等', async () => {
      const managed = await createServiceEntry(ctxA, 'svc-rebind');
      const manual = await createManualEntry(ctxA, 'manual-keep');
      const mcp = await createBearerRef('rebind-guard', manual.id);

      await expect(
        runWithWorkspace(ctxA, () =>
          customMcpService.update(
            mcp.id,
            patch({ auth: { type: 'bearer', existingEntryId: managed.id } }),
          ),
        ),
      ).rejects.toThrow('bearer entry must be manual namespace');
      // 关联未被破坏
      expect(String((await rawMcp(mcp.id))!.bearerValutEntryId)).toBe(manual.id);
      expect(await refCollection().countDocuments({ refId: mcp.id })).toBe(1);

      const again = await runWithWorkspace(ctxA, () =>
        customMcpService.update(
          mcp.id,
          patch({ auth: { type: 'bearer', existingEntryId: manual.id } }),
        ),
      );
      expect(again.bearerEntryId).toBe(manual.id);
      expect(await refCollection().countDocuments({ refId: mcp.id })).toBe(1);
      await assertNoOrphanLinks();
    });

    it('none → bearer 两路径（attach）：newToken 建自建、existingEntryId 仅建 ref', async () => {
      const byToken = await createNone('attach-token');
      const attached = await runWithWorkspace(ctxA, () =>
        customMcpService.update(
          byToken.id,
          patch({ auth: { type: 'bearer', newToken: 'attach-token-value' } }),
        ),
      );
      expect(attached.bearerEntryManaged).toBe(true);
      await expect(valutService.resolveValue(attached.bearerEntryId!)).resolves.toBe(
        'attach-token-value',
      );

      const manual = await createManualEntry(ctxA, 'manual-attach');
      const byRef = await createNone('attach-ref');
      const attachedRef = await runWithWorkspace(ctxA, () =>
        customMcpService.update(
          byRef.id,
          patch({ auth: { type: 'bearer', existingEntryId: manual.id } }),
        ),
      );
      expect(attachedRef).toMatchObject({
        authType: 'bearer',
        bearerEntryId: manual.id,
        bearerEntryManaged: false,
      });
      expect(await refCollection().countDocuments({ refId: byRef.id })).toBe(1);
      await assertNoOrphanLinks();
    });

    it('解绑 bearer→none：自建级联删 entry+ref；manual 仅删 ref 条目保留', async () => {
      const self = await createBearerNew('detach-self', 'detach-token');
      const detached = await runWithWorkspace(ctxA, () =>
        customMcpService.update(self.id, patch({ auth: { type: 'none' } })),
      );
      expect(detached).toMatchObject({
        authType: 'none',
        bearerEntryId: null,
        bearerEntryManaged: null,
      });
      expect(await entryCollection().countDocuments({ namespace: 'service-mcp-bearer-tokens' })).toBe(
        0,
      );
      expect(await refCollection().countDocuments({ refId: self.id })).toBe(0);

      const manual = await createManualEntry(ctxA, 'manual-detach');
      const refMcp = await createBearerRef('detach-ref', manual.id);
      const detachedRef = await runWithWorkspace(ctxA, () =>
        customMcpService.update(refMcp.id, patch({ auth: { type: 'none' } })),
      );
      expect(detachedRef.bearerEntryId).toBeNull();
      expect(await refCollection().countDocuments({ refId: refMcp.id })).toBe(0);
      expect(await entryCollection().countDocuments({ _id: new mongoose.Types.ObjectId(manual.id) })).toBe(
        1,
      );
      await assertNoOrphanLinks();
    });

    it('name/description/endpoint/customHeaders 直改；auth 省略联动不动', async () => {
      const mcp = await createBearerNew('plain-edit', 'keep-token');
      const updated = await runWithWorkspace(ctxA, () =>
        customMcpService.update(
          mcp.id,
          patch({
            name: 'plain-renamed',
            description: 'a description',
            endpoint: 'http://new.example.com/mcp',
            customHeaders: [
              { key: 'X-New', values: ['a', 'b'] },
              { key: 'X-Other', values: ['c'] },
            ],
          }),
        ),
      );

      expect(updated).toMatchObject({
        name: 'plain-renamed',
        description: 'a description',
        endpoint: 'http://new.example.com/mcp',
        authType: 'bearer',
        bearerEntryId: mcp.bearerEntryId,
        bearerEntryManaged: true,
      });
      expect(updated.customHeaders).toEqual([
        { key: 'X-New', values: ['a', 'b'] },
        { key: 'X-Other', values: ['c'] },
      ]);
      // auth 省略 → 值未动
      await expect(valutService.resolveValue(mcp.bearerEntryId!)).resolves.toBe('keep-token');

      const cleared = await runWithWorkspace(ctxA, () =>
        customMcpService.update(mcp.id, patch({ description: null })),
      );
      expect(cleared.description).toBeNull();
      expect(cleared.name).toBe('plain-renamed');
      await assertNoOrphanLinks();
    });

    it('不存在 id → custom mcp server not found；跨工作区 → Not found', async () => {
      const missing = new mongoose.Types.ObjectId().toHexString();
      await expect(
        runWithWorkspace(ctxA, () => customMcpService.update(missing, patch({ name: 'x' }))),
      ).rejects.toThrow('custom mcp server not found');
      await expect(
        runWithWorkspace(ctxA, () => customMcpService.update('not-an-id', patch({ name: 'x' }))),
      ).rejects.toThrow('custom mcp server not found');

      const inB = await createNone('b-edit', ctxB);
      await expect(
        runWithWorkspace(ctxA, () => customMcpService.update(inB.id, patch({ name: 'x' }))),
      ).rejects.toThrow('Not found');
    });
  });

  describe('T-CMCP5 校验矩阵（逐字命中白名单）', () => {
    const cases: Array<[string, Partial<CreateCustomMcpServerParams>, string]> = [
      ['空 name', { name: '' }, 'invalid mcp name'],
      ['全空白 name', { name: '   ' }, 'invalid mcp name'],
      ['超长 name（65）', { name: 'x'.repeat(65) }, 'invalid mcp name'],
      ['非字符串 name', { name: 123 as unknown as string }, 'invalid mcp name'],
      ['ftp scheme endpoint', { endpoint: 'ftp://x.example.com' }, 'invalid mcp endpoint'],
      ['无 scheme endpoint', { endpoint: 'mcp-a.example.com' }, 'invalid mcp endpoint'],
      ['空 host endpoint', { endpoint: 'http://' }, 'invalid mcp endpoint'],
      [
        '超长 endpoint（>1024）',
        { endpoint: `https://x.example.com/${'a'.repeat(1024)}` },
        'invalid mcp endpoint',
      ],
      ['非字符串 endpoint', { endpoint: 42 as unknown as string }, 'invalid mcp endpoint'],
      ['header key 含空格', { customHeaders: [{ key: 'X Bad', values: ['v'] }] }, 'invalid custom headers'],
      ['header key 含冒号', { customHeaders: [{ key: 'X:Bad', values: ['v'] }] }, 'invalid custom headers'],
      ['header key 空', { customHeaders: [{ key: '', values: ['v'] }] }, 'invalid custom headers'],
      [
        'header key 含点号（BSON/Mongoose Map 限制）',
        { customHeaders: [{ key: 'X.Bad', values: ['v'] }] },
        'invalid custom headers',
      ],
      [
        'header 超 32 条',
        {
          customHeaders: Array.from({ length: 33 }, (_, index) => ({
            key: `X-${index}`,
            values: ['v'],
          })),
        },
        'invalid custom headers',
      ],
      [
        'header value 超 4096',
        { customHeaders: [{ key: 'X-Long', values: ['v'.repeat(4097)] }] },
        'invalid custom headers',
      ],
      ['header values 空数组', { customHeaders: [{ key: 'X-Empty', values: [] }] }, 'invalid custom headers'],
      [
        'header 重复 key',
        {
          customHeaders: [
            { key: 'X-Dup', values: ['1'] },
            { key: 'X-Dup', values: ['2'] },
          ],
        },
        'invalid custom headers',
      ],
      ['header 非数组', { customHeaders: 'X-Api: v' as unknown as [] }, 'invalid custom headers'],
      ['bearer 缺 token', { auth: { type: 'bearer' } }, 'bearer token is required'],
      ['bearer 空 token', { auth: { type: 'bearer', newToken: '' } }, 'bearer token is required'],
      [
        'bearer 无 token 无 entry',
        { auth: { type: 'bearer', newToken: null, existingEntryId: null } },
        'bearer token is required',
      ],
      ['非法 auth type', { auth: { type: 'basic' as unknown as 'none' } }, 'invalid mcp auth type'],
    ];

    it.each(cases)('%s → %s', async (_label, overrides, expected) => {
      await expect(
        runWithWorkspace(ctxA, () => customMcpService.create(input(overrides))),
      ).rejects.toThrow(expected);
      expect(await mcpCollection().countDocuments({})).toBe(0);
      expect(await entryCollection().countDocuments({})).toBe(0);
      expect(await refCollection().countDocuments({})).toBe(0);
    });

    it('校验顺序：name 先于 auth（name 非法 + bearer 缺 token → invalid mcp name）', async () => {
      await expect(
        runWithWorkspace(ctxA, () => customMcpService.create(input({ name: '', auth: { type: 'bearer' } }))),
      ).rejects.toThrow('invalid mcp name');
    });

    it('同工作区重名 → invalid mcp name；跨工作区同名允许', async () => {
      await createNone('dup-name');
      await expect(
        runWithWorkspace(ctxA, () => customMcpService.create(input({ name: 'dup-name' }))),
      ).rejects.toThrow('invalid mcp name');
      expect(await mcpCollection().countDocuments({ name: 'dup-name' })).toBe(1);

      await expect(
        runWithWorkspace(ctxB, () => customMcpService.create(input({ name: 'dup-name' }))),
      ).resolves.toMatchObject({ name: 'dup-name' });
      expect(await mcpCollection().countDocuments({ name: 'dup-name' })).toBe(2);
    });

    it('description 超 512 → invalid mcp description（契约未列文案，GraphQL 层收敛 internal error）', async () => {
      await expect(
        runWithWorkspace(ctxA, () =>
          customMcpService.create(input({ description: 'd'.repeat(513) })),
        ),
      ).rejects.toThrow('invalid mcp description');
      expect(await mcpCollection().countDocuments({})).toBe(0);
    });

    it('合法边界：name=64、endpoint=1024、header value=4096、header 恰 32 条', async () => {
      const view = await runWithWorkspace(ctxA, () =>
        customMcpService.create(
          input({
            name: 'n'.repeat(64),
            endpoint: `https://x.example.com/${'a'.repeat(1002)}`,
            customHeaders: [
              { key: 'X-Edge', values: ['v'.repeat(4096)] },
              ...Array.from({ length: 31 }, (_, index) => ({ key: `X-${index}`, values: ['v'] })),
            ],
          }),
        ),
      );
      expect(view.name).toHaveLength(64);
      expect(view.endpoint).toHaveLength(1024);
      expect(view.customHeaders).toHaveLength(32);
      expect(view.customHeaders[0].values[0]).toHaveLength(4096);
    });
  });

  describe('查询与权限矩阵（T-CMCP）', () => {
    it('list 独占当前工作区，派生 bearerEntryManaged；跨工作区互不可见', async () => {
      await createBearerNew('a-self', 'tok-a');
      const manual = await createManualEntry(ctxA, 'a-manual');
      await createBearerRef('a-ref', manual.id);
      await createBearerNew('b-self', 'tok-b', ctxB);

      const listA = await runWithWorkspace(ctxA, () => customMcpService.list());
      expect(listA.map((mcp) => mcp.name).sort()).toEqual(['a-ref', 'a-self']);
      expect(listA.find((mcp) => mcp.name === 'a-self')!.bearerEntryManaged).toBe(true);
      expect(listA.find((mcp) => mcp.name === 'a-ref')!.bearerEntryManaged).toBe(false);

      const listB = await runWithWorkspace(ctxB, () => customMcpService.list());
      expect(listB.map((mcp) => mcp.name)).toEqual(['b-self']);
      expect(JSON.stringify(listA)).not.toContain('tok-b');
      expect(JSON.stringify(listB)).not.toContain('tok-a');
    });

    it('get：存在返回视图、不存在返回 null、跨工作区 → Not found', async () => {
      const mcp = await createNone('get-a');
      const found = await runWithWorkspace(ctxA, () => customMcpService.get(mcp.id));
      expect(found).toMatchObject({ id: mcp.id, name: 'get-a' });

      const missing = new mongoose.Types.ObjectId().toHexString();
      await expect(runWithWorkspace(ctxA, () => customMcpService.get(missing))).resolves.toBeNull();
      await expect(runWithWorkspace(ctxA, () => customMcpService.get('not-an-id'))).resolves.toBeNull();

      const inB = await createNone('get-b', ctxB);
      await expect(runWithWorkspace(ctxA, () => customMcpService.get(inB.id))).rejects.toThrow(
        'Not found',
      );
    });

    it('全局工作区 developer：读通、写拒（global workspace is read-only）', async () => {
      await runWithWorkspace(ctxGlobalAdmin, () =>
        customMcpService.create(input({ name: 'g-mcp' })),
      );

      const list = await runWithWorkspace(ctxGlobalDev, () => customMcpService.list());
      expect(list.map((mcp) => mcp.name)).toContain('g-mcp');

      await expect(
        runWithWorkspace(ctxGlobalDev, () => customMcpService.create(input({ name: 'g-new' }))),
      ).rejects.toThrow('global workspace is read-only');
      await expect(
        runWithWorkspace(ctxGlobalDev, () => customMcpService.update(list[0].id, patch({ name: 'g-x' }))),
      ).rejects.toThrow('global workspace is read-only');
      await expect(
        runWithWorkspace(ctxGlobalDev, () => customMcpService.delete(list[0].id)),
      ).rejects.toThrow('global workspace is read-only');
      expect(await mcpCollection().countDocuments({})).toBe(1);
    });

    it('普通工作区 developer 成员读写通过', async () => {
      const created = await runWithWorkspace(ctxADev, () =>
        customMcpService.create(input({ name: 'dev-mcp' })),
      );
      const updated = await runWithWorkspace(ctxADev, () =>
        customMcpService.update(created.id, patch({ description: 'by dev' })),
      );
      expect(updated.description).toBe('by dev');
      const list = await runWithWorkspace(ctxADev, () => customMcpService.list());
      expect(list.map((mcp) => mcp.name)).toContain('dev-mcp');
      await expect(runWithWorkspace(ctxADev, () => customMcpService.delete(created.id))).resolves.toBe(
        true,
      );
    });

    it('无工作区上下文（引擎/内部链路）→ 读写一律拒绝', async () => {
      await expect(customMcpService.create(input({ name: 'no-ctx' }))).rejects.toThrow(
        'workspace not found',
      );
      await expect(customMcpService.list()).rejects.toThrow(
        'workspace not found',
      );
      await expect(customMcpService.get('000000000000000000000000')).rejects.toThrow(
        'workspace not found',
      );

      const existing = await createNone('no-ctx-existing');
      await expect(
        customMcpService.update(existing.id, patch({ name: 'no-ctx-renamed' })),
      ).rejects.toThrow('workspace not found');
      await expect(customMcpService.delete(existing.id)).rejects.toThrow(
        'workspace not found',
      );

      // 未被改写/删除（不跨租户读写面）
      expect(await mcpCollection().countDocuments({})).toBe(1);
      expect(String((await rawMcp(existing.id))!.name)).toBe('no-ctx-existing');
    });

    it('安全红线：视图与库内文档均无 token/value 明文', async () => {
      const mcp = await createBearerNew('secret-mcp', 'super-secret-token');
      const list = await runWithWorkspace(ctxA, () => customMcpService.list());
      expect(JSON.stringify(list)).not.toContain('super-secret-token');
      expect(JSON.stringify(await rawMcp(mcp.id))).not.toContain('super-secret-token');
      const entryRaw = await entryCollection().findOne({
        _id: new mongoose.Types.ObjectId(mcp.bearerEntryId!),
      });
      expect(JSON.stringify(entryRaw)).not.toContain('super-secret-token');
      expect(JSON.stringify(entryRaw)).not.toContain('valueEncrypted":"super');
    });
  });
});
