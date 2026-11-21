import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';
import mongoose from 'mongoose';
import { createFrontUser, type FrontUser } from '../support/front-users.js';

/**
 * 仓库内建知识库 API（T-RKB-API1~6/8；API7 由既有 T-KB-API 套件随批回归覆盖）。
 *
 * 前置：`aspire start && aspire wait agent-api controller-api` + `INTERNAL_API_TOKEN`；
 * 云电脑夹具直写 Mongo（`MONGODB_URI`，缺省时核心套件 skip）；fake controller 应答
 * `knowledge-bases:scan`（fixture 与 agent-gear 真实回包同形态）并记录 `scans[]`。
 * MCP 用例（T-RKB-API6）走 fake controller relay，不依赖 Mongo。
 */

const AGENT_API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273';
const MONGODB_URI = process.env.MONGODB_URI ?? '';
const HAS_MONGO = Boolean(MONGODB_URI);

function gqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(AGENT_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
}

async function gql(query: string, variables: Record<string, unknown> | undefined, token: string) {
  const res = await gqlRequest(query, variables, token);
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

function createClient(): ClientSocket {
  return SocketIOClient(CONTROLLER_API_URL, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
}

function waitForEvent<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

const CREATE_KEY = `
  mutation CreateControllerKey($input: CreateKeyInput!) {
    createControllerKey(input: $input) { key { id name } rawKey }
  }
`;

const CREATE_WORKSPACE = `
  mutation CreateWorkspace($input: CreateWorkspaceInput!) {
    createWorkspace(input: $input) { id controllerId path }
  }
`;

const CREATE_SESSION = `
  mutation CreateSession($input: CreateSessionInput!) {
    createSession(input: $input) { session { id controllerId acpServerType status } }
  }
`;

const DELETE_SESSION = `mutation DeleteSession($id: ID!) { deleteSession(id: $id) }`;

const GET_MCP_SERVERS = `query GetMcpServers { mcpServers { id name source enabled } }`;

const REPO_KNOWLEDGE_BASE_HOSTS = `
  query RepoKnowledgeBaseHosts {
    repoKnowledgeBaseHosts { cloudHostId cloudHostName workspaceId scanSupported }
  }
`;

const REPO_KNOWLEDGE_BASES = `
  query RepoKnowledgeBases($workspaceId: ID!, $refresh: Boolean) {
    repoKnowledgeBases(workspaceId: $workspaceId, refresh: $refresh) {
      id name description source folder workspaceId cloudHostId cloudHostName
      valid errors documentCount truncated
    }
  }
`;

const REPO_KB_CHILDREN = `
  query RepoKbChildren($id: ID!, $path: String) {
    repoKnowledgeBaseDocumentChildren(id: $id, path: $path) { kind name path error }
  }
`;

const REPO_KB_DOCUMENT = `
  query RepoKbDocument($id: ID!, $path: String!) {
    repoKnowledgeBaseDocument(id: $id, path: $path) { path title content }
  }
`;

const LARGE_DOC_COUNT = 55;
const LARGE_DOC_CHUNK = 'x'.repeat(20 * 1024);
const LARGE_DOCS = Array.from({ length: LARGE_DOC_COUNT }, (_, index) => ({
  path: `d${String(index).padStart(2, '0')}.md`,
  content: LARGE_DOC_CHUNK,
}));

const SCAN_FIXTURE = {
  success: true,
  sources: [
    {
      source: 'zag',
      knowledgeBases: [
        {
          folder: 'team-rules',
          schema: '{"name":"团队规范","description":"规范库"}',
          documents: [
            {
              path: 'guides/git.md',
              content: '---\ntitle: Git 规范\ntags: [git]\ncustom: 自定义\n---\n# 正文',
            },
            { path: 'onboarding.md', content: '# 上手' },
          ],
        },
        { folder: 'broken', schema: '{bad json', documents: [] },
        {
          folder: 'large',
          schema: '{"name":"大库"}',
          // 55 篇 × 20KiB ≈ 1.1MiB：超过旧「每库 50 篇 / 1MiB」口径，二期应全量返回
          documents: LARGE_DOCS,
          truncated: false,
        },
      ],
      truncated: false,
    },
    {
      source: 'docs',
      knowledgeBases: [
        {
          folder: 'product-docs',
          schema: '{"name":"产品文档"}',
          documents: [{ path: 'big.md', error: 'file too large' }],
        },
        {
          folder: 'truncated-docs',
          schema: '{"name":"截断库"}',
          documents: [{ path: 'x.md', content: '# X' }],
          truncated: true,
        },
      ],
      truncated: true,
    },
    {
      source: 'docs-root',
      knowledgeBases: [
        {
          folder: 'guides',
          schema: '{"name":"指南"}',
          documents: [{ path: 'api/rest.md', content: '# REST' }],
          truncated: false,
        },
      ],
      truncated: false,
    },
  ],
  truncated: true,
};

/** 旧版 agent-gear 回包形状（仅 zag / docs 两来源） */
const LEGACY_SCAN_FIXTURE = {
  success: true,
  sources: SCAN_FIXTURE.sources.slice(0, 2),
  truncated: false,
};

interface FakeController {
  client: ClientSocket;
  controllerId: string;
  rawKey: string;
  scans: Array<{ requestId: string; path: string }>;
}

async function registerFakeController(
  token: string,
  tag: string,
  version = '2.19.0',
  withScan = true,
  scanResult: Record<string, unknown> = SCAN_FIXTURE,
): Promise<FakeController> {
  const data = await gql(
    CREATE_KEY,
    { input: { name: `rkb-${tag}-${Date.now()}`, type: 'local' } },
    token,
  );
  const rawKey = data.createControllerKey.rawKey as string;
  const client = createClient();
  const scans: Array<{ requestId: string; path: string }> = [];

  client.on('acp:check', (payload: { requestId: string }) => {
    client.emit('acp:check:result', {
      requestId: payload.requestId,
      servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
    });
  });
  client.on('acp:stop', (payload: { sessionId: string }) => {
    client.emit('acp:stopped', { sessionId: payload.sessionId, reason: 'user_delete' });
  });
  if (withScan) {
    client.on('knowledge-bases:scan', (payload: { requestId: string; path: string }) => {
      scans.push(payload);
      client.emit('knowledge-bases:scan:result', {
        requestId: payload.requestId,
        ...scanResult,
      });
    });
  }

  const heartbeat = setInterval(() => {
    if (client.connected) client.emit('heartbeat');
  }, 30_000);
  client.on('disconnect', () => clearInterval(heartbeat));

  const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
  client.emit('register', {
    key: rawKey,
    hostname: `rkb-${tag}-${Date.now()}`,
    version,
    homeDir: '/home/fake',
    platform: 'linux',
  });
  const reg = await registered;
  return { client, controllerId: reg.controllerId, rawKey, scans };
}

async function createWorkspace(token: string, controllerId: string): Promise<string> {
  const data = await gql(
    CREATE_WORKSPACE,
    { input: { controllerId, path: `/tmp/rkb-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` } },
    token,
  );
  return data.createWorkspace.id as string;
}

async function mongoDb(): Promise<mongoose.mongo.Db> {
  if (!MONGODB_URI) throw new Error('MONGODB_URI required');
  if (mongoose.connection.readyState === 0) await mongoose.connect(MONGODB_URI);
  return mongoose.connection.db as mongoose.mongo.Db;
}

async function insertRunningCloudHost(input: {
  user: FrontUser;
  controllerId: string;
  workspaceId: string;
  name: string;
}): Promise<string> {
  const db = await mongoDb();
  const _id = new mongoose.Types.ObjectId();
  await db.collection('cloudhosts').insertOne({
    _id,
    userId: new mongoose.Types.ObjectId(input.user.userId),
    tenantId: new mongoose.Types.ObjectId(input.user.tenantId),
    name: input.name,
    harnessTypes: [],
    status: 'RUNNING',
    controllerId: new mongoose.Types.ObjectId(input.controllerId),
    keyId: new mongoose.Types.ObjectId(),
    workspaceId: new mongoose.Types.ObjectId(input.workspaceId),
    resourceWorkspaceId: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return _id.toString();
}

describe.skipIf(!HAS_MONGO)('仓库内建知识库 API（T-RKB-API1~5/8）', () => {
  let user: FrontUser;
  let fake: FakeController;
  let oldFake: FakeController;
  let legacyFake: FakeController;
  let workspaceId = '';
  let oldWorkspaceId = '';
  let legacyWorkspaceId = '';
  let hostId = '';
  let oldHostId = '';
  let legacyHostId = '';

  beforeAll(async () => {
    user = await createFrontUser();
    fake = await registerFakeController(user.token, 'main', '2.19.0');
    workspaceId = await createWorkspace(user.token, fake.controllerId);
    hostId = await insertRunningCloudHost({
      user,
      controllerId: fake.controllerId,
      workspaceId,
      name: '云电脑甲',
    });

    oldFake = await registerFakeController(user.token, 'old', '2.18.0', false);
    oldWorkspaceId = await createWorkspace(user.token, oldFake.controllerId);
    oldHostId = await insertRunningCloudHost({
      user,
      controllerId: oldFake.controllerId,
      workspaceId: oldWorkspaceId,
      name: '云电脑乙',
    });

    legacyFake = await registerFakeController(
      user.token,
      'legacy',
      '2.19.0',
      true,
      LEGACY_SCAN_FIXTURE,
    );
    legacyWorkspaceId = await createWorkspace(user.token, legacyFake.controllerId);
    legacyHostId = await insertRunningCloudHost({
      user,
      controllerId: legacyFake.controllerId,
      workspaceId: legacyWorkspaceId,
      name: '旧版两来源云电脑',
    });
  }, 60_000);

  afterAll(async () => {
    fake?.client.disconnect();
    oldFake?.client.disconnect();
    legacyFake?.client.disconnect();
    if (HAS_MONGO && mongoose.connection.readyState !== 0) await mongoose.disconnect();
  }, 60_000);

  it('T-RKB-API1 未认证：四个新查询一律 Not authenticated', async () => {
    for (const query of [
      REPO_KNOWLEDGE_BASE_HOSTS,
      REPO_KNOWLEDGE_BASES,
      REPO_KB_CHILDREN,
      REPO_KB_DOCUMENT,
    ]) {
      const res = await gqlRequest(
        query,
        query === REPO_KNOWLEDGE_BASE_HOSTS
          ? undefined
          : query === REPO_KB_DOCUMENT
            ? { id: 'repo:x:zag:a', path: '/a' }
            : query === REPO_KB_CHILDREN
              ? { id: 'repo:x:zag:a' }
              : { workspaceId: 'ws-1' },
      );
      const body = await res.json();
      expect(body.errors?.[0]?.message).toContain('Not authenticated');
    }
  });

  it('T-RKB-API2 骨架查询只列 RUNNING 且不触发扫描；版本 2.18.0 → scanSupported=false', async () => {
    const before = fake.scans.length + oldFake.scans.length;
    const data = await gql(REPO_KNOWLEDGE_BASE_HOSTS, undefined, user.token);
    const hosts = data.repoKnowledgeBaseHosts as Array<Record<string, unknown>>;

    const current = hosts.find((host) => host.cloudHostId === hostId);
    const old = hosts.find((host) => host.cloudHostId === oldHostId);
    expect(current).toMatchObject({ workspaceId, scanSupported: true, cloudHostName: '云电脑甲' });
    expect(old).toMatchObject({ workspaceId: oldWorkspaceId, scanSupported: false });
    expect(fake.scans.length + oldFake.scans.length).toBe(before);
  });

  it('T-RKB-API3 首次展开触发一次扫描并缓存；refresh 强制重扫；三来源形状', async () => {
    const first = await gql(REPO_KNOWLEDGE_BASES, { workspaceId }, user.token);
    const afterFirst = fake.scans.length;
    expect(afterFirst).toBeGreaterThanOrEqual(1);
    const list = first.repoKnowledgeBases as Array<Record<string, unknown>>;
    expect(list.map((item) => [item.source, item.folder, item.valid])).toEqual([
      ['ZAG', 'broken', false],
      ['ZAG', 'large', true],
      ['ZAG', 'team-rules', true],
      ['DOCS', 'product-docs', true],
      ['DOCS', 'truncated-docs', true],
      ['DOCS_ROOT', 'guides', true],
    ]);
    expect(list.find((item) => item.folder === 'team-rules')).toMatchObject({
      name: '团队规范',
      description: '规范库',
      documentCount: 2,
    });
    const docsRoot = list.find((item) => item.folder === 'guides') as { id: string; source: string };
    expect(docsRoot.source).toBe('DOCS_ROOT');
    expect(docsRoot.id).toContain(':docs-root:');

    await gql(REPO_KNOWLEDGE_BASES, { workspaceId }, user.token);
    expect(fake.scans.length).toBe(afterFirst);

    await gql(REPO_KNOWLEDGE_BASES, { workspaceId, refresh: true }, user.token);
    expect(fake.scans.length).toBeGreaterThan(afterFirst);
  });

  it('T-RKB3-API1 docs-root 知识库 children/document 正常派生', async () => {
    const listData = await gql(REPO_KNOWLEDGE_BASES, { workspaceId }, user.token);
    const kb = (listData.repoKnowledgeBases as Array<Record<string, unknown>>).find(
      (item) => item.folder === 'guides',
    ) as { id: string };

    const root = await gql(REPO_KB_CHILDREN, { id: kb.id }, user.token);
    expect(root.repoKnowledgeBaseDocumentChildren).toEqual([
      { kind: 'FOLDER', name: 'api', path: '/api', error: null },
    ]);

    const deep = await gql(REPO_KB_CHILDREN, { id: kb.id, path: '/api' }, user.token);
    expect(deep.repoKnowledgeBaseDocumentChildren).toEqual([
      { kind: 'DOCUMENT', name: 'rest', path: '/api/rest', error: null },
    ]);

    const doc = await gql(REPO_KB_DOCUMENT, { id: kb.id, path: '/api/rest' }, user.token);
    expect(doc.repoKnowledgeBaseDocument).toMatchObject({ path: '/api/rest', content: '# REST' });
  });

  it('T-RKB3-API2 旧版组件仅两来源回包 → DOCS_ROOT 不出现、零报错', async () => {
    const data = await gql(REPO_KNOWLEDGE_BASES, { workspaceId: legacyWorkspaceId }, user.token);
    const list = data.repoKnowledgeBases as Array<{ source: string }>;
    expect(list.map((item) => item.source)).toEqual(['ZAG', 'ZAG', 'ZAG', 'DOCS', 'DOCS']);
    expect(list.some((item) => item.source === 'DOCS_ROOT')).toBe(false);
    expect(legacyFake.scans.length).toBe(1);
    expect(legacyHostId).not.toBe('');
  });

  it('T-RKB-API4 children 逐级派生（FOLDER 在前）；document 返回含 front matter 原文；不可达收敛', async () => {
    const listData = await gql(REPO_KNOWLEDGE_BASES, { workspaceId }, user.token);
    const kb = (listData.repoKnowledgeBases as Array<Record<string, unknown>>).find(
      (item) => item.folder === 'team-rules',
    ) as { id: string };

    const root = await gql(REPO_KB_CHILDREN, { id: kb.id }, user.token);
    expect(root.repoKnowledgeBaseDocumentChildren).toEqual([
      { kind: 'FOLDER', name: 'guides', path: '/guides', error: null },
      { kind: 'DOCUMENT', name: '上手', path: '/onboarding', error: null },
    ]);

    const deep = await gql(REPO_KB_CHILDREN, { id: kb.id, path: '/guides' }, user.token);
    expect(deep.repoKnowledgeBaseDocumentChildren).toEqual([
      { kind: 'DOCUMENT', name: 'Git 规范', path: '/guides/git', error: null },
    ]);

    const doc = await gql(REPO_KB_DOCUMENT, { id: kb.id, path: '/guides/git' }, user.token);
    expect(doc.repoKnowledgeBaseDocument).toMatchObject({ path: '/guides/git', title: 'Git 规范' });
    expect(doc.repoKnowledgeBaseDocument.content).toContain('custom: 自定义');

    const missingDoc = await gql(REPO_KB_DOCUMENT, { id: kb.id, path: '/nope' }, user.token);
    expect(missingDoc.repoKnowledgeBaseDocument).toBeNull();
    const missingChildren = await gql(
      REPO_KB_CHILDREN,
      { id: 'repo:ws-1:zag:missing', path: '/' },
      user.token,
    );
    expect(missingChildren.repoKnowledgeBaseDocumentChildren).toEqual([]);
  });

  it('T-RKB2-API1 超过旧总额上限的 fixture 全量返回、truncated:false', async () => {
    const listData = await gql(REPO_KNOWLEDGE_BASES, { workspaceId }, user.token);
    const large = (listData.repoKnowledgeBases as Array<Record<string, unknown>>).find(
      (item) => item.folder === 'large',
    ) as { id: string; documentCount: number; truncated: boolean };

    expect(large.documentCount).toBe(LARGE_DOC_COUNT);
    expect(large.truncated).toBe(false);

    const children = await gql(REPO_KB_CHILDREN, { id: large.id }, user.token);
    const nodes = children.repoKnowledgeBaseDocumentChildren as Array<Record<string, unknown>>;
    expect(nodes).toHaveLength(LARGE_DOC_COUNT);
    expect(nodes.every((node) => node.kind === 'DOCUMENT' && node.error == null)).toBe(true);

    const doc = await gql(REPO_KB_DOCUMENT, { id: large.id, path: '/d00' }, user.token);
    expect(doc.repoKnowledgeBaseDocument.content).toHaveLength(LARGE_DOC_CHUNK.length);
  });

  it('T-RKB2-API2 children 返回 error；documentCount 不含错误文档；错误文档 document 为 null', async () => {
    const listData = await gql(REPO_KNOWLEDGE_BASES, { workspaceId }, user.token);
    const kb = (listData.repoKnowledgeBases as Array<Record<string, unknown>>).find(
      (item) => item.folder === 'product-docs',
    ) as { id: string; documentCount: number; valid: boolean };

    expect(kb.valid).toBe(true);
    expect(kb.documentCount).toBe(0);

    const children = await gql(REPO_KB_CHILDREN, { id: kb.id }, user.token);
    expect(children.repoKnowledgeBaseDocumentChildren).toEqual([
      { kind: 'DOCUMENT', name: 'big', path: '/big', error: 'file too large' },
    ]);

    const doc = await gql(REPO_KB_DOCUMENT, { id: kb.id, path: '/big' }, user.token);
    expect(doc.repoKnowledgeBaseDocument).toBeNull();
  });

  it('T-RKB2-API3 截断 fixture 在列表与 children 上口径一致，不报错', async () => {
    const listData = await gql(REPO_KNOWLEDGE_BASES, { workspaceId }, user.token);
    const kb = (listData.repoKnowledgeBases as Array<Record<string, unknown>>).find(
      (item) => item.folder === 'truncated-docs',
    ) as { id: string; truncated: boolean; valid: boolean; errors: string[] };

    expect(kb.valid).toBe(true);
    expect(kb.errors).toEqual([]);
    expect(kb.truncated).toBe(true);

    const children = await gql(REPO_KB_CHILDREN, { id: kb.id }, user.token);
    expect(children.repoKnowledgeBaseDocumentChildren).toEqual([
      { kind: 'DOCUMENT', name: 'X', path: '/x', error: null },
    ]);
    const doc = await gql(REPO_KB_DOCUMENT, { id: kb.id, path: '/x' }, user.token);
    expect(doc.repoKnowledgeBaseDocument).toMatchObject({ path: '/x', content: '# X' });
  });

  it('T-RKB-API5 错误口径：不可见工作区 Workspace not found；版本不足/控制器离线 scan failed', async () => {
    const res = await gqlRequest(REPO_KNOWLEDGE_BASES, { workspaceId: new mongoose.Types.ObjectId().toString() }, user.token);
    const body = await res.json();
    expect(body.errors?.[0]?.message).toBe('Workspace not found');

    const oldRes = await gqlRequest(REPO_KNOWLEDGE_BASES, { workspaceId: oldWorkspaceId }, user.token);
    const oldBody = await oldRes.json();
    expect(oldBody.errors?.[0]?.message).toBe('repo knowledge base scan failed');
    expect(oldFake.scans).toHaveLength(0);

    // 控制器离线：同一 RUNNING 云电脑的控制器置 offline → 同文案（超时分支由服务层单测 T-RKB-SVC10 覆盖）
    const db = await mongoDb();
    await db.collection('controllers').updateOne(
      { _id: new mongoose.Types.ObjectId(fake.controllerId) },
      { $set: { status: 'offline' } },
    );
    try {
      const offlineRes = await gqlRequest(REPO_KNOWLEDGE_BASES, { workspaceId }, user.token);
      const offlineBody = await offlineRes.json();
      expect(offlineBody.errors?.[0]?.message).toBe('repo knowledge base scan failed');
    } finally {
      await db.collection('controllers').updateOne(
        { _id: new mongoose.Types.ObjectId(fake.controllerId) },
        { $set: { status: 'online' } },
      );
    }
  });

  it('T-RKB-API8 云电脑转 STOPPED：hosts 不再列出；children/document 收敛 []/null', async () => {
    const listData = await gql(REPO_KNOWLEDGE_BASES, { workspaceId }, user.token);
    const kb = (listData.repoKnowledgeBases as Array<Record<string, unknown>>).find(
      (item) => item.folder === 'team-rules',
    ) as { id: string };

    const db = await mongoDb();
    await db.collection('cloudhosts').updateOne(
      { _id: new mongoose.Types.ObjectId(hostId) },
      { $set: { status: 'STOPPED' } },
    );
    try {
      const hostsData = await gql(REPO_KNOWLEDGE_BASE_HOSTS, undefined, user.token);
      expect(
        (hostsData.repoKnowledgeBaseHosts as Array<{ cloudHostId: string }>).some(
          (host) => host.cloudHostId === hostId,
        ),
      ).toBe(false);

      const children = await gql(REPO_KB_CHILDREN, { id: kb.id }, user.token);
      expect(children.repoKnowledgeBaseDocumentChildren).toEqual([]);
      const doc = await gql(REPO_KB_DOCUMENT, { id: kb.id, path: '/guides/git' }, user.token);
      expect(doc.repoKnowledgeBaseDocument).toBeNull();
    } finally {
      await db.collection('cloudhosts').updateOne(
        { _id: new mongoose.Types.ObjectId(hostId) },
        { $set: { status: 'RUNNING' } },
      );
    }
  });
});

describe('知识库 MCP prompts API（T-RKB-API6）', () => {
  let user: FrontUser;
  let fake: FakeController;
  let sessionId = '';
  let mcpToken = '';

  function relayMcpRequest(requestId: string, body: Record<string, unknown>) {
    return new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP relay timeout: ${requestId}`)), 15000);
      const onResponse = (data: { requestId: string; status: number; body: Record<string, any> }) => {
        if (data.requestId !== requestId) return;
        clearTimeout(timer);
        fake.client.off('mcp:response', onResponse);
        resolve(data);
      };
      fake.client.on('mcp:response', onResponse);
      fake.client.emit('mcp:request', {
        requestId,
        sessionId,
        serverName: 'agent-knowledge-base-tools',
        token: mcpToken,
        body,
      });
    });
  }

  beforeAll(async () => {
    user = await createFrontUser();
    fake = await registerFakeController(user.token, 'mcp');
    const workspaceId = await createWorkspace(user.token, fake.controllerId);
    const servers = await gql(GET_MCP_SERVERS, undefined, user.token);
    const kbTools = (servers.mcpServers as Array<{ id: string; name: string }>).find(
      (server) => server.name === 'agent-knowledge-base-tools',
    );
    expect(kbTools).toBeDefined();

    const startEvent = waitForEvent<Record<string, any>>(fake.client, 'acp:start');
    const data = await gql(
      CREATE_SESSION,
      {
        input: {
          controllerId: fake.controllerId,
          acpServerType: 'opencode',
          workspaceId,
          mcpServerIds: [kbTools!.id],
        },
      },
      user.token,
    );
    sessionId = data.createSession.session.id;
    const start = await startEvent;
    expect(start.mcpEndpoint?.serverNames).toContain('agent-knowledge-base-tools');
    mcpToken = start.mcpEndpoint.token;
    fake.client.emit('acp:start:result', {
      requestId: start.requestId,
      sessionId,
      success: true,
      externalSessionId: `ext_rkb_${Date.now()}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }, 60_000);

  afterAll(async () => {
    if (sessionId) await gqlRequest(DELETE_SESSION, { id: sessionId }, user.token);
    fake?.client.disconnect();
  }, 60_000);

  it('T-RKB-API6 initialize 含 prompts；prompts/list 单片段；六工具不含仓库知识库', async () => {
    const init = await relayMcpRequest('rkb_init', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    });
    expect(init.body.result.capabilities.prompts).toBeDefined();

    const list = await relayMcpRequest('rkb_list', {
      jsonrpc: '2.0',
      id: 2,
      method: 'prompts/list',
    });
    expect(list.body.result.prompts).toHaveLength(1);
    expect(list.body.result.prompts[0].name).toBe('repo-knowledge-base-authoring');

    const got = await relayMcpRequest('rkb_get', {
      jsonrpc: '2.0',
      id: 3,
      method: 'prompts/get',
      params: { name: 'repo-knowledge-base-authoring' },
    });
    expect(got.body.result.messages[0].content.text).toContain('.zag/knowledges/');

    const tools = await relayMcpRequest('rkb_tools', {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
    });
    const names = (tools.body.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toHaveLength(6);
    expect(names.some((name) => name.toLowerCase().includes('repo'))).toBe(false);
  });
});
