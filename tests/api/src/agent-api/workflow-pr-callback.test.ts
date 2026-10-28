import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';
import mongoose from 'mongoose';
import { createHmac } from 'node:crypto';
import { createFrontUser } from '../support/front-users.js';

/**
 * 工作流 GitHub Pull Request 联动 —— 黑盒用例 T-PR1 ~ T-PR18。
 *
 * 前置：`aspire start`（agent-api + controller-api + agent-web 依赖服务），
 * 并配置 `EVENT_CALLBACK_TOKEN`；缺失时整套跳过。
 * fake controller 经主 WebSocket 自动应答 acp:start/acp:resume，并记录节点作用域 token。
 */
const AGENT_API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273';
const API_BASE = AGENT_API_URL.replace(/\/graphql$/, '');
const CALLBACK_URL = `${API_BASE}/api/events/callback`;
const EVENT_TOKEN = process.env.EVENT_CALLBACK_TOKEN ?? '';
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? '';
function gqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const body: Record<string, unknown> = { query };
  if (variables) body.variables = variables;
  return fetch(AGENT_API_URL, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function gql<T = Record<string, any>>(
  query: string,
  variables: Record<string, unknown> | undefined,
  token: string,
): Promise<T> {
  const res = await gqlRequest(query, variables, token);
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data as T;
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

const REFRESH_ACP_CAPABILITIES = `
  mutation RefreshAcpCapabilities($controllerId: ID!) {
    refreshAcpCapabilities(controllerId: $controllerId) { type available }
  }
`;

const CREATE_WORKFLOW_TEMPLATE = `
  mutation CreateWorkflowTemplate($input: WorkflowTemplateInput!) {
    createWorkflowTemplate(input: $input) {
      id name version
      nodes { nodeKey type name stage prompts artifactTitles dependsOn requiresWorktree linkUpstreamPullRequest }
    }
  }
`;

const WORKFLOW_TEMPLATES_QUERY = `
  query WorkflowTemplates {
    workflowTemplates {
      id name
      nodes { nodeKey type name linkUpstreamPullRequest }
    }
  }
`;

const CONFIGURE_WORKFLOW = `
  mutation ConfigureWorkflow($templateId: ID!, $input: ConfigureWorkflowInput!) {
    configureWorkflow(templateId: $templateId, input: $input) {
      id name
      nodes { nodeKey type name linkUpstreamPullRequest agentConfig { acpServerType } }
    }
  }
`;

const CONFIGURED_WORKFLOW_QUERY = `
  query ConfiguredWorkflow($id: ID!) {
    configuredWorkflow(id: $id) {
      id name
      nodes { nodeKey type name linkUpstreamPullRequest }
    }
  }
`;

const INSTANTIATE_WORKFLOW = `
  mutation InstantiateWorkflow($input: InstantiateWorkflowInput!) {
    instantiateWorkflow(input: $input) {
      id name archived
      nodes { id nodeKey type name status sessionId linkUpstreamPullRequest }
    }
  }
`;

const WORKFLOW_INSTANCE_QUERY = `
  query WorkflowInstance($id: ID!) {
    workflowInstance(id: $id) {
      id name archived currentNodeNames lastNodeName lastNodeStatus
      additionalPrompts { key value }
      pullRequestLinks { pullRequestId prUrl nodeId nodeName registeredAt }
      nodes {
        id nodeKey type name status sessionId startedAt reworkedAt reworkCount
        linkUpstreamPullRequest
        rejectInfo { reason fromNodeId at }
      }
      blackboard { key value }
    }
  }
`;

const UPDATE_WORKFLOW_NODE = `
  mutation UpdateWorkflowNode($instanceId: ID!, $nodeId: ID!, $input: WorkflowNodeUpdateInput!) {
    updateWorkflowNode(instanceId: $instanceId, nodeId: $nodeId, input: $input) {
      id nodeKey type name status linkUpstreamPullRequest
    }
  }
`;

const COMPLETE_HUMAN_NODE = `
  mutation CompleteHumanNode($instanceId: ID!, $nodeId: ID!, $input: String) {
    completeHumanNode(instanceId: $instanceId, nodeId: $nodeId, input: $input) {
      id nodeKey name status
    }
  }
`;

const REJECT_NODE = `
  mutation RejectNode($instanceId: ID!, $nodeId: ID!, $reason: String!) {
    rejectNode(instanceId: $instanceId, nodeId: $nodeId, reason: $reason) {
      id nodeKey name status rejectInfo { reason }
    }
  }
`;

const ARCHIVE_INSTANCE = `
  mutation ArchiveWorkflowInstance($id: ID!, $archived: Boolean!) {
    archiveWorkflowInstance(id: $id, archived: $archived)
  }
`;

const SESSION_MESSAGES_QUERY = `
  query SessionMessages($sessionId: ID!, $limit: Int) {
    sessionMessages(sessionId: $sessionId, limit: $limit) {
      id direction type content createdAt
    }
  }
`;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function newUserToken(tag: string): Promise<string> {
  const { token } = await createFrontUser();
  return token;
}

function createClient(): ClientSocket {
  return SocketIOClient(CONTROLLER_API_URL, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
}

interface StartEvent {
  requestId: string;
  sessionId: string;
  serverType: string;
  mcpEndpoint?: { token: string; serverNames: string[] };
}

interface FakeController {
  client: ClientSocket;
  controllerId: string;
  rawKey: string;
  starts: StartEvent[];
}

const FAKE_CONTROLLER_HOME = '/home/fake';

async function registerFakeController(token: string, tag: string): Promise<FakeController> {
  const keyData = await gql<{ createControllerKey: { rawKey: string } }>(
    CREATE_KEY,
    { input: { name: `pr-${tag}-${Date.now()}`, type: 'local' } },
    token,
  );
  const rawKey = keyData.createControllerKey.rawKey;
  const client = createClient();
  const starts: StartEvent[] = [];

  client.on('acp:check', (data: { requestId: string }) => {
    client.emit('acp:check:result', {
      requestId: data.requestId,
      servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
    });
  });
  client.on('acp:stop', (data: { sessionId: string }) => {
    client.emit('acp:stopped', { sessionId: data.sessionId, reason: 'user_close' });
  });
  // 自动 ack 节点会话启动；记录节点作用域 token
  client.on('acp:start', (data: StartEvent) => {
    starts.push(data);
    setTimeout(() => {
      client.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
        externalSessionId: `ext_${data.sessionId}`,
      });
    }, 10);
  });
  client.on('acp:resume', (data: { requestId: string; sessionId: string }) => {
    setTimeout(() => {
      client.emit('acp:resume:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
      });
    }, 10);
  });

  const registered = new Promise<{ controllerId: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('controller register timeout')), 10000);
    client.once('registered', (data: { controllerId: string }) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
  client.emit('register', {
    key: rawKey,
    hostname: `pr-${tag}-host`,
    version: '2.0.0',
    homeDir: FAKE_CONTROLLER_HOME,
    platform: 'linux',
  });
  const reg = await registered;
  return { client, controllerId: reg.controllerId, rawKey, starts };
}

