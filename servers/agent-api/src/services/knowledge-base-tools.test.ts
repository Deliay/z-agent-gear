import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { KnowledgeBase } from '../models/knowledge-base.js';
import { KnowledgeBaseDocument } from '../models/knowledge-base-document.js';
import { KnowledgeBaseEvent } from '../models/knowledge-base-event.js';
import { User } from '../models/user.js';
import { knowledgeBaseService } from './knowledge-base-service.js';
import {
  handleKnowledgeBaseToolsMcpRequest,
  KNOWLEDGE_BASE_TOOL_DEFINITIONS,
  KNOWLEDGE_BASE_TOOLS_SERVER_NAME,
} from './knowledge-base-tools.js';
import { runWithWorkspace, type WorkspaceContext } from './workspace-context.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-knowledge-base-tools-test'));
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
const adminGlobal: WorkspaceContext = {
  id: WS_GLOBAL,
  tenantId: TENANT,
  type: 'global',
  role: 'admin',
  readOnly: false,
  globalWorkspaceId: WS_GLOBAL,
};

const caller = { userId: ADMIN, sessionId: 'session-1' };

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

const DOC_INPUT = { title: '文档', tags: ['a'], description: 'd', content: '# c' };

type ToolOutcome = { result?: any; error?: { code: string; message: string } };

function textOf(outcome: ToolOutcome): any {
  return JSON.parse(outcome.result.content[0].text);
}

function isErrorOf(outcome: ToolOutcome): boolean {
  return outcome.result?.isError === true;
}

