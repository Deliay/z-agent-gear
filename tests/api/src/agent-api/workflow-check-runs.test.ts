import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import { startMockGitHubServer, type MockGitHubServer } from '../mock-github-server.js';
import { createFrontUser } from '../support/front-users.js';

/**
 * 工作流节点状态 → GitHub Check Runs 同步 —— API 用例 T-CR02 ~ T-CR12。
 *
 * 前置：
 * - `aspire start`，且 agent-api 的 `GITHUB_API_BASE` 指向本文件的 mock server
 *   （示例：`GITHUB_API_BASE=http://127.0.0.1:19418 aspire start`）。
 * - `EVENT_CALLBACK_TOKEN`（工作流 MCP 工具链路）与 `MONGODB_URI` / `REDIS_URL` 就绪。
 *
 * 未配置 `GITHUB_API_BASE` 时整套跳过（T-CR01「绑定即首同步」的出站断言由
 * `servers/agent-api/src/services/workflow/tool-handlers.test.ts` +
 * `pr-check-run-sync.test.ts` 覆盖）。
 */
const AGENT_API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273';
const GITHUB_API_BASE = process.env.GITHUB_API_BASE ?? '';
const MOCK_PORT = GITHUB_API_BASE ? Number(new URL(GITHUB_API_BASE).port || 80) : 19418;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const MONGODB_URI = process.env.MONGODB_URI ?? '';
const REPO = 'Deliay/z-agent-gear';

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
    createWorkflowTemplate(input: $input) { id name version }
  }
`;

const CONFIGURE_WORKFLOW = `
  mutation ConfigureWorkflow($templateId: ID!, $input: ConfigureWorkflowInput!) {
    configureWorkflow(templateId: $templateId, input: $input) { id name }
  }
`;

const INSTANTIATE_WORKFLOW = `
  mutation InstantiateWorkflow($input: InstantiateWorkflowInput!) {
    instantiateWorkflow(input: $input) {
      id name archived
      nodes { id nodeKey type name status sessionId }
    }
  }
`;

const WORKFLOW_INSTANCE_QUERY = `
  query WorkflowInstance($id: ID!) {
    workflowInstance(id: $id) {
      id name archived
      pullRequestLinks {
        pullRequestId prUrl nodeId nodeName registeredAt
        checkRunUrl lastSyncedCommitSha lastSyncAt lastSyncError
      }
      nodes { id nodeKey type name status sessionId }
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(
  fn: () => Promise<T | null>,
  timeoutMs = 15000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(intervalMs);
  }
  throw new Error('timeout waiting condition');
}

async function newFrontUser(tag: string): Promise<{ token: string; userId: string; username: string }> {
  return createFrontUser();
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
    { input: { name: `cr-${tag}-${Date.now()}`, type: 'local' } },
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
    hostname: `cr-${tag}-host`,
    version: '2.0.0',
    homeDir: FAKE_CONTROLLER_HOME,
    platform: 'linux',
  });
  const reg = await registered;
  return { client, controllerId: reg.controllerId, rawKey, starts };
}

async function refreshCapabilities(token: string, controllerId: string): Promise<void> {
  await gql(REFRESH_ACP_CAPABILITIES, { controllerId }, token);
}

