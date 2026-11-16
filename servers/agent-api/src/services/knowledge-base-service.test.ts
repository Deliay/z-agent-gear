import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { KnowledgeBase } from '../models/knowledge-base.js';
import { KnowledgeBaseDocument } from '../models/knowledge-base-document.js';
import { KnowledgeBaseEvent } from '../models/knowledge-base-event.js';
import { User } from '../models/user.js';
import {
  knowledgeBaseService,
  normalizeDocumentPath,
  type KnowledgeBaseDocumentInput,
} from './knowledge-base-service.js';
import { runWithWorkspace, type WorkspaceContext } from './workspace-context.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-knowledge-base-service-test'));
  await Promise.all([
    KnowledgeBase.init(),
    KnowledgeBaseDocument.init(),
    KnowledgeBaseEvent.init(),
  ]);
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const TENANT = '507f1f77bcf86cd7994390a1';
const WS_A = '507f1f77bcf86cd7994390b1';
const WS_B = '507f1f77bcf86cd7994390b2';
const WS_GLOBAL = '507f1f77bcf86cd7994390b3';
const ADMIN = '507f1f77bcf86cd7994390c1';
const DEV = '507f1f77bcf86cd7994390c2';

const adminA: WorkspaceContext = {
  id: WS_A,
  tenantId: TENANT,
  type: 'normal',
  role: 'admin',
  readOnly: false,
  globalWorkspaceId: WS_GLOBAL,
};
const devA: WorkspaceContext = { ...adminA, role: 'developer' };
const adminB: WorkspaceContext = { ...adminA, id: WS_B };
const adminGlobal: WorkspaceContext = {
  id: WS_GLOBAL,
  tenantId: TENANT,
  type: 'global',
  role: 'admin',
  readOnly: false,
  globalWorkspaceId: WS_GLOBAL,
};
const devGlobal: WorkspaceContext = { ...adminGlobal, role: 'developer', readOnly: true };

beforeEach(async () => {
  await Promise.all([
    KnowledgeBase.deleteMany({}),
    KnowledgeBaseDocument.deleteMany({}),
    KnowledgeBaseEvent.deleteMany({}),
    User.deleteMany({}),
  ]);
  await User.create({
    _id: new mongoose.Types.ObjectId(ADMIN),
    username: 'alice',
    passwordHash: 'x',
    name: 'Alice',
    tenantId: new mongoose.Types.ObjectId(TENANT),
  });
  await User.create({
    _id: new mongoose.Types.ObjectId(DEV),
    username: 'bob',
    passwordHash: 'x',
    name: 'Bob',
    tenantId: new mongoose.Types.ObjectId(TENANT),
  });
});

function input(overrides: Partial<KnowledgeBaseDocumentInput> = {}): KnowledgeBaseDocumentInput {
  return {
    title: '文档',
    tags: ['tag-a'],
    description: '描述',
    content: '# 内容',
    ...overrides,
  };
}

async function inCtx<T>(ctx: WorkspaceContext, fn: () => Promise<T>): Promise<T> {
  return runWithWorkspace(ctx, fn);
}

async function createKb(
  ctx: WorkspaceContext,
  name: string,
  userId = ADMIN,
): Promise<string> {
  const view = await inCtx(ctx, () => knowledgeBaseService.create(userId, name));
  return view.id;
}

async function createDoc(
  ctx: WorkspaceContext,
  kbId: string,
  path: string,
  data: KnowledgeBaseDocumentInput = input(),
  userId = ADMIN,
): Promise<void> {
  await inCtx(ctx, () => knowledgeBaseService.createDocument(userId, kbId, path, data));
}