async function call(
  ctx: WorkspaceContext,
  name: string,
  args: Record<string, unknown> = {},
  toolCaller = caller,
): Promise<ToolOutcome> {
  return runWithWorkspace(ctx, () =>
    handleKnowledgeBaseToolsMcpRequest(toolCaller, {
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  );
}

async function createKb(ctx: WorkspaceContext, name: string, userId = ADMIN): Promise<string> {
  const view = await runWithWorkspace(ctx, () => knowledgeBaseService.create(userId, name));
  return view.id;
}

describe('knowledge-base-tools（T-KBT）', () => {
  it('T-KBT1: tools/list 按角色门控 knowledge_base_create', async () => {
    const adminTools = await runWithWorkspace(adminA, () =>
      handleKnowledgeBaseToolsMcpRequest(caller, { method: 'tools/list' }),
    );
    expect(
      (adminTools.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name),
    ).toEqual(KNOWLEDGE_BASE_TOOL_DEFINITIONS.map((tool) => tool.name));

    const devTools = await runWithWorkspace(devA, () =>
      handleKnowledgeBaseToolsMcpRequest(caller, { method: 'tools/list' }),
    );
    const names = (devTools.result as { tools: Array<{ name: string }> }).tools.map(
      (tool) => tool.name,
    );
    expect(names).not.toContain('knowledge_base_create');
    expect(names).toHaveLength(5);

    // 无工作区上下文按非 admin 收紧（不泄露写入口）
    const anonymousTools = await handleKnowledgeBaseToolsMcpRequest(caller, { method: 'tools/list' });
    expect(
      (anonymousTools.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name),
    ).not.toContain('knowledge_base_create');
    expect(KNOWLEDGE_BASE_TOOLS_SERVER_NAME).toBe('agent-knowledge-base-tools');
  });

  it('T-KBT2: initialize/ping/notifications 形态；未知方法与未知工具 → METHOD_NOT_FOUND', async () => {
    await expect(
      handleKnowledgeBaseToolsMcpRequest(caller, { method: 'initialize' }),
    ).resolves.toMatchObject({
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: KNOWLEDGE_BASE_TOOLS_SERVER_NAME },
      },
    });
    await expect(handleKnowledgeBaseToolsMcpRequest(caller, { method: 'ping' })).resolves.toEqual({
      result: {},
    });
    await expect(
      handleKnowledgeBaseToolsMcpRequest(caller, { method: 'notifications/initialized' }),
    ).resolves.toEqual({ result: {} });
    await expect(
      handleKnowledgeBaseToolsMcpRequest(caller, { method: 'resources/list' }),
    ).resolves.toMatchObject({ error: { code: 'METHOD_NOT_FOUND' } });

    const unknownTool = await call(adminA, 'knowledge_base_delete_everything');
    expect(unknownTool.error).toMatchObject({ code: 'METHOD_NOT_FOUND' });
  });

  it('T-RKB-P5: prompts/list 单片段；prompts/get 正常返回与 INVALID_PARAMS 两分支', async () => {
    await expect(
      handleKnowledgeBaseToolsMcpRequest(caller, { method: 'prompts/list' }),
    ).resolves.toEqual({
      result: {
        prompts: [
          {
            name: 'repo-knowledge-base-authoring',
            description: expect.stringContaining('仓库知识库编写指引'),
          },
        ],
      },
    });

    const got = await handleKnowledgeBaseToolsMcpRequest(caller, {
      method: 'prompts/get',
      params: { name: 'repo-knowledge-base-authoring' },
    });
    expect(got.error).toBeUndefined();
    expect(got.result).toMatchObject({
      description: expect.stringContaining('仓库知识库编写指引'),
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: expect.stringContaining('.zag/knowledges/') },
        },
      ],
    });

    await expect(
      handleKnowledgeBaseToolsMcpRequest(caller, { method: 'prompts/get' }),
    ).resolves.toMatchObject({
      error: {
        code: 'INVALID_PARAMS',
        message: expect.stringContaining('repo-knowledge-base-authoring'),
      },
    });
    await expect(
      handleKnowledgeBaseToolsMcpRequest(caller, {
        method: 'prompts/get',
        params: { name: 'unknown' },
      }),
    ).resolves.toMatchObject({
      error: {
        code: 'INVALID_PARAMS',
        message: expect.stringContaining('repo-knowledge-base-authoring'),
      },
    });
  });

  it('T-KBT3: developer 直接调 knowledge_base_create → isError not a tenant admin（双校验）', async () => {
    const outcome = await call(devA, 'knowledge_base_create', { name: 'dev-kb' }, {
      userId: DEV,
      sessionId: 'session-1',
    });
    expect(isErrorOf(outcome)).toBe(true);
    expect(outcome.result.content[0].text).toBe('not a tenant admin');
    expect(await KnowledgeBase.countDocuments({})).toBe(0);
  });

  it('T-KBT4: knowledge_base_list 只出可见集且字段仅 id/name/global/permissionMode/myAccess', async () => {
    await createKb(adminA, 'A-NONE');
    await createKb(adminGlobal, 'G-READ');

    const outcome = await call(adminA, 'knowledge_base_list');
    const list = textOf(outcome);
    expect(list.map((item: any) => item.name).sort()).toEqual(['A-NONE', 'G-READ']);
    for (const item of list) {
      expect(Object.keys(item).sort()).toEqual([
        'global',
        'id',
        'myAccess',
        'name',
        'permissionMode',
      ]);
    }

    const devOutcome = await call(devA, 'knowledge_base_list', {}, { userId: DEV, sessionId: 's' });
    const devList = textOf(devOutcome);
    expect(devList.map((item: any) => item.name)).toEqual(['G-READ']);
  });

  it('T-KBT5: document_list 只出元信息（无 content）；无读权限库 → isError', async () => {
    const kbId = await createKb(adminA, 'KB');
    await runWithWorkspace(adminA, () =>
      knowledgeBaseService.createDocument(ADMIN, kbId, '/a/b', DOC_INPUT),
    );

    const outcome = await call(adminA, 'knowledge_base_document_list', {
      knowledgeBaseId: kbId,
    });
    const docs = textOf(outcome);
    expect(docs).toEqual([
      { path: '/a/b', title: '文档', tags: ['a'], description: 'd', updatedAt: expect.any(String) },
    ]);
    expect(outcome.result.content[0].text).not.toContain('# c');

    const forbidden = await call(
      devA,
      'knowledge_base_document_list',
      { knowledgeBaseId: kbId },
      { userId: DEV, sessionId: 's' },
    );
    expect(isErrorOf(forbidden)).toBe(true);
    expect(forbidden.result.content[0].text).toBe('knowledge base not found');
  });

  it('T-KBT6: get/update/delete 权限矩阵（UPDATE_ONLY 删除拒绝 permission denied）', async () => {
    const kbId = await createKb(adminA, 'KB');
    await runWithWorkspace(adminA, () =>
      knowledgeBaseService.createDocument(ADMIN, kbId, '/a', DOC_INPUT),
    );
    const devCaller = { userId: DEV, sessionId: 's' };

    // READ_ONLY：可读、不可写
    await runWithWorkspace(adminA, () =>
      knowledgeBaseService.updatePermission(ADMIN, kbId, 'READ_ONLY'),
    );
    expect(isErrorOf(await call(devA, 'knowledge_base_document_get', { knowledgeBaseId: kbId, path: '/a' }, devCaller))).toBe(false);
    const readOnlyUpdate = await call(
      devA,
      'knowledge_base_document_update',
      { knowledgeBaseId: kbId, path: '/a', ...DOC_INPUT },
      devCaller,
    );
    expect(readOnlyUpdate.result.content[0].text).toBe('knowledge base permission denied');
    expect(isErrorOf(readOnlyUpdate)).toBe(true);

    // UPDATE_ONLY：可更新、不可删除
    await runWithWorkspace(adminA, () =>
      knowledgeBaseService.updatePermission(ADMIN, kbId, 'UPDATE_ONLY'),
    );
    const updated = await call(
      devA,
      'knowledge_base_document_update',
      { knowledgeBaseId: kbId, path: '/a', ...DOC_INPUT, title: 'v2' },
      devCaller,
    );
    expect(isErrorOf(updated)).toBe(false);
    expect(textOf(updated).title).toBe('v2');

    const delDenied = await call(
      devA,
      'knowledge_base_document_delete',
      { knowledgeBaseId: kbId, path: '/a' },
      devCaller,
    );
    expect(isErrorOf(delDenied)).toBe(true);
    expect(delDenied.result.content[0].text).toBe('knowledge base permission denied');

    // FULL_ACCESS：可删除
    await runWithWorkspace(adminA, () =>
      knowledgeBaseService.updatePermission(ADMIN, kbId, 'FULL_ACCESS'),
    );
    const deleted = await call(
      devA,
      'knowledge_base_document_delete',
      { knowledgeBaseId: kbId, path: '/a' },
      devCaller,
    );
    expect(isErrorOf(deleted)).toBe(false);
    expect(textOf(deleted)).toEqual({ success: true });
  });

  it('T-KBT7: document_update upsert：存在 → UPDATE 事件；不存在 → CREATE 事件', async () => {
    const kbId = await createKb(adminA, 'KB');

    const created = await call(adminA, 'knowledge_base_document_update', {
      knowledgeBaseId: kbId,
      path: '/new',
      ...DOC_INPUT,
    });
    expect(isErrorOf(created)).toBe(false);
    expect(textOf(created).path).toBe('/new');

    await call(adminA, 'knowledge_base_document_update', {
      knowledgeBaseId: kbId,
      path: '/new',
      ...DOC_INPUT,
      title: 'after',
    });

    const events = await runWithWorkspace(adminA, () =>
      knowledgeBaseService.listEvents(ADMIN, kbId, { path: '/new' }),
    );
    expect(events.map((event) => event.op)).toEqual(['UPDATE', 'CREATE']);
    expect(events[0].title).toBe('after');
  });

  it('T-KBT8: 库定位 id 优先/name 兜底；name 0/多命中 → isError 明确提示', async () => {
    const byNameId = await createKb(adminA, '可读库');
    await runWithWorkspace(adminA, () =>
      knowledgeBaseService.createDocument(ADMIN, byNameId, '/a', DOC_INPUT),
    );

    const byName = await call(adminA, 'knowledge_base_document_get', {
      knowledgeBaseName: '可读库',
      path: '/a',
    });
    expect(isErrorOf(byName)).toBe(false);
    expect(textOf(byName).path).toBe('/a');

    // id 优先：错误的 name 不影响 id 命中
    const byId = await call(adminA, 'knowledge_base_document_get', {
      knowledgeBaseId: byNameId,
      knowledgeBaseName: '不存在的名字',
      path: '/a',
    });
    expect(isErrorOf(byId)).toBe(false);

    const missing = await call(adminA, 'knowledge_base_document_list', {
      knowledgeBaseName: '不存在',
    });
    expect(isErrorOf(missing)).toBe(true);
    expect(missing.result.content[0].text).toContain('knowledge base not found: 不存在');

    // 多命中：本工作区 + 全局工作区同名库对普通工作区成员同时可见
    const dupId = await createKb(adminA, '重名库');
    await runWithWorkspace(adminA, () =>
      knowledgeBaseService.updatePermission(ADMIN, dupId, 'READ_ONLY'),
    );
    await createKb(adminGlobal, '重名库');
    const ambiguous = await call(
      devA,
      'knowledge_base_document_list',
      { knowledgeBaseName: '重名库' },
      { userId: DEV, sessionId: 's' },
    );
    expect(isErrorOf(ambiguous)).toBe(true);
    expect(ambiguous.result.content[0].text).toContain('multiple knowledge bases named');

    const missingLocator = await call(adminA, 'knowledge_base_document_list', {});
    expect(isErrorOf(missingLocator)).toBe(true);
    expect(missingLocator.result.content[0].text).toBe(
      'knowledgeBaseId or knowledgeBaseName is required',
    );
  });
});