async function createWorkspace(token: string, controllerId: string): Promise<string> {
  const path = `/tmp/wf-cr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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

function human(nodeKey: string, name: string, dependsOn: string[]): NodeSpec {
  return { nodeKey, type: 'HUMAN', name, stage: '阶段', dependsOn, requiresWorktree: false };
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

/** input(HUMAN) → exec(AI) → review(HUMAN) */
function baseGraph(): NodeSpec[] {
  return [human('input', '需求输入', []), ai('exec', '代码执行', ['input']), human('review', '代码审核', ['exec'])];
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
  userId: string;
  fake: FakeController;
  workspaceId: string;
  instanceId: string;
  instance: any;
}

async function createCtx(
  token: string,
  userId: string,
  fake: FakeController,
  tag: string,
  nodes: NodeSpec[] = baseGraph(),
): Promise<Ctx> {
  const templateData = await gql<{ createWorkflowTemplate: { id: string } }>(
    CREATE_WORKFLOW_TEMPLATE,
    { input: { name: `${tag}-${Date.now()}`, description: tag, nodes } },
    token,
  );
  const workspaceId = await createWorkspace(token, fake.controllerId);
  const configuredData = await gql<{ configureWorkflow: { id: string } }>(
    CONFIGURE_WORKFLOW,
    {
      templateId: templateData.createWorkflowTemplate.id,
      input: {
        name: `${tag}-cfg-${Date.now()}`,
        controllerId: fake.controllerId,
        nodes: configureNodes(nodes),
      },
    },
    token,
  );
  const instData = await gql<{ instantiateWorkflow: any }>(
    INSTANTIATE_WORKFLOW,
    {
      input: {
        source: 'CONFIGURED',
        configuredWorkflowId: configuredData.configureWorkflow.id,
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
    userId,
    fake,
    workspaceId,
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
  return waitFor(async () => {
    const inst = await refreshInstance(ctx);
    const node = nodeOf(inst, nodeKey);
    return node.status === status ? node : null;
  });
}

async function waitForStart(ctx: Ctx, nodeKey: string): Promise<StartEvent> {
  return waitFor(async () => {
    const inst = await refreshInstance(ctx);
    const node = nodeOf(inst, nodeKey);
    if (!node.sessionId) return null;
    const event = ctx.fake.starts.find((s) => s.sessionId === node.sessionId);
    return event?.mcpEndpoint?.token ? event : null;
  });
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
  return { isError: Boolean(result.isError), data: JSON.parse(result.content[0].text) };
}

/** 完成 input 人类节点，等待 exec 会话启动并关联 PR */
async function startExecAndLink(ctx: Ctx, pullRequestId: string) {
  await completeHuman(ctx, 'input', '实现 Check Runs 同步');
  await waitForStatus(ctx, 'exec', 'RUNNING');
  const start = await waitForStart(ctx, 'exec');
  const linked = await callTool(ctx, start.sessionId, start.mcpEndpoint!.token, 'linkPullRequest', {
    pullRequestId,
  });
  expect(linked.isError).toBe(false);
  expect(linked.data.registered).toBe(true);
  return { sessionId: start.sessionId, token: start.mcpEndpoint!.token };
}

async function seedGithubAccount(userId: string) {
  const db = (await mongoDb())!;
  const accountId = new mongoose.Types.ObjectId();
  await db.collection('githubaccounts').insertOne({
    _id: accountId,
    userId: new mongoose.Types.ObjectId(userId),
    githubUserId: Date.now(),
    githubLogin: 'check-run-owner',
    accessToken: 'encrypted-token',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.collection('githubinstallations').insertOne({
    _id: new mongoose.Types.ObjectId(),
    accountId,
    installationId: Date.now(),
    accountLogin: 'check-run-owner',
    accountType: 'User',
    repos: [{ repoId: 1, repoName: 'z-agent-gear', fullName: REPO, private: false, permissions: { read: true, write: true } }],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return {
    cleanup: async () => {
      await db.collection('githubinstallations').deleteOne({ accountId });
      await db.collection('githubaccounts').deleteOne({ _id: accountId });
    },
  };
}

async function mongoDb() {
  if (!MONGODB_URI) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(MONGODB_URI);
  return mongoose.connection.db ?? null;
}

const hasEnv = Boolean(GITHUB_API_BASE && process.env.EVENT_CALLBACK_TOKEN && MONGODB_URI);

describe.skipIf(!hasEnv)('工作流节点状态 → Check Runs（T-CR02~T-CR12）', () => {
  let mock: MockGitHubServer;
  let token = '';
  let userId = '';
  let fake: FakeController;
  let githubCleanup: (() => Promise<void>) | null = null;
  let redis: Redis | null = null;

  beforeAll(async () => {
    mock = await startMockGitHubServer({ port: MOCK_PORT, headSha: `sha-${Date.now()}` });
    const signed = await newFrontUser('wfcr');
    token = signed.token;
    userId = signed.userId;
    fake = await registerFakeController(token, 'cr');
    await refreshCapabilities(token, fake.controllerId);
    const seeded = await seedGithubAccount(userId);
    githubCleanup = seeded.cleanup;
    redis = new Redis(REDIS_URL, { enableOfflineQueue: false, retryStrategy: () => null });
  }, 45_000);

  afterAll(async () => {
    fake?.client.disconnect();
    redis?.disconnect();
    if (githubCleanup) await githubCleanup();
    await mock?.close();
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  });

  function createCalls() {
    return mock.calls.filter((c) => c.method === 'POST' && /\/check-runs$/.test(c.path));
  }

  function patchCalls() {
    return mock.calls.filter((c) => c.method === 'PATCH' && /\/check-runs\/\d+$/.test(c.path));
  }

  /** 关联 PR 并等待本次登记对应的首同步 check-run（按调用增量判定，避免命中历史用例的 run） */
  async function linkAndWaitCreate(ctx: Ctx, pr: string) {
    const before = createCalls().length;
    const exec = await startExecAndLink(ctx, pr);
    const run = await waitFor(async () => {
      if (createCalls().length <= before) return null;
      return mock.checkRuns.at(-1) ?? null;
    });
    return { exec, run };
  }

  it('T-CR02 状态变化同 sha：PATCH 同一 check-run（completed/success），无新建', async () => {
    const ctx = await createCtx(token, userId, fake, 'tcr02');
    const pr = `${REPO}#${Date.now() % 100000}`;
    const { exec, run: linkedRun } = await linkAndWaitCreate(ctx, pr);
    const before = createCalls().length;

    await callTool(ctx, exec.sessionId, exec.token, 'completeCurrentNode', {
      artifacts: [{ title: '代码执行产物', value: 'done' }],
    });

    const patched = await waitFor(async () => {
      const run = mock.checkRuns.find((r) => r.id === linkedRun.id);
      return run?.status === 'completed' && run.conclusion === 'success' ? run : null;
    });
    expect(patched.head_sha).toBe(linkedRun.head_sha);
    expect(createCalls().length).toBe(before);
  }, 30_000);

  it('T-CR03 commit 前进：旧 check-run output 标记已过期（不写 stale）+ 新 sha 新建并记录', async () => {
    const ctx = await createCtx(token, userId, fake, 'tcr03');
    const pr = `${REPO}#${Date.now() % 100000}`;
    const { exec, run: old } = await linkAndWaitCreate(ctx, pr);
    const newSha = `sha-${Date.now()}-next`;
    mock.setHead(newSha);

    const patchesBefore = patchCalls().length;
    await callTool(ctx, exec.sessionId, exec.token, 'completeCurrentNode', {
      artifacts: [{ title: '代码执行产物', value: 'done' }],
    });

    await waitFor(async () => (mock.checkRuns.some((r) => r.head_sha === newSha) ? true : null));
    const oldRun = mock.checkRuns.find((r) => r.id === old.id);
    // GitHub 只允许 GitHub 自己置 stale：应用侧只 PATCH output，结论保持原值
    expect(oldRun?.conclusion).not.toBe('stale');
    expect(String(oldRun?.output?.title ?? '')).toContain('已过期');
    const oldPatches = patchCalls()
      .slice(patchesBefore)
      .filter((c) => c.path.endsWith(`/check-runs/${old.id}`));
    expect(oldPatches.length).toBeGreaterThan(0);
    expect(oldPatches.every((c) => c.body?.conclusion === undefined)).toBe(true);
    const created = mock.checkRuns.find((r) => r.head_sha === newSha);
    expect(created?.status).toBe('completed');
    expect(created?.conclusion).toBe('success');

    const inst = await waitFor(async () => {
      const fresh = await refreshInstance(ctx);
      const link = fresh.pullRequestLinks[0];
      return link?.lastSyncedCommitSha === newSha ? link : null;
    });
    expect(inst.lastSyncedCommitSha).toBe(newSha);
  }, 30_000);

  it('T-CR04 幂等：重复绑定同 PR 不产生重复 check-run', async () => {
    const ctx = await createCtx(token, userId, fake, 'tcr04');
    const pr = `${REPO}#${Date.now() % 100000}`;
    const { exec } = await linkAndWaitCreate(ctx, pr);
    const count = createCalls().length;
    const patches = patchCalls().length;

    await callTool(ctx, exec.sessionId, exec.token, 'linkPullRequest', { pullRequestId: pr });
    await sleep(500);

    expect(createCalls().length).toBe(count);
    expect(patchCalls().length).toBe(patches);
  }, 30_000);

  it('T-CR06 todo panel 满足四条件刷新 output.text；非工作流会话零写入', async () => {
    const ctx = await createCtx(token, userId, fake, 'tcr06');
    const pr = `${REPO}#${Date.now() % 100000}`;
    const { exec, run: linkedRun } = await linkAndWaitCreate(ctx, pr);
    const before = patchCalls().length;

    redis!.publish(
      'session:message',
      JSON.stringify({
        sessionId: exec.sessionId,
        message: {
          type: 'plan',
          content: {
            sessionUpdate: 'plan',
            entries: [
              { content: '已完成任务', status: 'completed', priority: 'high' },
              { content: '进行中任务', status: 'in_progress', priority: 'medium' },
              { content: '等待中任务', status: 'pending', priority: 'low' },
            ],
          },
        },
      }),
    );

    await waitFor(async () => {
      const run = mock.checkRuns.find((r) => r.id === linkedRun.id);
      const text = typeof run?.output?.text === 'string' ? run.output.text : '';
      return text.includes('- [x] 已完成任务') && text.includes('- 🔄 进行中任务') ? run : null;
    });
    expect(patchCalls().length).toBeGreaterThan(before);

    // 非工作流会话：条件不满足，零写入
    const after = patchCalls().length;
    redis!.publish(
      'session:message',
      JSON.stringify({
        sessionId: 'not-a-workflow-session',
        message: {
          type: 'plan',
          content: { sessionUpdate: 'plan', entries: [{ content: 'x', status: 'pending' }] },
        },
      }),
    );
    await sleep(500);
    expect(patchCalls().length).toBe(after);
  }, 30_000);

  it('T-CR08 故障不回流：403 → lastSyncError 白名单文案，节点仍完成', async () => {
    const ctx = await createCtx(token, userId, fake, 'tcr08');
    const pr = `${REPO}#${Date.now() % 100000}`;
    const { exec } = await linkAndWaitCreate(ctx, pr);

    mock.failNext(403);
    await callTool(ctx, exec.sessionId, exec.token, 'completeCurrentNode', {
      artifacts: [{ title: '代码执行产物', value: 'done' }],
    });

    const link = await waitFor(async () => {
      const fresh = await refreshInstance(ctx);
      const row = fresh.pullRequestLinks[0];
      return row?.lastSyncError ? row : null;
    });
    expect(link.lastSyncError).toBe('检查项写入权限不足');
    await waitForStatus(ctx, 'review', 'RUNNING');
  }, 30_000);

  it('T-CR09 PR 关闭：停止同步且 lastSyncError 为空', async () => {
    const ctx = await createCtx(token, userId, fake, 'tcr09');
    const pr = `${REPO}#${Date.now() % 100000}`;
    const { exec } = await linkAndWaitCreate(ctx, pr);
    mock.setPullRequestState('closed');
    const beforeCreates = createCalls().length;
    const beforePatches = patchCalls().length;
    const beforeRuns = mock.checkRuns.length;

    await callTool(ctx, exec.sessionId, exec.token, 'completeCurrentNode', {
      artifacts: [{ title: '代码执行产物', value: 'done' }],
    });
    await sleep(800);

    expect(createCalls().length).toBe(beforeCreates);
    expect(patchCalls().length).toBe(beforePatches);
    expect(mock.checkRuns.length).toBe(beforeRuns);
    const fresh = await refreshInstance(ctx);
    expect(fresh.pullRequestLinks[0]?.lastSyncError ?? null).toBeNull();
    // 恢复 open，避免影响后续用例
    mock.setPullRequestState('open');
  }, 30_000);

  it('T-CR10 注销竞态：末节点完成触发注销后仍写入 DONE check-run', async () => {
    // 两节点图：exec 为末节点，complete 同时触发 onNodesTransitioned 与 onWorkflowFinished（注销）
    const ctx = await createCtx(token, userId, fake, 'tcr10', [
      human('input', '需求输入', []),
      ai('exec', '代码执行', ['input']),
    ]);
    const pr = `${REPO}#${Date.now() % 100000}`;
    const { exec, run: linkedRun } = await linkAndWaitCreate(ctx, pr);

    await callTool(ctx, exec.sessionId, exec.token, 'completeCurrentNode', {
      artifacts: [{ title: '代码执行产物', value: 'done' }],
    });

    // capture-then-execute：注销后仍按快照完成写入
    await waitFor(async () => {
      const run = mock.checkRuns.find((r) => r.id === linkedRun.id);
      return run?.status === 'completed' && run.conclusion === 'success' ? run : null;
    });
    await waitFor(async () => {
      const fresh = await refreshInstance(ctx);
      return fresh.pullRequestLinks.length === 0 ? fresh : null;
    });
  }, 30_000);

  it('T-CR11 GraphQL 透出同步字段（ISO lastSyncAt）', async () => {
    const ctx = await createCtx(token, userId, fake, 'tcr11');
    const pr = `${REPO}#${Date.now() % 100000}`;
    await linkAndWaitCreate(ctx, pr);

    const link = await waitFor(async () => {
      const fresh = await refreshInstance(ctx);
      return fresh.pullRequestLinks[0]?.lastSyncAt ? fresh.pullRequestLinks[0] : null;
    });
    expect(link.checkRunUrl).toMatch(/^https?:\/\//);
    expect(link.lastSyncedCommitSha).toBeTruthy();
    expect(new Date(link.lastSyncAt).toString()).not.toBe('Invalid Date');
    expect(link.lastSyncError).toBeNull();
  }, 30_000);

  it('T-CR12 存量兼容：新字段为 null 的登记在首次状态变化时自然补齐', async () => {
    const ctx = await createCtx(token, userId, fake, 'tcr12');
    const pr = `${REPO}#${Date.now() % 100000}`;
    const { exec } = await linkAndWaitCreate(ctx, pr);

    const db = (await mongoDb())!;
    await db.collection('workflowprhandlers').updateOne(
      { workflowInstanceId: new mongoose.Types.ObjectId(ctx.instanceId), nodeId: nodeOf(await refreshInstance(ctx), 'exec').id },
      {
        $set: {
          lastWrittenCommitSha: null,
          lastCheckRunId: null,
          lastCheckRunUrl: null,
          lastSyncedNodeStatus: null,
          lastSyncAt: null,
          lastTodoDigest: null,
        },
      },
    );
    const before = createCalls().length;

    await callTool(ctx, exec.sessionId, exec.token, 'completeCurrentNode', {
      artifacts: [{ title: '代码执行产物', value: 'done' }],
    });

    await waitFor(async () => (createCalls().length > before ? true : null));
    const link = await waitFor(async () => {
      const fresh = await refreshInstance(ctx);
      return fresh.pullRequestLinks[0]?.lastSyncedCommitSha ? fresh.pullRequestLinks[0] : null;
    });
    expect(link.lastSyncedCommitSha).toBeTruthy();
  }, 30_000);
});
