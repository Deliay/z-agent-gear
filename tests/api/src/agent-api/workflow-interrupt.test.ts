import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';
import Redis from 'ioredis';
import mongoose from 'mongoose';
import { createFrontUser } from '../support/front-users.js';

/**
 * 工作流支持打断 —— API 用例 T-WI-API1 ~ T-WI-API3。
 *
 * 前置：aspire start（agent-api + controller-api 就绪）+ MONGODB_URI（直连断言 failInfo/retryCount/待办）；
 * fake controller 应答 acp:check/acp:start/acp:stop。
 * 无 MONGODB_URI 时整组 skip（与既有 workflow-interrupt-retry 套件同口径）。
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

const INTERRUPT_NODE = `
  mutation InterruptNode($instanceId: ID!, $nodeId: ID!) {
    interruptNode(instanceId: $instanceId, nodeId: $nodeId) { id status failInfo { reason source at } }
  }
`;

const RESTART_NODE = `
  mutation RestartNode($instanceId: ID!, $nodeId: ID!) {
    restartNode(instanceId: $instanceId, nodeId: $nodeId) { id status retryCount nextRetryAt failInfo { reason source } }
  }
`;

const WORKFLOW_INSTANCE_QUERY = `
  query WorkflowInstance($id: ID!) {
    workflowInstance(id: $id) {
      id name currentNodeNames
      nodes { id nodeKey name status sessionId retryCount nextRetryAt failInfo { reason source at } }
    }
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

/** 注册 fake controller：自动应答 acp:start / acp:stop（ack），并记录事件 */
async function registerFakeController(token: string, tag: string): Promise<FakeController & {
  starts: StartEventData[];
  stops: string[];
}> {
  const keyRes = await gqlRequest(CREATE_KEY, { input: { name: `wi-${tag}-${Date.now()}`, type: 'local' } }, token);
  const rawKey = (await keyRes.json()).data.createControllerKey.rawKey;

  const client = createClient();
  const starts: StartEventData[] = [];
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
  client.on('acp:start', (data: StartEventData) => {
    starts.push(data);
    client.emit('acp:start:result', {
      requestId: data.requestId,
      sessionId: data.sessionId,
      success: true,
      externalSessionId: `ext_${tag}_${data.sessionId}`,
    });
  });
  client.on('acp:stop', (data: { sessionId: string }) => {
    stops.push(data.sessionId);
    client.emit('acp:stopped', { sessionId: data.sessionId, reason: 'user_close' });
  });
  const heartbeat = setInterval(() => {
    if (client.connected) client.emit('heartbeat');
  }, 30_000);
  client.on('disconnect', () => clearInterval(heartbeat));

  const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
  client.emit('register', {
    key: rawKey,
    hostname: `wi-${tag}-host`,
    version: '2.0.0',
    homeDir: '/home/fake',
    platform: 'linux',
  });
  const regData = await registered;
  return { client, controllerId: regData.controllerId, starts, stops };
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
  const path = `/tmp/wi-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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

function workflowInstances() {
  return mongoose.connection.db!.collection('workflowinstances');
}

function todoItems() {
  return mongoose.connection.db!.collection('todoitems');
}

describe.skipIf(!HAS_MONGO)('Workflow Interrupt API (T-WI-API1~3)', () => {
  let token = '';
  let fake: Awaited<ReturnType<typeof registerFakeController>>;
  let workspaceId = '';

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(MONGODB_URI);
    const { token: t } = await createFrontUser();
    token = t;
    fake = await registerFakeController(token, 'interrupt');
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

  /** 推进到 AI 节点会话已启动（返回 instanceId/nodeId/sessionId） */
  async function advanceToExecRunning(tag: string) {
    const inst = await createInstance(tag);
    const inputNode = inst.nodes.find((n) => n.nodeKey === 'input')!;
    const startEvent = waitForEvent<StartEventData>(fake.client, 'acp:start', 15000);
    await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId: inst.id, nodeId: inputNode.id, input: '做一个计算器' }, token);
    const start = await startEvent;
    await sleep(500);
    const execNode = (await getInstance(token, inst.id)).nodes.find((n) => n.nodeKey === 'exec')!;
    return { instanceId: inst.id, nodeId: execNode.id, sessionId: start.sessionId };
  }

  it('T-WI-API1: interruptNode mutation 门控——非 AI 节点 / 不可打断状态', async () => {
    const { instanceId } = await advanceToExecRunning('api1');
    const inst = await getInstance(token, instanceId);
    const inputNode = inst.nodes.find((n) => n.nodeKey === 'input')!;
    const execNode = inst.nodes.find((n) => n.nodeKey === 'exec')!;

    // 非 AI 节点（HUMAN input）→「节点不是 AI 节点会话，无法打断」
    const nonAiRes = await gqlRequest(INTERRUPT_NODE, { instanceId, nodeId: inputNode.id }, token);
    const nonAiBody = await nonAiRes.json();
    expect(nonAiBody.errors?.[0]?.message).toContain('节点不是 AI 节点会话，无法打断');

    // 不可打断状态（DONE）→「节点当前状态不允许立即打断」
    await workflowInstances().updateOne(
      { _id: new mongoose.Types.ObjectId(instanceId) },
      { $set: { 'nodes.$[n].status': 'DONE' } },
      { arrayFilters: [{ 'n.nodeId': execNode.id }] },
    );
    const doneRes = await gqlRequest(INTERRUPT_NODE, { instanceId, nodeId: execNode.id }, token);
    const doneBody = await doneRes.json();
    expect(doneBody.errors?.[0]?.message).toContain('节点当前状态不允许立即打断');
  }, 60_000);

  it('T-WI-API2: interruptNode 成功转移——RUNNING → FAILED + failInfo.source=MANUAL_INTERRUPT + retryCount 未递增 + 待办', async () => {
    const { instanceId, nodeId } = await advanceToExecRunning('api2');
    const before = (await getInstance(token, instanceId)).nodes.find((n) => n.nodeKey === 'exec')!;
    const beforeRetryCount = before.retryCount;

    const res = await gqlRequest(INTERRUPT_NODE, { instanceId, nodeId }, token);
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.interruptNode.status).toBe('FAILED');
    expect(body.data.interruptNode.failInfo.source).toBe('MANUAL_INTERRUPT');

    // DB 断言：status=FAILED、retryCount 未递增、nextRetryAt=null
    const after = await getInstance(token, instanceId);
    const exec = after.nodes.find((n) => n.nodeKey === 'exec')!;
    expect(exec.status).toBe('FAILED');
    expect(exec.retryCount).toBe(beforeRetryCount);
    expect(exec.nextRetryAt).toBeNull();
    expect(exec.failInfo?.source).toBe('MANUAL_INTERRUPT');

    // 人工介入待办创建
    const todos = await todoItems().find({ type: 'workflow_intervention' }).toArray();
    expect(todos.length).toBeGreaterThan(0);
  }, 60_000);

  it('T-WI-API3: restartNode 接受 RETRY_FAILED 来源零回归——RETRY_FAILED → RUNNING', async () => {
    const { instanceId, nodeId } = await advanceToExecRunning('api3');
    // 直连 Mongo 置 RETRY_FAILED（模拟自动重试用尽）
    await workflowInstances().updateOne(
      { _id: new mongoose.Types.ObjectId(instanceId) },
      { $set: { 'nodes.$[n].status': 'RETRY_FAILED', 'nodes.$[n].retryCount': 10, 'nodes.$[n].nextRetryAt': null } },
      { arrayFilters: [{ 'n.nodeId': nodeId }] },
    );
    // restartNode 接受 RETRY_FAILED 来源（既有 T-WFIR5 口径零回归）
    const res = await gqlRequest(RESTART_NODE, { instanceId, nodeId }, token);
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.restartNode.status).toBe('RUNNING');
  }, 60_000);
});