describe('knowledge-base-tools 移动（T-KBT-M）', () => {
  it('T-KBT-M1: newPath 生效——先移动再更新、返回新路径、历史含 MOVE；inputSchema 含可选 newPath', async () => {
    const kbId = await createKb(adminA, 'KB');
    await runWithWorkspace(adminA, () =>
      knowledgeBaseService.createDocument(ADMIN, kbId, '/a', DOC_INPUT),
    );

    const outcome = await call(adminA, 'knowledge_base_document_update', {
      knowledgeBaseId: kbId,
      path: '/a',
      newPath: '/b',
      ...DOC_INPUT,
      title: 'moved',
    });
    expect(isErrorOf(outcome)).toBe(false);
    expect(textOf(outcome).path).toBe('/b');
    expect(textOf(outcome).title).toBe('moved');

    const events = await runWithWorkspace(adminA, () =>
      knowledgeBaseService.listEvents(ADMIN, kbId, { path: '/b' }),
    );
    // 标题同次变化 → 先 MOVE（移动前快照）后 UPDATE（新内容），D5
    expect(events.map((event) => event.op)).toEqual(['UPDATE', 'MOVE', 'CREATE']);
    expect(events[1].fromPath).toBe('/a');

    const updateTool = KNOWLEDGE_BASE_TOOL_DEFINITIONS.find(
      (tool) => tool.name === 'knowledge_base_document_update',
    );
    const properties = (updateTool?.inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect(properties).toHaveProperty('newPath');
    expect((updateTool?.inputSchema as { required: string[] }).required).not.toContain('newPath');
  });

  it('T-KBT-M2: 创建分支携带 newPath → isError document not found；越权移动 → permission denied', async () => {
    const kbId = await createKb(adminA, 'KB');

    const created = await call(adminA, 'knowledge_base_document_update', {
      knowledgeBaseId: kbId,
      path: '/brand-new',
      newPath: '/moved',
      ...DOC_INPUT,
    });
    expect(isErrorOf(created)).toBe(true);
    expect(created.result.content[0].text).toBe('knowledge base document not found');
    expect(await KnowledgeBaseDocument.countDocuments({ knowledgeBaseId: kbId })).toBe(0);

    await runWithWorkspace(adminA, () =>
      knowledgeBaseService.createDocument(ADMIN, kbId, '/a', DOC_INPUT),
    );
    await runWithWorkspace(adminA, () =>
      knowledgeBaseService.updatePermission(ADMIN, kbId, 'READ_ONLY'),
    );
    const denied = await call(
      devA,
      'knowledge_base_document_update',
      { knowledgeBaseId: kbId, path: '/a', newPath: '/b', ...DOC_INPUT },
      { userId: DEV, sessionId: 's' },
    );
    expect(isErrorOf(denied)).toBe(true);
    expect(denied.result.content[0].text).toBe('knowledge base permission denied');
  });
});
