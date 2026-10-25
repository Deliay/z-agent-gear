import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';
import { createHmac } from 'node:crypto';

/**
 * GitHub 原生 Webhook 入口 —— 黑盒用例 T-GHWH1 ~ T-GHWH7。
 *
 * 前置：`aspire start`（agent-api + controller-api 依赖服务），
 * 并配置 `GITHUB_WEBHOOK_SECRET`；缺失时整套跳过。
 * fake controller 经主 WebSocket 自动应答 acp:start/acp:resume，并记录节点作用域 token。
 */
const AGENT_API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273';
const API_BASE = AGENT_API_URL.replace(/\/graphql$/, '');
const WEBHOOK_URL = `${API_BASE}/api/events/github/webhook`;
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

const SIGNUP = `
  mutation Signup($username: String!, $password: String!) {
    signup(username: $username, password: $password) { token }
  }
`;

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

const CONFIGURE_WORKFLOW = `
  mutation ConfigureWorkflow($templateId: ID!, $input: ConfigureWorkflowInput!) {
    configureWorkflow(templateId: $templateId, input: $input) {
      id name
      nodes { nodeKey type name linkUpstreamPullRequest agentConfig { acpServerType } }
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

const COMPLETE_HUMAN_NODE = `
  mutation CompleteHumanNode($instanceId: ID!, $nodeId: ID!, $input: String) {
    completeHumanNode(instanceId: $instanceId, nodeId: $nodeId, input: $input) {
      id nodeKey name status
    }
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

async function signup(tag: string): Promise<string> {
  const uid = `${tag}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
  const body = await res.json();
  return body.data?.signup?.token ?? '';
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
    { input: { name: `ghwh-${tag}-${Date.now()}`, type: 'local' } },
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
    hostname: `ghwh-${tag}-host`,
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
  const path = `/tmp/wf-ghwh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
function baseGraph(): NodeSpec[] {
  return [
    human('input', '需求输入', []),
    ai('exec', '代码执行', ['input']),
    human('review', '代码审核', ['exec'], true),
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

/** 启动 exec 节点并以节点作用域 token 关联 PR，再推进到 review 节点 RUNNING */
async function activateReview(ctx: Ctx, prNumber: number) {
  const pr = `Deliay/z-agent-gear#${prNumber}`;
  await completeHuman(ctx, 'input', '实现 GitHub 原生 webhook');
  await waitForStatus(ctx, 'exec', 'RUNNING');
  const start = await waitForStart(ctx, 'exec');
  const sessionId = start.sessionId;
  const token = start.mcpEndpoint!.token;
  const linked = await callTool(ctx, sessionId, token, 'linkPullRequest', { pullRequestId: pr });
  expect(linked.isError).toBe(false);
  expect(linked.data.registered).toBe(true);
  await callTool(ctx, sessionId, token, 'completeCurrentNode', {
    artifacts: [{ title: '代码执行产物', value: '实现完成' }],
  });
  await waitForStatus(ctx, 'review', 'RUNNING');
  return { sessionId, token, pr };
}

/** GitHub 原生 pull_request_review 事件载荷 */
function githubReviewBody(
  prNumber: number,
  reviewState: string,
  reviewId: number,
  overrides: Record<string, unknown> = {},
) {
  return JSON.stringify({
    action: 'submitted',
    review: {
      id: reviewId,
      state: reviewState,
      body: '请按 inline comment 调整后合并',
      user: { login: 'alice' },
      submitted_at: '2026-10-25T06:00:00Z',
    },
    repository: { full_name: 'Deliay/z-agent-gear' },
    pull_request: {
      number: prNumber,
      html_url: `https://github.com/Deliay/z-agent-gear/pull/${prNumber}`,
    },
    ...overrides,
  });
}

let prSeq = Number(String(Date.now()).slice(-6)) * 10 + 7000;
function nextPrNumber(): number {
  return prSeq++;
}

let reviewSeq = Math.floor(Date.now() / 1000);
function nextReviewId(): number {
  return reviewSeq++;
}

function sign(raw: string, secret = WEBHOOK_SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
}

async function postWebhook(raw: string, headers: Record<string, string> = {}) {
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'pull_request_review',
      'X-Hub-Signature-256': sign(raw),
      ...headers,
    },
    body: raw,
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

// 缺参即绿的 skipIf 需要 fail-fast 哨兵。CI 下未配置 secret 且未显式 SKIP_GITHUB_WEBHOOK=1 时红。
describe('GitHub Webhook 环境哨兵', () => {
  it('CI 下 GITHUB_WEBHOOK_SECRET 必须配置（SKIP_GITHUB_WEBHOOK=1 可显式跳过）', () => {
    if (process.env.SKIP_GITHUB_WEBHOOK === '1') return;
    if (!process.env.CI) return;
    expect(WEBHOOK_SECRET).toBeTruthy();
  });
});

describe.skipIf(!WEBHOOK_SECRET)('GitHub 原生 Webhook 入口（T-GHWH1~T-GHWH4）', () => {
  it('T-GHWH1 鉴权：无签名/错误签名 401，平台 token 无效，正确 HMAC 200', async () => {
    const raw = githubReviewBody(nextPrNumber(), 'approved', nextReviewId());

    const noSig = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request_review' },
      body: raw,
    });
    expect(noSig.status).toBe(401);

    const wrongSig = await postWebhook(raw, { 'X-Hub-Signature-256': sign(raw, 'wrong-secret') });
    expect(wrongSig.status).toBe(401);

    const tokenAttempt = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request_review',
        'X-Event-Token': process.env.EVENT_CALLBACK_TOKEN ?? 'whatever',
      },
      body: raw,
    });
    expect(tokenAttempt.status).toBe(401);

    const ok = await postWebhook(raw);
    expect(ok.status).toBe(200);
    expect(typeof ok.body.handled).toBe('boolean');
    expect(Array.isArray(ok.body.results)).toBe(true);
  });

  it('T-GHWH2 ping / 其他事件类型 / 非 submitted action → UNSUPPORTED_EVENT', async () => {
    const ping = await postWebhook(JSON.stringify({ zen: 'Keep it logically awesome.' }), {
      'X-GitHub-Event': 'ping',
    });
    expect(ping.status).toBe(200);
    expect(ping.body).toMatchObject({ handled: false, reason: 'UNSUPPORTED_EVENT', results: [] });

    const push = await postWebhook(JSON.stringify({ ref: 'refs/heads/main' }), {
      'X-GitHub-Event': 'push',
    });
    expect(push.body).toMatchObject({ handled: false, reason: 'UNSUPPORTED_EVENT' });

    const edited = githubReviewBody(nextPrNumber(), 'approved', nextReviewId(), {
      action: 'edited',
    });
    const editedResult = await postWebhook(edited);
    expect(editedResult.status).toBe(200);
    expect(editedResult.body).toMatchObject({ handled: false, reason: 'UNSUPPORTED_EVENT' });
  });

  it('T-GHWH3 载荷非法 400 且带 detail', async () => {
    const missingState = await postWebhook(
      githubReviewBody(nextPrNumber(), 'approved', nextReviewId(), {
        review: { id: nextReviewId() },
      }),
    );
    expect(missingState.status).toBe(400);
    expect(missingState.body).toHaveProperty('detail');

    const badFullName = await postWebhook(
      githubReviewBody(nextPrNumber(), 'approved', nextReviewId(), {
        repository: { full_name: 'noSlash' },
      }),
    );
    expect(badFullName.status).toBe(400);
    expect(badFullName.body).toEqual({ error: 'payload.invalid', detail: 'repository.full_name' });

    const notJson = await postWebhook('not-json{{{');
    expect(notJson.status).toBe(400);
  });

  it('T-GHWH4 未登记 PR 返回 NO_HANDLER', async () => {
    const raw = githubReviewBody(999999, 'approved', nextReviewId(), {
      repository: { full_name: 'unknown-owner/unknown-repo' },
      pull_request: { number: 999999 },
    });
    const result = await postWebhook(raw);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ handled: false, reason: 'NO_HANDLER', results: [] });
  });
});