describe('knowledge-base-service（T-KBS，真库）', () => {
  it('T-KBS1: 默认权限模式按工作区类型落库 + 重名预检与 E11000 收敛', async () => {
    const normal = await inCtx(adminA, () => knowledgeBaseService.create(ADMIN, '普通库'));
    expect(normal.permissionMode).toBe('NONE');

    const global = await inCtx(adminGlobal, () => knowledgeBaseService.create(ADMIN, '全局库'));
    expect(global.permissionMode).toBe('READ_ONLY');

    await expect(
      inCtx(adminA, () => knowledgeBaseService.create(ADMIN, ' 普通库 ')),
    ).rejects.toThrow('knowledge base name already exists');

    // 绕过预检触发唯一索引 E11000 → 同文案收敛
    const existsSpy = vi.spyOn(KnowledgeBase, 'exists').mockResolvedValueOnce(null as never);
    await expect(
      inCtx(adminA, () => knowledgeBaseService.create(ADMIN, '普通库')),
    ).rejects.toThrow('knowledge base name already exists');
    existsSpy.mockRestore();
  });

  it('T-KBS2: 非 admin 创建 → not a tenant admin（普通/全局 developer 同文案）', async () => {
    await expect(
      inCtx(devA, () => knowledgeBaseService.create(DEV, '开发者库')),
    ).rejects.toThrow('not a tenant admin');
    await expect(
      inCtx(devGlobal, () => knowledgeBaseService.create(DEV, '全局开发者库')),
    ).rejects.toThrow('not a tenant admin');
  });

  it('T-KBS3: 列表 = 本工作区 ∪ 全局 ∪ 模式过滤；myAccess 逐库正确', async () => {
    await createKb(adminA, 'A-NONE');
    await createKb(adminGlobal, 'G-READ');
    await createKb(adminB, 'B-FOREIGN');

    const devList = await inCtx(devA, () => knowledgeBaseService.list(DEV));
    expect(devList.map((item) => item.name)).toEqual(['G-READ']);
    expect(devList[0].global).toBe(true);
    expect(devList[0].myAccess).toMatchObject({ canRead: true, canUpdate: false, canDelete: false });

    const adminList = await inCtx(adminA, () => knowledgeBaseService.list(ADMIN));
    expect(adminList.map((item) => item.name).sort()).toEqual(['A-NONE', 'G-READ']);
    expect(adminList.find((item) => item.name === 'A-NONE')?.myAccess).toMatchObject({
      canRead: true,
      canCreate: true,
      canDelete: true,
      canManage: true,
    });

    // 收紧/放开模式后即时生效
    const aNone = adminList.find((item) => item.name === 'A-NONE')!;
    await inCtx(adminA, () =>
      knowledgeBaseService.updatePermission(ADMIN, aNone.id, 'READ_ONLY'),
    );
    const devAfter = await inCtx(devA, () => knowledgeBaseService.list(DEV));
    expect(devAfter.map((item) => item.name).sort()).toEqual(['A-NONE', 'G-READ']);
  });

  it('T-KBS4: 路径归一矩阵逐字（非法 → invalid document path）', () => {
    expect(normalizeDocumentPath('  /a/b/  ')).toBe('/a/b');
    expect(normalizeDocumentPath('/a/b')).toBe('/a/b');
    expect(normalizeDocumentPath('/')).toBe('/');

    const invalid = [
      'a/b',
      '/a//b',
      '/a/',
      `/${'a'.repeat(129)}`,
      '/a\u0000b',
      '/a\u0001b',
      `/${'a'.repeat(300)}/${'b'.repeat(300)}`,
    ];
    // '/a/' 归一为 '/a' 属合法；单独校验真正的非法输入
    for (const raw of invalid.filter((item) => item !== '/a/')) {
      expect(() => normalizeDocumentPath(raw)).toThrow('invalid document path');
    }
    expect(normalizeDocumentPath('/a/')).toBe('/a');
  });

  it('T-KBS5: 同路径重复创建 → knowledge base document already exists（含 E11000 收敛）', async () => {
    const kbId = await createKb(adminA, 'KB');
    await createDoc(adminA, kbId, '/a');
    await expect(
      inCtx(adminA, () => knowledgeBaseService.createDocument(ADMIN, kbId, '/a', input())),
    ).rejects.toThrow('knowledge base document already exists');

    const existsSpy = vi
      .spyOn(KnowledgeBaseDocument, 'exists')
      .mockResolvedValueOnce(null as never);
    await expect(
      inCtx(adminA, () => knowledgeBaseService.createDocument(ADMIN, kbId, '/a', input())),
    ).rejects.toThrow('knowledge base document already exists');
    existsSpy.mockRestore();
  });

  it('T-KBS6: 更新/删除不存在的文档 → knowledge base document not found', async () => {
    const kbId = await createKb(adminA, 'KB');
    await expect(
      inCtx(adminA, () =>
        knowledgeBaseService.updateDocument(ADMIN, kbId, '/missing', input()),
      ),
    ).rejects.toThrow('knowledge base document not found');
    await expect(
      inCtx(adminA, () => knowledgeBaseService.deleteDocument(ADMIN, kbId, '/missing')),
    ).rejects.toThrow('knowledge base document not found');
  });

  it('T-KBS7: CREATE/UPDATE/DELETE 事件快照完整（DELETE 保留删除前内容、actor 快照、createdAt）', async () => {
    const kbId = await createKb(adminA, 'KB');
    await createDoc(adminA, kbId, '/a', input({ title: 'v1', content: 'c1' }));
    await inCtx(adminA, () =>
      knowledgeBaseService.updateDocument(
        ADMIN,
        kbId,
        '/a',
        input({ title: 'v2', content: 'c2', tags: ['x', 'y'] }),
      ),
    );
    await inCtx(adminA, () => knowledgeBaseService.deleteDocument(ADMIN, kbId, '/a'));

    const events = await inCtx(adminA, () =>
      knowledgeBaseService.listEvents(ADMIN, kbId, { path: '/a' }),
    );
    expect(events.map((event) => event.op)).toEqual(['DELETE', 'UPDATE', 'CREATE']);
    expect(events[0]).toMatchObject({
      path: '/a',
      title: 'v2',
      content: 'c2',
      tags: ['x', 'y'],
      actorName: 'Alice',
    });
    expect(events[1]).toMatchObject({ title: 'v2', content: 'c2' });
    expect(events[2]).toMatchObject({ title: 'v1', content: 'c1' });
    for (const event of events) {
      expect(event.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('T-KBS8: 删除释放路径 → 同路径重建成功；单路径历史跨删除延续、倒序完整', async () => {
    const kbId = await createKb(adminA, 'KB');
    await createDoc(adminA, kbId, '/a', input({ title: 'first' }));
    await inCtx(adminA, () => knowledgeBaseService.deleteDocument(ADMIN, kbId, '/a'));

    // 路径已释放：列表为空、可立即重建
    expect(await inCtx(adminA, () => knowledgeBaseService.listDocuments(ADMIN, kbId))).toEqual([]);
    await createDoc(adminA, kbId, '/a', input({ title: 'second' }));

    const events = await inCtx(adminA, () =>
      knowledgeBaseService.listEvents(ADMIN, kbId, { path: '/a' }),
    );
    expect(events.map((event) => event.op)).toEqual(['CREATE', 'DELETE', 'CREATE']);
    expect(events[0].title).toBe('second');
    expect(events[1].title).toBe('first');
  });

  it('T-KBS9: 库级历史 createdAt 倒序；limit 缺省 50 / 上限 200；before 游标正确', async () => {
    const kbId = await createKb(adminA, 'KB');
    const base = Date.now() - 100_000;
    const rows = Array.from({ length: 205 }, (_, index) => ({
      tenantId: TENANT,
      knowledgeBaseId: new mongoose.Types.ObjectId(kbId),
      path: `/doc-${index}`,
      op: 'CREATE',
      title: `t-${index}`,
      tags: [],
      description: '',
      content: '',
      actorId: ADMIN,
      actorName: 'Alice',
      createdAt: new Date(base + index * 1000),
    }));
    await KnowledgeBaseEvent.insertMany(rows);

    const defaulted = await inCtx(adminA, () =>
      knowledgeBaseService.listEvents(ADMIN, kbId),
    );
    expect(defaulted).toHaveLength(50);
    expect(defaulted[0].path).toBe('/doc-204');

    const capped = await inCtx(adminA, () =>
      knowledgeBaseService.listEvents(ADMIN, kbId, { limit: 1000 }),
    );
    expect(capped).toHaveLength(200);

    const cursorTime = new Date(base + 200 * 1000).toISOString();
    const before = await inCtx(adminA, () =>
      knowledgeBaseService.listEvents(ADMIN, kbId, { before: cursorTime, limit: 3 }),
    );
    expect(before.map((event) => event.path)).toEqual([
      '/doc-199',
      '/doc-198',
      '/doc-197',
    ]);
  });

  it('T-KBS10: 删除库级联删 documents+events；rename/updatePermission 仅 canManage', async () => {
    const kbId = await createKb(adminA, 'KB');
    await createDoc(adminA, kbId, '/a');

    await expect(
      inCtx(devA, () => knowledgeBaseService.rename(DEV, kbId, 'x')),
    ).rejects.toThrow('knowledge base not found');

    // FULL_ACCESS 的 developer 可写库内文档但不可管理库
    await inCtx(adminA, () =>
      knowledgeBaseService.updatePermission(ADMIN, kbId, 'FULL_ACCESS'),
    );
    await expect(
      inCtx(devA, () => knowledgeBaseService.rename(DEV, kbId, 'x')),
    ).rejects.toThrow('knowledge base permission denied');
    await expect(
      inCtx(devA, () => knowledgeBaseService.updatePermission(DEV, kbId, 'READ_ONLY')),
    ).rejects.toThrow('knowledge base permission denied');

    const renamed = await inCtx(adminA, () =>
      knowledgeBaseService.rename(ADMIN, kbId, 'KB-renamed'),
    );
    expect(renamed.name).toBe('KB-renamed');

    await inCtx(adminA, () => knowledgeBaseService.remove(ADMIN, kbId));
    expect(await KnowledgeBaseDocument.countDocuments({ knowledgeBaseId: kbId })).toBe(0);
    expect(await KnowledgeBaseEvent.countDocuments({ knowledgeBaseId: kbId })).toBe(0);
  });

  it('T-KBS11: 越权逐字 + 不泄露存在性 + 无 ALS → workspace not found', async () => {
    const kbId = await createKb(adminA, 'KB-NONE');
    await createDoc(adminA, kbId, '/a');

    // NONE + developer：读不可见 → 列表报不存在、单文档 null
    await expect(
      inCtx(devA, () => knowledgeBaseService.listDocuments(DEV, kbId)),
    ).rejects.toThrow('knowledge base not found');
    expect(
      await inCtx(devA, () => knowledgeBaseService.getDocument(DEV, kbId, '/a')),
    ).toBeNull();
    expect(
      await inCtx(devA, () =>
        knowledgeBaseService.getDocument(DEV, '507f1f77bcf86cd799439999', '/a'),
      ),
    ).toBeNull();

    // READ_ONLY + developer：写越权
    await inCtx(adminA, () =>
      knowledgeBaseService.updatePermission(ADMIN, kbId, 'READ_ONLY'),
    );
    await expect(
      inCtx(devA, () => knowledgeBaseService.createDocument(DEV, kbId, '/b', input())),
    ).rejects.toThrow('knowledge base permission denied');
    await expect(
      inCtx(devA, () => knowledgeBaseService.updateDocument(DEV, kbId, '/a', input())),
    ).rejects.toThrow('knowledge base permission denied');
    await expect(
      inCtx(devA, () => knowledgeBaseService.deleteDocument(DEV, kbId, '/a')),
    ).rejects.toThrow('knowledge base permission denied');

    // 全局工作区 developer（readOnly）对 UPDATE_ONLY 全局库可写（D2/T-KBA8 服务层落地）
    const globalId = await createKb(adminGlobal, 'G');
    await inCtx(adminGlobal, () =>
      knowledgeBaseService.updatePermission(ADMIN, globalId, 'UPDATE_ONLY'),
    );
    await inCtx(devGlobal, () =>
      knowledgeBaseService.createDocument(DEV, globalId, '/g', input()),
    );
    await expect(
      inCtx(devGlobal, () => knowledgeBaseService.deleteDocument(DEV, globalId, '/g')),
    ).rejects.toThrow('knowledge base permission denied');

    // 无 ALS 上下文
    await expect(knowledgeBaseService.list(ADMIN)).rejects.toThrow('workspace not found');
  });

  it('T-KBS12: 输入校验边界逐字（title/tags/description/content）', async () => {
    const kbId = await createKb(adminA, 'KB');
    const cases: Array<[KnowledgeBaseDocumentInput, string]> = [
      [input({ title: '' }), 'invalid document title'],
      [input({ title: ' '.repeat(3) }), 'invalid document title'],
      [input({ title: 'a'.repeat(201) }), 'invalid document title'],
      [
        input({ tags: Array.from({ length: 17 }, (_, index) => `t-${index}`) }),
        'invalid document tags',
      ],
      [input({ tags: ['a'.repeat(33)] }), 'invalid document tags'],
      [input({ tags: ['ok', '   '] }), 'invalid document tags'],
      [input({ description: 'd'.repeat(1025) }), 'invalid document description'],
      [input({ content: 'c'.repeat(262_145) }), 'invalid document content'],
    ];
    for (const [data, message] of cases) {
      await expect(
        inCtx(adminA, () => knowledgeBaseService.createDocument(ADMIN, kbId, '/case', data)),
      ).rejects.toThrow(message);
    }

    await createDoc(
      adminA,
      kbId,
      '/dedupe',
      input({ tags: [' a ', 'a', 'b', 'b'] }),
    );
    const doc = await inCtx(adminA, () =>
      knowledgeBaseService.getDocument(ADMIN, kbId, '/dedupe'),
    );
    expect(doc?.tags).toEqual(['a', 'b']);
  });
});
