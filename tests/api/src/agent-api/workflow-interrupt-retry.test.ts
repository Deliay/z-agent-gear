import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';
import Redis from 'ioredis';
import mongoose from 'mongoose';
import { createFrontUser } from '../support/front-users.js';

/**
 * 工作流节点中断自动重试 —— API 用例 T-WFIR1 ~ T-WFIR9。
 *
 * 前置：`aspire start`（agent-api + controller-api 就绪）+ `MONGODB_URI`（直连预置排期字段）。
 * 退避窗口约 2 小时不可真实等待：T-WFIR4/6/7 通过直连 Mongo 预置 retryCount / retryPhase /
 * nextRetryAt / retryDeadlineAt 等价覆盖扫描与用尽语义（实现计划 D11）。
 */
const AGENT_API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const MONGODB_URI = process.env.MONGODB_URI ?? '';

const HAS_MONGO = Boolean(MONGODB_URI);

const redis = new Redis(REDIS_URL, { enableOfflineQueue: false, retryStrategy: () => null });

function gqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(AGENT_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
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

const REFRESH_ACP_CAPABILITIES = `
  mutation RefreshAcpCapabilities($controllerId: ID!) {
    refreshAcpCapabilities(controllerId: $controllerId) { type available version checkedAt }
  }
`;

const CREATE_WORKFLOW_TEMPLATE = `
  mutation CreateWorkflowTemplate($input: WorkflowTemplateInput!) {
    createWorkflowTemplate(input: $input) {
      id name version isBuiltin
      nodes { nodeKey type name stage prompts artifactTitles dependsOn requiresWorktree }
    }
  }
`;

const CONFIGURE_WORKFLOW = `
  mutation ConfigureWorkflow($templateId: ID!, $input: ConfigureWorkflowInput!) {
    configureWorkflow(templateId: $templateId, input: $input) {
      id name controllerId
      nodes { nodeKey type name prompts agentConfig { acpServerType modeId modelId initNewWorktree } }
    }
  }
`;

const INSTANTIATE_WORKFLOW = `
  mutation InstantiateWorkflow($input: InstantiateWorkflowInput!) {
    instantiateWorkflow(input: $input) { id name nodes { id nodeKey status } }
  }
`;

const COMPLETE_HUMAN_NODE = `
  mutation CompleteHumanNode($instanceId: ID!, $nodeId: ID!, $input: String) {
    completeHumanNode(instanceId: $instanceId, nodeId: $nodeId, input: $input) { id nodeKey name status }
  }
`;

const CLOSE_SESSION = `
  mutation CloseSession($id: ID!) { closeSession(id: $id) }
`;

const RESTART_NODE = `
  mutation RestartNode($instanceId: ID!, $nodeId: ID!) {
    restartNode(instanceId: $instanceId, nodeId: $nodeId) { id nodeKey status failInfo { reason source } }
  }
`;

const WORKFLOW_INSTANCE_QUERY = `
  query WorkflowInstance($id: ID!) {
    workflowInstance(id: $id) {
      id name currentNodeNames
      nodes { id nodeKey name status sessionId reworkCount retryCount nextRetryAt failInfo { reason source at } }
    }
  }
`;

const SESSION_MESSAGES_QUERY = `
  query SessionMessages($sessionId: ID!) {
    sessionMessages(sessionId: $sessionId, limit: 100) { id direction type content }
  }
`;

const TODO_LIST_QUERY = `query { getTodoList { id type priority title } }`;

function createClient(): ClientSocket {
  return SocketIOClient(CONTROLLER_API_URL, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
}

function waitForEvent<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 10000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== undefined) return value;
    await sleep(300);
  }
  throw new Error(`Timeout waiting for ${label}`);
}

interface FakeController {
  client: ClientSocket;
  controllerId: string;
}

interface StartEventData {
  requestId: string;
  sessionId: string;
  serverType?: string;
  mcpEndpoint?: { token: string; serverNames: string[] };
}