describe.skipIf(!WEBHOOK_SECRET)('GitHub 原生 Webhook 驱动工作流（T-GHWH5~T-GHWH7）', () => {
  let token = '';
  let fake: FakeController;
  let workspaceId = '';
  const makeCtx = (nodes: NodeSpec[], tag: string) =>
    createCtx(token, fake, nodes, tag, workspaceId);

  beforeAll(async () => {
    token = await signup('ghwh');
    expect(token).toBeTruthy();
    fake = await registerFakeController(token, 'ghwh');
    await refreshCapabilities(token, fake.controllerId);
    workspaceId = await createWorkspace(token, fake.controllerId);
  }, 30_000);

  afterAll(async () => {
    fake?.client.disconnect();
  });

  it('T-GHWH5 approved → 人类节点 DONE，下游 AI 首条提示词含 A.2 文案', async () => {
    const ctx = await makeCtx(baseGraph(), 'tghwh5');
    const prNumber = nextPrNumber();
    const { pr } = await activateReview(ctx, prNumber);

    const raw = githubReviewBody(prNumber, 'approved', nextReviewId());
    const result = await postWebhook(raw);
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
    expect(text).toContain(`https://github.com/Deliay/z-agent-gear/pull/${prNumber}`);
    expect(text).toContain('审核人：alice');
    expect(text).toContain('审核时间：2026-10-25T06:00:00Z');

    const inst = await refreshInstance(ctx);
    const prompts = inst.additionalPrompts as { key: string; value: string }[];
    expect(prompts.filter((p) => p.key === 'github-pr-review')).toHaveLength(1);
    expect(pr).toBe(`Deliay/z-agent-gear#${prNumber}`);
  }, 40_000);

  it('T-GHWH6 changes_requested → 人类节点 REJECT、上游 REWORK，返工消息含 A.3 文案', async () => {
    const ctx = await makeCtx(baseGraph(), 'tghwh6');
    const prNumber = nextPrNumber();
    const { sessionId } = await activateReview(ctx, prNumber);

    const raw = githubReviewBody(prNumber, 'changes_requested', nextReviewId());
    const result = await postWebhook(raw);
    expect(result.body.handled).toBe(true);
    expect(result.body.results[0].action).toBe('REJECT_HUMAN_NODE');

    const review = await waitForStatus(ctx, 'review', 'REJECT');
    expect(review.rejectInfo.reason).toContain('Pull Request审核被拒绝');
    expect(review.rejectInfo.reason).toContain('注意检查pr的inline comment');
    await waitForStatus(ctx, 'exec', 'REWORK');

    const reworkStart = await waitForStart(ctx, 'exec');
    const text = await waitForMessage(ctx, reworkStart.sessionId ?? sessionId, 'Pull Request审核被拒绝');
    expect(text).toContain('请按 inline comment 调整后合并');
    expect(text).toContain(`https://github.com/Deliay/z-agent-gear/pull/${prNumber}`);
  }, 40_000);

  it('T-GHWH7 同一 review.id 重复投递 → DUPLICATE_EVENT，状态只变化一次', async () => {
    const ctx = await makeCtx(baseGraph(), 'tghwh7');
    const prNumber = nextPrNumber();
    await activateReview(ctx, prNumber);

    const reviewId = nextReviewId();
    const raw = githubReviewBody(prNumber, 'approved', reviewId);
    const first = await postWebhook(raw);
    expect(first.body.handled).toBe(true);

    const dup = await postWebhook(raw);
    expect(dup.status).toBe(200);
    expect(dup.body).toMatchObject({ handled: false, reason: 'DUPLICATE_EVENT' });

    await waitForStatus(ctx, 'review', 'DONE');
    const inst = await refreshInstance(ctx);
    expect(nodeOf(inst, 'review').status).toBe('DONE');
  }, 40_000);
});