async function refreshCapabilities(token: string, controllerId: string): Promise<void> {
  const data = await gql<{ refreshAcpCapabilities: { type: string; available: boolean }[] }>(
    REFRESH_ACP_CAPABILITIES,
    { controllerId },
    token,
  );
  expect(data.refreshAcpCapabilities.some((s) => s.type === 'opencode' && s.available)).toBe(true);
}

async function createWorkspace(token: string, controllerId: string): Promise<string> {
  const path = `/tmp/wf-pr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const data = await gql<{ createWorkspace: { id: string } }>(
    CREATE_WORKSPACE,
    { input: { controllerId, path } },
    token,
  );
  return data.createWorkspace.id;
}

interface NodeSpec {
  nodeKey: string;
  type: 'HUMAN' | 'AI' | 'FLAG';
  name: string;
  stage: string;
  dependsOn: string[];
  requiresWorktree: boolean;
  prompts?: string[];
  artifactTitles?: string[];
  linkUpstreamPullRequest?: boolean;
}

function human(nodeKey: string, name: string, dependsOn: string[], link = false): NodeSpec {
  return {
    nodeKey,
    type: 'HUMAN',
    name,
    stage: '阶段',
    dependsOn,
    requiresWorktree: false,
    linkUpstreamPullRequest: link,
  };
}

function ai(nodeKey: string, name: string, dependsOn: string[]): NodeSpec {
  return {
    nodeKey,
    type: 'AI',
    name,
    stage: '阶段',
    dependsOn,
    requiresWorktree: false,
    prompts: [`${name}：读取上游产物并完成工作`],
    artifactTitles: [`${name}产物`],
  };
}

/** 标准链路：input(HUMAN) → exec(AI) → review(HUMAN, link) → after(AI) */
function baseGraph(reviewLink = true): NodeSpec[] {
  return [
    human('input', '需求输入', []),
    ai('exec', '代码执行', ['input']),
    human('review', '代码审核', ['exec'], reviewLink),
    ai('after', '后续执行', ['review']),
  ];
}

function configureNodes(nodes: NodeSpec[]) {
  return nodes.map((n) => ({
    nodeKey: n.nodeKey,
    type: n.type,
    name: n.name,
    stage: n.stage,
    prompts: n.prompts,
    artifactTitles: n.artifactTitles,
    dependsOn: n.dependsOn,
    requiresWorktree: n.requiresWorktree,
    linkUpstreamPullRequest: n.linkUpstreamPullRequest ?? false,
    agentConfig:
      n.type === 'AI'
        ? { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: false }
        : null,
  }));
}

interface Ctx {
  token: string;
  fake: FakeController;
  workspaceId: string;
  templateId: string;
  configuredId: string;
  instanceId: string;
  instance: any;
}

async function createCtx(
  token: string,
  fake: FakeController,
  nodes: NodeSpec[],
  tag: string,
  sharedWorkspaceId?: string,
): Promise<Ctx> {
  const templateData = await gql<{ createWorkflowTemplate: { id: string } }>(
    CREATE_WORKFLOW_TEMPLATE,
    { input: { name: `${tag}-${Date.now()}`, description: tag, nodes } },
    token,
  );
  const templateId = templateData.createWorkflowTemplate.id;
  const workspaceId = sharedWorkspaceId ?? (await createWorkspace(token, fake.controllerId));
  const configuredData = await gql<{ configureWorkflow: { id: string } }>(
    CONFIGURE_WORKFLOW,
    {
      templateId,
      input: {
        name: `${tag}-cfg-${Date.now()}`,
        controllerId: fake.controllerId,
        nodes: configureNodes(nodes),
      },
    },
    token,
  );
  const configuredId = configuredData.configureWorkflow.id;
  const instData = await gql<{ instantiateWorkflow: any }>(
    INSTANTIATE_WORKFLOW,
    {
      input: {
        source: 'CONFIGURED',
        configuredWorkflowId: configuredId,
        controllerId: fake.controllerId,
        workspaceId,
        name: `${tag}-inst-${Date.now()}`,
        nodes: configureNodes(nodes),
      },
    },
    token,
  );
  return {
    token,
    fake,
    workspaceId,
    templateId,
    configuredId,
    instanceId: instData.instantiateWorkflow.id,
    instance: instData.instantiateWorkflow,
  };
}

async function refreshInstance(ctx: Ctx): Promise<any> {
  const data = await gql<{ workflowInstance: any }>(
    WORKFLOW_INSTANCE_QUERY,
    { id: ctx.instanceId },
    ctx.token,
  );
  ctx.instance = data.workflowInstance;
  return ctx.instance;
}

function nodeOf(instance: any, nodeKey: string): any {
  const node = instance.nodes.find((n: any) => n.nodeKey === nodeKey);
  if (!node) throw new Error(`node not found: ${nodeKey}`);
  return node;
}

async function waitForStatus(ctx: Ctx, nodeKey: string, status: string): Promise<any> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const inst = await refreshInstance(ctx);
    const node = nodeOf(inst, nodeKey);
    if (node.status === status) return node;
    await sleep(100);
  }
  throw new Error(`timeout waiting ${nodeKey}=${status}, current=${nodeOf(ctx.instance, nodeKey).status}`);
}

async function waitForStart(ctx: Ctx, nodeKey: string): Promise<StartEvent> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const inst = await refreshInstance(ctx);
    const node = nodeOf(inst, nodeKey);
    if (node.sessionId) {
      const event = ctx.fake.starts.find((s) => s.sessionId === node.sessionId);
      if (event?.mcpEndpoint?.token) return event;
    }
    await sleep(100);
  }
  throw new Error(`timeout waiting acp:start for ${nodeKey}`);
}

async function completeHuman(ctx: Ctx, nodeKey: string, input = '人类输入'): Promise<void> {
  const node = nodeOf(await refreshInstance(ctx), nodeKey);
  await gql(COMPLETE_HUMAN_NODE, { instanceId: ctx.instanceId, nodeId: node.id, input }, ctx.token);
}

async function callTool(
  ctx: Ctx,
  sessionId: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; data: Record<string, any> }> {
  const requestId = `mcpreq_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const response = await new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP relay timeout: ${name}`)), 15000);
    const onResponse = (data: { requestId: string; status: number; body: Record<string, any> }) => {
      if (data.requestId !== requestId) return;
      clearTimeout(timer);
      ctx.fake.client.off('mcp:response', onResponse);
      resolve(data);
    };
    ctx.fake.client.on('mcp:response', onResponse);
    ctx.fake.client.emit('mcp:request', {
      requestId,
      sessionId,
      serverName: 'agent-workflow-tools',
      token,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    });
  });
  const result = response.body.result;
  expect(response.body.error).toBeUndefined();
  expect(result?.content?.[0]?.text).toBeDefined();
  return { isError: Boolean(result.isError), data: JSON.parse(result.content[0].text) };
}

/** 启动 exec 节点并以节点作用域 token 关联 PR */
async function startExecAndLink(ctx: Ctx, pullRequestId: string): Promise<{ sessionId: string; token: string }> {
  const before = ctx.fake.starts.length;
  await completeHuman(ctx, 'input', '实现 GitHub PR 联动');
  await waitForStatus(ctx, 'exec', 'RUNNING');
  const start = await waitForStart(ctx, 'exec');
  expect(ctx.fake.starts.length).toBeGreaterThan(before);
  const sessionId = start.sessionId;
  const token = start.mcpEndpoint!.token;
  const linked = await callTool(ctx, sessionId, token, 'linkPullRequest', { pullRequestId });
  expect(linked.isError).toBe(false);
  expect(linked.data.registered).toBe(true);
  return { sessionId, token };
}

/** exec 完成后当前人类节点进入 RUNNING；返回本次使用的 PR（缺省自动生成唯一编号） */
async function activateReview(ctx: Ctx, linkPr?: string) {
  const pr = linkPr ?? nextPr();
  const exec = await startExecAndLink(ctx, pr);
  await callTool(ctx, exec.sessionId, exec.token, 'completeCurrentNode', {
    artifacts: [{ title: '代码执行产物', value: '实现完成' }],
  });
  await waitForStatus(ctx, 'review', 'RUNNING');
  return { ...exec, pr };
}

function eventBody(
  pullRequestId: string,
  reviewState: string,
  overrides: Record<string, unknown> = {},
) {
  const number = pullRequestId.split('#')[1] ?? '264';
  return {
    eventType: 'pull_request',
    eventId: `gh:test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    payload: {
      pullRequestId,
      prUrl: `https://github.com/Deliay/z-agent-gear/pull/${number}`,
      reviewState,
      comment: '请按 inline comment 调整后合并',
      reviewer: 'alice',
      submittedAt: '2026-10-23T06:00:00Z',
      ...overrides,
    },
  };
}