interface ResumeEventData {
  requestId: string;
  sessionId: string;
  mcpEndpoint?: { token: string; serverNames: string[] };
}

/** 注册 fake controller：自动应答 acp:start / acp:resume / acp:stop（ack），并记录事件 */
async function registerFakeController(token: string, tag: string): Promise<FakeController & {
  starts: StartEventData[];
  resumes: ResumeEventData[];
  stops: string[];
}> {
  const keyRes = await gqlRequest(CREATE_KEY, { input: { name: `wfr-${tag}-${Date.now()}`, type: 'local' } }, token);
  const rawKey = (await keyRes.json()).data.createControllerKey.rawKey;

  const client = createClient();
  const starts: StartEventData[] = [];
  const resumes: ResumeEventData[] = [];
  const stops: string[] = [];

  client.on('acp:check', (data: { requestId: string }) => {
    client.emit('acp:check:result', {
      requestId: data.requestId,
      servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
    });
  });
  client.on('git:check', (data: { requestId: string }) => {
    client.emit('git:check:result', { requestId: data.requestId, isGitRepo: false });
  });
  client.on('git:worktree:list', (data: { requestId: string }) => {
    client.emit('git:worktree:list:result', { requestId: data.requestId, success: true, worktrees: [] });
  });
  client.on('acp:start', (data: StartEventData) => {
    starts.push(data);
    client.emit('acp:start:result', {
      requestId: data.requestId,
      sessionId: data.sessionId,
      success: true,
      externalSessionId: `ext_${tag}_${data.sessionId}`,
    });
  });
  client.on('acp:resume', (data: ResumeEventData) => {
    resumes.push(data);
    client.emit('acp:resume:result', {
      requestId: data.requestId,
      sessionId: data.sessionId,
      success: true,
    });
  });
  client.on('acp:stop', (data: { sessionId: string }) => {
    stops.push(data.sessionId);
    client.emit('acp:stopped', { sessionId: data.sessionId, reason: 'user_close' });
  });
  // 真实控制器每 30s 心跳续期 `session:<keyId>`（TTL 90s）；本套用例单 fake 跑满全程，必须保活
  const heartbeat = setInterval(() => {
    if (client.connected) client.emit('heartbeat');
  }, 30_000);
  client.on('disconnect', () => clearInterval(heartbeat));

  const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
  client.emit('register', {
    key: rawKey,
    hostname: `wfr-${tag}-host`,
    version: '2.0.0',
    homeDir: '/home/fake',
    platform: 'linux',
  });
  const regData = await registered;
  return { client, controllerId: regData.controllerId, starts, resumes, stops };
}

async function refreshCapabilities(token: string, controllerId: string): Promise<string[]> {
  const res = await gqlRequest(REFRESH_ACP_CAPABILITIES, { controllerId }, token);
  const body = await res.json();
  expect(body.errors).toBeUndefined();
  return (body.data.refreshAcpCapabilities as { type: string; available: boolean }[])
    .filter((s) => s.available)
    .map((s) => s.type);
}