let prSeq = Number(String(Date.now()).slice(-6)) * 10;
function nextPr(): string {
  return `Deliay/z-agent-gear#${prSeq++}`;
}

async function postEvent(body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(CALLBACK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Event-Token': EVENT_TOKEN, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function messageTexts(messages: any[]): string {
  return messages
    .map((m) => {
      const c = m.content;
      if (typeof c === 'string') return c;
      if (c?.content?.text) return c.content.text;
      if (c?.text) return c.text;
      return JSON.stringify(c);
    })
    .join('\n---\n');
}

async function sessionMessages(ctx: Ctx, sessionId: string): Promise<any[]> {
  const data = await gql<{ sessionMessages: any[] }>(
    SESSION_MESSAGES_QUERY,
    { sessionId, limit: 100 },
    ctx.token,
  );
  return data.sessionMessages ?? [];
}

async function waitForMessage(ctx: Ctx, sessionId: string, needle: string): Promise<string> {
  const deadline = Date.now() + 10000;
  let text = '';
  while (Date.now() < deadline) {
    text = messageTexts(await sessionMessages(ctx, sessionId));
    if (text.includes(needle)) return text;
    await sleep(150);
  }
  throw new Error(`timeout waiting message "${needle}" in ${sessionId}. Got: ${text.slice(-500)}`);
}

// C-24：缺参即绿的 skipIf 需要 fail-fast 哨兵。CI 下未配置 token 且未显式 SKIP_PR_CALLBACK=1 时红。
describe('PR 回调环境哨兵', () => {
  it('CI 下 EVENT_CALLBACK_TOKEN 必须配置（SKIP_PR_CALLBACK=1 可显式跳过）', () => {
    if (process.env.SKIP_PR_CALLBACK === '1') return;
    if (!process.env.CI) return;
    expect(EVENT_TOKEN).toBeTruthy();
  });
});

describe.skipIf(!EVENT_TOKEN)('工作流 PR 事件回调（T-PR1~T-PR3）', () => {
  it('T-PR1 鉴权：无凭据/错误 token 401，正确 token 200', async () => {
    expect((await postEvent(eventBody('Deliay/z-agent-gear#999', 'approved'), { 'X-Event-Token': 'wrong-token' })).status).toBe(401);
    expect((await fetch(CALLBACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eventBody('Deliay/z-agent-gear#999', 'approved')),
    })).status).toBe(401);

    const ok = await postEvent(eventBody('Deliay/z-agent-gear#999', 'approved'));
    expect(ok.status).toBe(200);
    expect(typeof ok.body.handled).toBe('boolean');
    expect(Array.isArray(ok.body.results)).toBe(true);
  });

  it('T-PR1 Authorization Bearer 与 HMAC 验签', async () => {
    const bearer = await fetch(CALLBACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${EVENT_TOKEN}` },
      body: JSON.stringify(eventBody('Deliay/z-agent-gear#999', 'approved')),
    });
    expect(bearer.status).toBe(200);

    if (WEBHOOK_SECRET) {
      const raw = JSON.stringify(eventBody('Deliay/z-agent-gear#999', 'approved'));
      const signature = 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
      const signed = await fetch(CALLBACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
        body: raw,
      });
      expect(signed.status).toBe(200);
      const wrong = await fetch(CALLBACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=deadbeef' },
        body: raw,
      });
      expect(wrong.status).toBe(401);
    }
  });

  it('T-PR2 载荷非法 400 且带 detail', async () => {
    const missingEventId = await postEvent('{"eventType":"pull_request"}');
    expect(missingEventId.status).toBe(400);
    expect(missingEventId.body).toHaveProperty('detail');

    const wrongType = await postEvent({ ...eventBody('a/b#1', 'approved'), eventType: 'push' });
    expect(wrongType.status).toBe(400);

    const missingPr = await postEvent({
      ...eventBody('a/b#1', 'approved'),
      payload: { reviewState: 'approved' },
    });
    expect(missingPr.status).toBe(400);

    const missingState = await postEvent({
      ...eventBody('a/b#1', 'approved'),
      payload: { pullRequestId: 'a/b#1' },
    });
    expect(missingState.status).toBe(400);
  });

  it('T-PR3 未登记 PR 返回 NO_HANDLER', async () => {
    const result = await postEvent(eventBody('unknown-owner/unknown-repo#999999', 'approved'));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ handled: false, reason: 'NO_HANDLER', results: [] });
  });
});

describe.skipIf(!EVENT_TOKEN)('工作流 PR 联动（T-PR4~T-PR18）', () => {
  let token = '';
  let fake: FakeController;
  let workspaceId = '';
  const makeCtx = (nodes: NodeSpec[], tag: string) =>
    createCtx(token, fake, nodes, tag, workspaceId);

  beforeAll(async () => {
    token = await newUserToken('wfpr');
    expect(token).toBeTruthy();
    fake = await registerFakeController(token, 'pr');
    await refreshCapabilities(token, fake.controllerId);
    workspaceId = await createWorkspace(token, fake.controllerId);
    if (process.env.MONGODB_URI) {
      await mongoose.connect(process.env.MONGODB_URI);
    }
  }, 30_000);

  afterAll(async () => {
    fake?.client.disconnect();
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  it('T-PR4 linkPullRequest 注册后 GraphQL pullRequestLinks 可见', async () => {
    const ctx = await makeCtx(baseGraph(), 'tpr4');
    const pr = nextPr();
    const number = pr.split('#')[1];
    const exec = await startExecAndLink(ctx, `https://github.com/Deliay/z-agent-gear/pull/${number}`);
    const inst = await refreshInstance(ctx);
    const execNode = nodeOf(inst, 'exec');
    expect(inst.pullRequestLinks).toHaveLength(1);
    expect(inst.pullRequestLinks[0]).toMatchObject({
      pullRequestId: pr,
      prUrl: `https://github.com/Deliay/z-agent-gear/pull/${number}`,
      nodeId: execNode.id,
      nodeName: '代码执行',
    });

    const info = await callTool(ctx, exec.sessionId, exec.token, 'getNodeInfo', {});
    expect(info.data.workflowInstanceId).toBe(ctx.instanceId);
  }, 30_000);

  it('T-PR5 显式参数不一致/非法标识/已归档 → 工具错误', async () => {
    const ctx = await makeCtx(baseGraph(), 'tpr5');
    const pr = nextPr();
    const exec = await startExecAndLink(ctx, pr);

    const wrongWorkflow = await callTool(ctx, exec.sessionId, exec.token, 'linkPullRequest', {
      pullRequestId: pr,
      workflowId: 'other-instance',
    });
    expect(wrongWorkflow.isError).toBe(true);
    expect(wrongWorkflow.data.code).toBe('INVALID_PARAMS');

    const wrongNode = await callTool(ctx, exec.sessionId, exec.token, 'linkPullRequest', {
      pullRequestId: pr,
      nodeId: 'other-node',
    });
    expect(wrongNode.data.code).toBe('INVALID_PARAMS');

    const invalid = await callTool(ctx, exec.sessionId, exec.token, 'linkPullRequest', {
      pullRequestId: 'not-a-pr',
    });
    expect(invalid.data.code).toBe('INVALID_PARAMS');

    await gql(ARCHIVE_INSTANCE, { id: ctx.instanceId, archived: true }, token);
    const archived = await callTool(ctx, exec.sessionId, exec.token, 'linkPullRequest', {
      pullRequestId: nextPr(),
    });
    expect(archived.data.code).toBe('INVALID_STATE');
  }, 30_000);

  it('T-PR6 同节点更换 PR → 旧关联消失、新关联出现', async () => {
    const ctx = await makeCtx(baseGraph(), 'tpr6');
    const oldPr = nextPr();
    const newPr = nextPr();
    const exec = await startExecAndLink(ctx, oldPr);

    const replaced = await callTool(ctx, exec.sessionId, exec.token, 'linkPullRequest', {
      pullRequestId: newPr,
    });
    expect(replaced.isError).toBe(false);
    expect(replaced.data.pullRequestId).toBe(newPr);

    const inst = await refreshInstance(ctx);
    expect(inst.pullRequestLinks).toHaveLength(1);
    expect(inst.pullRequestLinks[0].pullRequestId).toBe(newPr);
  }, 30_000);

  it('T-PR7 approved → 人类节点 DONE，下游 AI 首条提示词含 A.2 文案', async () => {
    const ctx = await makeCtx(baseGraph(), 'tpr7');
    const { pr } = await activateReview(ctx);
    const number = pr.split('#')[1];

    const result = await postEvent(eventBody(pr, 'approved'));
    expect(result.status).toBe(200);
    expect(result.body.handled).toBe(true);
    expect(result.body.results[0]).toMatchObject({
      action: 'COMPLETE_HUMAN_NODE',
      promptKey: 'github-pr-review',
    });

    const review = await waitForStatus(ctx, 'review', 'DONE');
    expect(review.status).toBe('DONE');
    await waitForStatus(ctx, 'after', 'RUNNING');
    const afterStart = await waitForStart(ctx, 'after');

    const text = await waitForMessage(ctx, afterStart.sessionId, 'Pull Request审核通过');
    expect(text).toContain('请按 inline comment 调整后合并');
    expect(text).toContain(`https://github.com/Deliay/z-agent-gear/pull/${number}`);
    expect(text).toContain('审核人：alice');
    expect(text).toContain('审核时间：2026-10-23T06:00:00Z');

    const inst = await refreshInstance(ctx);
    const prompts = inst.additionalPrompts as { key: string; value: string }[];
    expect(prompts.filter((p) => p.key === 'github-pr-review')).toHaveLength(1);
  }, 40_000);

  it('T-PR8 rejected → 人类节点 REJECT、上游 REWORK，返工消息含 A.3 文案', async () => {
    const ctx = await makeCtx(baseGraph(), 'tpr8');
    const { pr, sessionId } = await activateReview(ctx);
    const number = pr.split('#')[1];

    const result = await postEvent(eventBody(pr, 'changes_requested'));
    expect(result.body.handled).toBe(true);
    expect(result.body.results[0].action).toBe('REJECT_HUMAN_NODE');

    const review = await waitForStatus(ctx, 'review', 'REJECT');
    expect(review.rejectInfo.reason).toContain('Pull Request审核被拒绝');
    const execNode = await waitForStatus(ctx, 'exec', 'REWORK');
    expect(execNode.reworkCount).toBe(1);

    const text = await waitForMessage(ctx, sessionId, 'Pull Request审核被拒绝');
    expect(text).toContain('注意检查pr的inline comment');
    expect(text).toContain(`https://github.com/Deliay/z-agent-gear/pull/${number}`);
  }, 40_000);

  it('T-PR9 重复投递同一 eventId → DUPLICATE_EVENT，节点状态不变', async () => {
    const ctx = await makeCtx(baseGraph(), 'tpr9');
    const { pr } = await activateReview(ctx);
    const body = eventBody(pr, 'approved');

    const first = await postEvent(body);
    expect(first.body.handled).toBe(true);
    await waitForStatus(ctx, 'review', 'DONE');
    await waitForStatus(ctx, 'after', 'RUNNING');

    const second = await postEvent(body);
    expect(second.body.handled).toBe(false);
    expect(second.body.results[0].reason).toBe('DUPLICATE_EVENT');

    const inst = await refreshInstance(ctx);
    expect(nodeOf(inst, 'review').status).toBe('DONE');
    expect(nodeOf(inst, 'after').status).toBe('RUNNING');
  }, 40_000);

  it('T-PR10 当前节点为 AI → CURRENT_NODE_NOT_HUMAN，状态不变', async () => {
    const ctx = await makeCtx(baseGraph(), 'tpr10');
    const pr = nextPr();
    await startExecAndLink(ctx, pr);

    const result = await postEvent(eventBody(pr, 'approved'));
    expect(result.body.handled).toBe(false);
    expect(result.body.results[0]).toMatchObject({
      reason: 'CURRENT_NODE_NOT_HUMAN',
      registeredNodeId: nodeOf(await refreshInstance(ctx), 'exec').id,
    });

    const inst = await refreshInstance(ctx);
    expect(nodeOf(inst, 'exec').status).toBe('RUNNING');
    expect(nodeOf(inst, 'review').status).toBe('INITIALIZING');
  }, 30_000);

  it('T-PR10b 人工 rejectNode 可打回 AI 节点（裁决 17 锁定）', async () => {
    const ctx = await makeCtx(baseGraph(), 'tpr10b');
    await completeHuman(ctx, 'input', '人工打回 AI');
    const exec = await waitForStatus(ctx, 'exec', 'RUNNING');

    const data = await gql<{ rejectNode: any }>(
      REJECT_NODE,
      { instanceId: ctx.instanceId, nodeId: exec.id, reason: '人工打回 AI 保持既有语义' },
      token,
    );
    expect(data.rejectNode.status).toBe('REJECT');
    expect(data.rejectNode.rejectInfo.reason).toBe('人工打回 AI 保持既有语义');
  }, 30_000);

  it('T-PR11 中间隔一个 HUMAN → HUMAN_NODE_IN_BETWEEN', async () => {
    const nodes: NodeSpec[] = [
      human('input', '需求输入', []),
      ai('exec', '代码执行', ['input']),
      human('mid', '人工确认', ['exec']),
      human('review', '代码审核', ['mid'], true),
      ai('after', '后续执行', ['review']),
    ];
    const ctx = await makeCtx(nodes, 'tpr11');
    const pr = nextPr();
    const exec = await startExecAndLink(ctx, pr);
    await callTool(ctx, exec.sessionId, exec.token, 'completeCurrentNode', {
      artifacts: [{ title: '代码执行产物', value: 'done' }],
    });
    await waitForStatus(ctx, 'mid', 'RUNNING');
    await completeHuman(ctx, 'mid', '确认通过');
    await waitForStatus(ctx, 'review', 'RUNNING');

    const result = await postEvent(eventBody(pr, 'approved'));
    expect(result.body.results[0].reason).toBe('HUMAN_NODE_IN_BETWEEN');
    expect(nodeOf(await refreshInstance(ctx), 'review').status).toBe('RUNNING');
  }, 40_000);

  it('T-PR12 当前节点多个（并行分支）→ CURRENT_NODE_AMBIGUOUS', async () => {
    const nodes: NodeSpec[] = [
      human('input', '需求输入', []),
      ai('exec', '代码执行', ['input']),
      human('a', '并行A', ['exec']),
      human('b', '并行B', ['exec']),
    ];
    const ctx = await makeCtx(nodes, 'tpr12');
    const pr = nextPr();
    const exec = await startExecAndLink(ctx, pr);
    await callTool(ctx, exec.sessionId, exec.token, 'completeCurrentNode', {
      artifacts: [{ title: '代码执行产物', value: 'done' }],
    });
    await waitForStatus(ctx, 'a', 'RUNNING');
    await waitForStatus(ctx, 'b', 'RUNNING');

    const result = await postEvent(eventBody(pr, 'approved'));
    expect(result.body.results[0].reason).toBe('CURRENT_NODE_AMBIGUOUS');
  }, 40_000);

  it('T-PR13 归档 → 关联清空 + NO_HANDLER；完成后关联注销', async () => {
    const archivedCtx = await makeCtx(baseGraph(), 'tpr13a');
    const { pr: archivedPr } = await activateReview(archivedCtx);
    await gql(ARCHIVE_INSTANCE, { id: archivedCtx.instanceId, archived: true }, token);
    let inst = await refreshInstance(archivedCtx);
    expect(inst.archived).toBe(true);
    expect(inst.pullRequestLinks).toEqual([]);
    const archivedResult = await postEvent(eventBody(archivedPr, 'approved'));
    expect(archivedResult.body.handled).toBe(false);
    expect(archivedResult.body.reason).toBe('NO_HANDLER');
    expect(nodeOf(await refreshInstance(archivedCtx), 'review').status).toBe('RUNNING');

    const finishedCtx = await makeCtx(baseGraph(), 'tpr13b');
    const { pr: finishedPr } = await activateReview(finishedCtx);
    const approved = await postEvent(eventBody(finishedPr, 'approved'));
    expect(approved.body.handled).toBe(true);
    await waitForStatus(finishedCtx, 'after', 'RUNNING');
    const afterStart = await waitForStart(finishedCtx, 'after');
    const done = await callTool(finishedCtx, afterStart.sessionId, afterStart.mcpEndpoint!.token, 'completeCurrentNode', {
      artifacts: [{ title: '后续执行产物', value: 'done' }],
    });
    expect(done.isError).toBe(false);

    inst = await refreshInstance(finishedCtx);
    expect(inst.pullRequestLinks).toEqual([]);
    const finishedResult = await postEvent(eventBody(finishedPr, 'approved'));
    expect(finishedResult.body.handled).toBe(false);
    // 完成后 hook 已注销全部关联：事件入口应为 NO_HANDLER（精确值，不用 allowlist）
    expect(finishedResult.body.reason).toBe('NO_HANDLER');
  }, 60_000);

  it('T-PR14 github-pr 注入/移除：未勾选无、勾选出现一次、全部取消移除', async () => {
    const ctx = await makeCtx(baseGraph(false), 'tpr14');
    let inst = await refreshInstance(ctx);
    expect(inst.additionalPrompts).toEqual([]);

    await completeHuman(ctx, 'input', '无联动');
    await waitForStatus(ctx, 'exec', 'RUNNING');
    const execStart = await waitForStart(ctx, 'exec');
    let text = await waitForMessage(ctx, execStart.sessionId, '无联动');
    expect(text).not.toContain('## GitHub Pull Request 联动');

    const reviewNode = nodeOf(inst, 'review');
    await gql(
      UPDATE_WORKFLOW_NODE,
      { instanceId: ctx.instanceId, nodeId: reviewNode.id, input: { linkUpstreamPullRequest: true } },
      token,
    );
    inst = await refreshInstance(ctx);
    const prompts = inst.additionalPrompts as { key: string; value: string }[];
    expect(prompts.filter((p) => p.key === 'github-pr')).toHaveLength(1);
    expect(prompts.find((p) => p.key === 'github-pr')!.value.match(/## GitHub Pull Request 联动/g)).toHaveLength(1);

    await gql(
      UPDATE_WORKFLOW_NODE,
      { instanceId: ctx.instanceId, nodeId: reviewNode.id, input: { linkUpstreamPullRequest: false } },
      token,
    );
    inst = await refreshInstance(ctx);
    expect(inst.additionalPrompts.some((p: any) => p.key === 'github-pr')).toBe(false);
  }, 40_000);

  it('T-PR15 三层透传（模板→配置→实例→updateNode），AI 节点传 true 被拒', async () => {
    const ctx = await makeCtx(baseGraph(true), 'tpr15');
    let inst = await refreshInstance(ctx);
    expect(nodeOf(inst, 'review').linkUpstreamPullRequest).toBe(true);

    const templates = await gql<{ workflowTemplates: any[] }>(WORKFLOW_TEMPLATES_QUERY, undefined, token);
    const tpl = templates.workflowTemplates.find((t) => t.id === ctx.templateId);
    expect(tpl.nodes.find((n: any) => n.nodeKey === 'review').linkUpstreamPullRequest).toBe(true);

    const configured = await gql<{ configuredWorkflow: any }>(
      CONFIGURED_WORKFLOW_QUERY,
      { id: ctx.configuredId },
      token,
    );
    expect(configured.configuredWorkflow.nodes.find((n: any) => n.nodeKey === 'review').linkUpstreamPullRequest).toBe(true);

    const reviewNode = nodeOf(inst, 'review');
    const updated = await gql( UPDATE_WORKFLOW_NODE, {
      instanceId: ctx.instanceId,
      nodeId: reviewNode.id,
      input: { linkUpstreamPullRequest: false },
    }, token);
    expect(updated.updateWorkflowNode.linkUpstreamPullRequest).toBe(false);

    const aiNode = nodeOf(inst, 'exec');
    const res = await gqlRequest(
      UPDATE_WORKFLOW_NODE,
      { instanceId: ctx.instanceId, nodeId: aiNode.id, input: { linkUpstreamPullRequest: true } },
      token,
    );
    const body = await res.json();
    expect(body.errors?.[0]?.message).toContain('仅人类节点');
  }, 30_000);

  it.skipIf(!process.env.MONGODB_URI)('T-PR16 READY 人类节点直接被 rejected 事件打回成功', async () => {
    const ctx = await makeCtx(baseGraph(), 'tpr16');
    const { pr } = await activateReview(ctx);
    const review = nodeOf(await refreshInstance(ctx), 'review');

    // 直写 DB 模拟「上游刚全部 DONE、人类节点尚未 start」的 READY 窗口（D3 防御场景）
    await mongoose.connection.collection('workflowinstances').updateOne(
      { _id: new mongoose.Types.ObjectId(ctx.instanceId) },
      { $set: { 'nodes.$[n].status': 'READY', 'nodes.$[n].startedAt': null } },
      { arrayFilters: [{ 'n.nodeId': review.id }] },
    );
    expect(nodeOf(await refreshInstance(ctx), 'review').status).toBe('READY');

    const result = await postEvent(eventBody(pr, 'changes_requested'));
    expect(result.body.handled).toBe(true);
    expect(result.body.results[0].action).toBe('REJECT_HUMAN_NODE');
    expect((await waitForStatus(ctx, 'review', 'REJECT')).rejectInfo.reason).toContain(
      'Pull Request审核被拒绝',
    );
    expect((await waitForStatus(ctx, 'exec', 'REWORK')).reworkCount).toBe(1);
  }, 40_000);

  it('T-PR17 同一 PR 关联两个实例 → 各自处理，results 含两条', async () => {
    const pr = nextPr();
    const ctxA = await makeCtx(baseGraph(), 'tpr17a');
    await activateReview(ctxA, pr);
    const ctxB = await makeCtx(baseGraph(), 'tpr17b');
    await activateReview(ctxB, pr);

    const result = await postEvent(eventBody(pr, 'approved'));
    expect(result.body.handled).toBe(true);
    expect(result.body.results).toHaveLength(2);
    expect(result.body.results.every((r: any) => r.action === 'COMPLETE_HUMAN_NODE')).toBe(true);
    expect(result.body.results.map((r: any) => r.workflowInstanceId).sort()).toEqual(
      [ctxA.instanceId, ctxB.instanceId].sort(),
    );
    await waitForStatus(ctxA, 'review', 'DONE');
    await waitForStatus(ctxB, 'review', 'DONE');
  }, 60_000);

  it('T-PR18 PR 标识三种写法归一一致', async () => {
    const ctx = await makeCtx(baseGraph(), 'tpr18');
    const pr = nextPr();
    const number = pr.split('#')[1];
    const exec = await startExecAndLink(ctx, `https://github.com/Deliay/z-agent-gear/pull/${number}`);
    expect(exec.token).toBeTruthy();

    const hashForm = await callTool(ctx, exec.sessionId, exec.token, 'linkPullRequest', {
      pullRequestId: pr,
    });
    expect(hashForm.data.pullRequestId).toBe(pr);
    const pathForm = await callTool(ctx, exec.sessionId, exec.token, 'linkPullRequest', {
      pullRequestId: `Deliay/z-agent-gear/pull/${number}`,
    });
    expect(pathForm.data.pullRequestId).toBe(pr);

    const inst = await refreshInstance(ctx);
    expect(inst.pullRequestLinks).toHaveLength(1);
    expect(inst.pullRequestLinks[0].pullRequestId).toBe(pr);
    expect(inst.pullRequestLinks[0].prUrl).toBe(`https://github.com/Deliay/z-agent-gear/pull/${number}`);
  }, 30_000);
});