async function createWorkspace(token: string, controllerId: string): Promise<string> {
  const path = `/tmp/wfr-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const res = await gqlRequest(CREATE_WORKSPACE, { input: { controllerId, path } }, token);
  const body = await res.json();
  if (body.errors) throw new Error(`createWorkspace failed: ${JSON.stringify(body.errors)}`);
  return body.data.createWorkspace.id;
}

/** 简单两节点模板：HUMAN(input) → AI(exec) */
function simpleTemplateInput(name: string) {
  return {
    name,
    description: 'API 测试用简单两节点工作流',
    nodes: [
      { nodeKey: 'input', type: 'HUMAN', name: '需求输入', stage: '阶段一', dependsOn: [], requiresWorktree: false },
      {
        nodeKey: 'exec',
        type: 'AI',
        name: 'AI执行',
        stage: '阶段一',
        prompts: ['阅读上游产物并完成执行'],
        artifactTitles: ['执行结果'],
        dependsOn: ['input'],
        requiresWorktree: false,
      },
    ],
  };
}

/** 模拟 agent-controller 经主 WebSocket relay 调用平台工作流 MCP 工具 */
async function callWorkflowTool(
  socket: ClientSocket,
  sessionId: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ httpStatus: number; body: Record<string, any> }> {
  const requestId = `mcpreq_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP relay timeout for ${name}`)), 15000);
    const onResponse = (data: { requestId: string; status: number; body: Record<string, any> }) => {
      if (data.requestId !== requestId) return;
      clearTimeout(timer);
      socket.off('mcp:response', onResponse);
      resolve({ httpStatus: data.status, body: data.body });
    };
    socket.on('mcp:response', onResponse);
    socket.emit('mcp:request', {
      requestId,
      sessionId,
      serverName: 'agent-workflow-tools',
      token,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    });
  });
}

function parseToolResult(body: Record<string, any>): { isError: boolean; data: Record<string, any> } {
  expect(body.error).toBeUndefined();
  const result = body.result;
  expect(result?.content?.[0]?.text).toBeDefined();
  return { isError: Boolean(result.isError), data: JSON.parse(result.content[0].text) };
}

async function getInstance(token: string, id: string) {
  const res = await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id }, token);
  const body = await res.json();
  expect(body.errors).toBeUndefined();
  return body.data.workflowInstance as {
    id: string;
    nodes: Array<{
      id: string;
      nodeKey: string;
      status: string;
      sessionId: string | null;
      retryCount: number;
      nextRetryAt: string | null;
      failInfo: { reason: string; source: string } | null;
    }>;
  };
}

async function getSessionMessagesText(token: string, sessionId: string): Promise<string[]> {
  const res = await gqlRequest(SESSION_MESSAGES_QUERY, { sessionId }, token);
  const body = await res.json();
  expect(body.errors).toBeUndefined();
  return (body.data.sessionMessages as { content: unknown }[]).map((m) =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  );
}

function workflowInstances() {
  return mongoose.connection.db!.collection('workflowinstances');
}

/** 直连 Mongo 预置节点重试字段（退避窗口不可真实等待） */
async function patchNode(
  instanceId: string,
  nodeId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) set[`nodes.$[n].${key}`] = value;
  await workflowInstances().updateOne(
    { _id: new mongoose.Types.ObjectId(instanceId) },
    { $set: set },
    { arrayFilters: [{ 'n.nodeId': nodeId }] },
  );
}

describe.skipIf(!HAS_MONGO)('Workflow Node Interrupt Retry API (T-WFIR1~9)', () => {
  let token = '';
  let fake: Awaited<ReturnType<typeof registerFakeController>>;
  let workspaceId = '';

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(MONGODB_URI);
    const { token: t } = await createFrontUser();
    token = t;
    fake = await registerFakeController(token, 'retry');
    const available = await refreshCapabilities(token, fake.controllerId);
    expect(available).toContain('opencode');
    workspaceId = await createWorkspace(token, fake.controllerId);
  }, 60_000);

  afterAll(async () => {
    fake?.client.disconnect();
    await mongoose.disconnect().catch(() => undefined);
    redis.disconnect();
  });

  async function createInstance(tag: string) {
    const tplRes = await gqlRequest(CREATE_WORKFLOW_TEMPLATE, { input: simpleTemplateInput(`wf-${tag}-${Date.now()}`) }, token);
    const tplBody = await tplRes.json();
    expect(tplBody.errors).toBeUndefined();
    const tplId = tplBody.data.createWorkflowTemplate.id;

    const cfgRes = await gqlRequest(CONFIGURE_WORKFLOW, {
      templateId: tplId,
      input: {
        name: `wf-${tag}-cfg-${Date.now()}`,
        controllerId: fake.controllerId,
        nodes: simpleTemplateInput('_').nodes.map((node) => ({
          ...node,
          agentConfig: node.type === 'AI' ? { acpServerType: 'opencode', initNewWorktree: false } : null,
        })),
      },
    }, token);
    const cfgBody = await cfgRes.json();
    expect(cfgBody.errors).toBeUndefined();
    const cfgId = cfgBody.data.configureWorkflow.id;

    const instRes = await gqlRequest(INSTANTIATE_WORKFLOW, {
      input: {
        source: 'CONFIGURED',
        configuredWorkflowId: cfgId,
        controllerId: fake.controllerId,
        workspaceId,
        name: `wf-${tag}-实例-${Date.now()}`,
        nodes: simpleTemplateInput('_').nodes.map((node) => ({
          ...node,
          agentConfig: node.type === 'AI' ? { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: false } : null,
        })),
      },
    }, token);
    const instBody = await instRes.json();
    expect(instBody.errors).toBeUndefined();
    return instBody.data.instantiateWorkflow as { id: string; nodes: Array<{ id: string; nodeKey: string }> };
  }

  /** 推进到 AI 节点会话已启动（返回 instanceId/nodeId/sessionId/mcpToken） */
  async function advanceToExecRunning(tag: string) {
    const inst = await createInstance(tag);
    const inputNode = inst.nodes.find((n) => n.nodeKey === 'input')!;
    const startEvent = waitForEvent<StartEventData>(fake.client, 'acp:start', 15000);
    await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId: inst.id, nodeId: inputNode.id, input: '做一个计算器' }, token);
    const start = await startEvent;
    await sleep(500);
    const execNode = (await getInstance(token, inst.id)).nodes.find((n) => n.nodeKey === 'exec')!;
    return {
      instanceId: inst.id,
      nodeId: execNode.id,
      sessionId: start.sessionId,
      mcpToken: start.mcpEndpoint!.token,
    };
  }

  it('T-WFIR1: workflowInstance 透出 retryCount=0 / nextRetryAt=null', async () => {
    const { instanceId } = await advanceToExecRunning('wfir1');
    const inst = await getInstance(token, instanceId);
    const exec = inst.nodes.find((n) => n.nodeKey === 'exec')!;
    expect(exec.retryCount).toBe(0);
    expect(exec.nextRetryAt).toBeNull();
  }, 60_000);

  /** 模拟 controller-api 上报 `session:status`（意外结束等由控制器直接写库并 publish） */
  async function publishSessionStatus(sessionId: string, status: string, error?: string): Promise<void> {
    await redis.publish('session:status', JSON.stringify({ sessionId, status, ...(error ? { error } : {}) }));
  }

  /** 直接写 sessions.status（模拟 controller-api 在 Agent 异常退出时先落库再 publish） */
  async function setSessionStatusInDb(sessionId: string, status: string): Promise<void> {
    await mongoose.connection.db!.collection('sessions').updateOne(
      { _id: new mongoose.Types.ObjectId(sessionId) },
      { $set: { status, ...(status === 'ended' ? { endedAt: new Date() } : {}) } },
    );
  }

  function countResumes(sessionId: string): number {
    return fake.resumes.filter((r) => r.sessionId === sessionId).length;
  }

  function countStops(sessionId: string): number {
    return fake.stops.filter((s) => s === sessionId).length;
  }

  function promptCount(messages: string[]): number {
    return messages.filter((m) => m.includes('系统检测到会话已结束') || m.includes('系统检测到本轮执行已停止')).length;
  }

  it('T-WFIR2: controller 上报 ended（会话未落库结束）→ 管线 close（acp:stop）+ resume + FALLBACK_PROMPT', async () => {
    const { instanceId, sessionId } = await advanceToExecRunning('wfir2');
    const beforeResumes = countResumes(sessionId);
    const beforeStops = countStops(sessionId);

    // 计划口径：publish session:status ended 触发自动重试（此时 DB 仍为 idling → 管线必须自行 close）
    await publishSessionStatus(sessionId, 'ended');

    await waitFor(
      async () => (countResumes(sessionId) > beforeResumes ? true : undefined),
      20_000,
      'retry acp:resume',
    );
    // acp:stop 来自重试管线的 close 步骤（本用例未调用 closeSession，任何 stop 都只能来自管线）
    expect(countStops(sessionId)).toBeGreaterThan(beforeStops);

    const fallback = await waitFor(
      async () => {
        const messages = await getSessionMessagesText(token, sessionId);
        return messages.find((m) => m.includes('系统检测到会话已结束') && m.includes('completeCurrentNode'));
      },
      20_000,
      'fallback prompt',
    );
    expect(fallback).toContain('completeCurrentNode');

    const exec = await waitFor(
      async () => {
        const inst = await getInstance(token, instanceId);
        const node = inst.nodes.find((n) => n.nodeKey === 'exec')!;
        return node.retryCount === 1 && node.nextRetryAt === null ? node : undefined;
      },
      20_000,
      'retryCount=1 & schedule cleared',
    );
    expect(exec.status).toBe('RUNNING');
  }, 90_000);

  it('T-WFIR2b: Agent 异常退出（控制器先落库 ended 再 publish）→ 跳过 close 直接 resume 恢复', async () => {
    const { instanceId, sessionId } = await advanceToExecRunning('wfir2b');
    const beforeResumes = countResumes(sessionId);
    const beforeStops = countStops(sessionId);

    await setSessionStatusInDb(sessionId, 'ended');
    await publishSessionStatus(sessionId, 'ended');

    await waitFor(
      async () => (countResumes(sessionId) > beforeResumes ? true : undefined),
      20_000,
      'abnormal-exit retry resume',
    );
    // 会话已 ended：PRD 3.2.2 要求跳过关闭步骤（不再产生新的 acp:stop）
    expect(countStops(sessionId)).toBe(beforeStops);
    const fallback = await waitFor(
      async () => {
        const messages = await getSessionMessagesText(token, sessionId);
        return messages.find((m) => m.includes('系统检测到会话已结束'));
      },
      20_000,
      'abnormal-exit fallback prompt',
    );
    expect(fallback).toContain('completeCurrentNode');

    const exec = await waitFor(
      async () => {
        const inst = await getInstance(token, instanceId);
        const node = inst.nodes.find((n) => n.nodeKey === 'exec')!;
        return node.retryCount === 1 && node.nextRetryAt === null ? node : undefined;
      },
      20_000,
      'abnormal-exit retryCount=1',
    );
    expect(exec.status).toBe('RUNNING');
  }, 90_000);

  it('T-WFIR2c: closeSession 与控制器 ended 双投递 → 去重只计 1 次重试', async () => {
    const { instanceId, sessionId } = await advanceToExecRunning('wfir2c');

    // 人工关闭：close() 回调 + 控制器 ended 事件都会触发处理，排期 CAS 只允许一个赢家
    await gqlRequest(CLOSE_SESSION, { id: sessionId }, token);
    await waitFor(
      async () => (countResumes(sessionId) > 0 ? true : undefined),
      20_000,
      'dedupe retry resume',
    );
    await sleep(1_500);
    const inst = await getInstance(token, instanceId);
    const exec = inst.nodes.find((n) => n.nodeKey === 'exec')!;
    expect(exec.retryCount).toBe(1);
  }, 90_000);

  it('T-WFIR3: 再次 ended → retryCount=2、nextRetryAt 为未来 1 分钟且不再立即 resume', async () => {
    const { instanceId, sessionId } = await advanceToExecRunning('wfir3');

    // 第一次：立即重试（完成一次 episode）
    await publishSessionStatus(sessionId, 'ended');
    await waitFor(
      async () => {
        const node = (await getInstance(token, instanceId)).nodes.find((n) => n.nodeKey === 'exec')!;
        return node.retryCount === 1 && node.nextRetryAt === null ? true : undefined;
      },
      25_000,
      'first retry done',
    );

    const resumesAfterFirst = countResumes(sessionId);
    // 第二次：排到 1 分钟后，不立刻 resume
    await publishSessionStatus(sessionId, 'ended');
    const node = await waitFor(
      async () => {
        const n = (await getInstance(token, instanceId)).nodes.find((x) => x.nodeKey === 'exec')!;
        return n.retryCount === 2 ? n : undefined;
      },
      15_000,
      'retryCount=2',
    );
    expect(node.nextRetryAt).toBeTruthy();
    const delayMs = new Date(node.nextRetryAt!).getTime() - Date.now();
    expect(delayMs).toBeGreaterThan(30_000);
    expect(delayMs).toBeLessThanOrEqual(61_000);
    await sleep(1_500);
    // 只对本会话计数：其他用例遗留排期可能补发 resume，不能影响本断言
    expect(countResumes(sessionId)).toBe(resumesAfterFirst);
    expect(resumesAfterFirst).toBeGreaterThan(0);
  }, 90_000);

  it('T-WFIR4: retryCount=10 → retryExhausted（RETRY_FAILED）+ 人工介入待办，不再 resume', async () => {
    const { instanceId, nodeId, sessionId } = await advanceToExecRunning('wfir4');
    await patchNode(instanceId, nodeId, { retryCount: 10 });
    const beforeResumes = countResumes(sessionId);

    await publishSessionStatus(sessionId, 'ended');

    const node = await waitFor(
      async () => {
        const n = (await getInstance(token, instanceId)).nodes.find((x) => x.nodeKey === 'exec')!;
        return n.status === 'RETRY_FAILED' ? n : undefined;
      },
      20_000,
      'RETRY_FAILED',
    );
    expect(node.failInfo).toMatchObject({ source: 'RETRY_EXHAUSTED' });
    expect(node.retryCount).toBe(10);

    const todoRes = await gqlRequest(TODO_LIST_QUERY, undefined, token);
    const todos = (await todoRes.json()).data.getTodoList as Array<{ type: string; priority: string }>;
    const intervention = todos.find((t) => t.type === 'workflow_intervention');
    expect(intervention?.priority).toBe('immediate');

    await sleep(1_500);
    expect(countResumes(sessionId)).toBe(beforeResumes);
  }, 90_000);

  it('T-WFIR5: restartNode 于 RETRY_FAILED → RUNNING、retryCount=0、拉起新会话', async () => {
    const { instanceId, nodeId, sessionId } = await advanceToExecRunning('wfir5');
    await patchNode(instanceId, nodeId, {
      status: 'RETRY_FAILED',
      retryCount: 10,
      failInfo: { reason: '中断自动重试 10 次仍未推进', source: 'RETRY_EXHAUSTED', at: new Date() },
    });

    const startEvent = waitForEvent<StartEventData>(fake.client, 'acp:start', 20_000);
    const res = await gqlRequest(RESTART_NODE, { instanceId, nodeId }, token);
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.restartNode.status).toBe('RUNNING');
    const started = await startEvent;
    expect(started.sessionId).not.toBe(sessionId);

    const node = await waitFor(
      async () => {
        const n = (await getInstance(token, instanceId)).nodes.find((x) => x.nodeKey === 'exec')!;
        return n.status === 'RUNNING' && n.retryCount === 0 ? n : undefined;
      },
      20_000,
      'restart node reset',
    );
    expect(node.failInfo).toBeNull();
  }, 90_000);

  it('T-WFIR6: 预置 SCHEDULED + 到期 → 30s 内扫描 A 执行管线', async () => {
    const { instanceId, nodeId, sessionId } = await advanceToExecRunning('wfir6');
    const beforeResumes = fake.resumes.filter((r) => r.sessionId === sessionId).length;
    await patchNode(instanceId, nodeId, {
      retryCount: 1,
      retryPhase: 'SCHEDULED',
      retryTrigger: 'ENDED',
      nextRetryAt: new Date(Date.now() - 1_000),
    });

    await waitFor(
      async () => (fake.resumes.filter((r) => r.sessionId === sessionId).length > beforeResumes ? true : undefined),
      45_000,
      'scan A retry resume',
    );
    await waitFor(
      async () => {
        const n = (await getInstance(token, instanceId)).nodes.find((x) => x.nodeKey === 'exec')!;
        return n.retryCount === 1 && n.nextRetryAt === null ? true : undefined;
      },
      30_000,
      'scan A cleared schedule',
    );
  }, 120_000);

  it('T-WFIR7: 预置 RECONNECTING + deadline 过期 → 扫描 B 重排（retryCount+1 / nextRetryAt 未来 / 无重复提示词）', async () => {
    const { instanceId, nodeId, sessionId } = await advanceToExecRunning('wfir7');
    const resumesBefore = countResumes(sessionId);
    const promptsBefore = promptCount(await getSessionMessagesText(token, sessionId));
    await patchNode(instanceId, nodeId, {
      retryCount: 1,
      retryPhase: 'RECONNECTING',
      retryDeadlineAt: new Date(Date.now() - 1_000),
      nextRetryAt: new Date(Date.now() - 120_000),
    });

    const node = await waitFor(
      async () => {
        const n = (await getInstance(token, instanceId)).nodes.find((x) => x.nodeKey === 'exec')!;
        return n.retryCount === 2 ? n : undefined;
      },
      45_000,
      'scan B reschedule',
    );
    expect(node.nextRetryAt).toBeTruthy();
    expect(new Date(node.nextRetryAt!).getTime()).toBeGreaterThan(Date.now());

    // 重排路径只重新排队，不得补发 FALLBACK/IDLE_NUDGE，也不得 resume
    await sleep(1_500);
    expect(countResumes(sessionId)).toBe(resumesBefore);
    expect(promptCount(await getSessionMessagesText(token, sessionId))).toBe(promptsBefore);
  }, 120_000);

  it('T-WFIR8: deletedAt 非空的实例 → 扫描不执行、无 acp:resume', async () => {
    const { instanceId, nodeId, sessionId } = await advanceToExecRunning('wfir8');
    const beforeResumes = fake.resumes.filter((r) => r.sessionId === sessionId).length;
    await patchNode(instanceId, nodeId, {
      retryCount: 1,
      retryPhase: 'SCHEDULED',
      nextRetryAt: new Date(Date.now() - 1_000),
    });
    await workflowInstances().updateOne(
      { _id: new mongoose.Types.ObjectId(instanceId) },
      { $set: { deletedAt: new Date() } },
    );

    await sleep(35_000);
    expect(fake.resumes.filter((r) => r.sessionId === sessionId).length).toBe(beforeResumes);
  }, 120_000);

  it('T-WFIR9: resumeFailedNode（MCP）于 RETRY_FAILED → RUNNING、retryCount=0、failInfo=null', async () => {
    const { instanceId, nodeId, sessionId, mcpToken } = await advanceToExecRunning('wfir9');
    await patchNode(instanceId, nodeId, {
      status: 'RETRY_FAILED',
      retryCount: 10,
      failInfo: { reason: '中断自动重试 10 次仍未推进', source: 'RETRY_EXHAUSTED', at: new Date() },
    });

    const result = parseToolResult(
      (await callWorkflowTool(fake.client, sessionId, mcpToken, 'resumeFailedNode', {})).body,
    );
    expect(result.isError).toBe(false);
    expect(result.data.status).toBe('RUNNING');

    const node = (await getInstance(token, instanceId)).nodes.find((n) => n.nodeKey === 'exec')!;
    expect(node.status).toBe('RUNNING');
    expect(node.retryCount).toBe(0);
    expect(node.failInfo).toBeNull();
  }, 60_000);
});
