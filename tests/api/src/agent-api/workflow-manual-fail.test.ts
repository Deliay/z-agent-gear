import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';
import mongoose from 'mongoose';
import { createFrontUser } from '../support/front-users.js';

/**
 * 工作流节点「立即失败」—— API 用例 T-MNF-API1 ~ T-MNF-API3。
 *
 * 前置：`aspire start`（agent-api + controller-api 就绪）+ `MONGODB_URI`
 * （直写节点重试字段 / 控制器离线 / DB 复核）。fake controller 应答
 * `acp:check` / `acp:start` / `acp:resume` / `acp:stop`。
 */
const AGENT_API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273';
const MONGODB_URI = process.env.MONGODB_URI ?? '';

const HAS_MONGO = Boolean(MONGODB_URI);

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

const INSTANTIATE_WORKFLOW = `
  mutation InstantiateWorkflow($input: InstantiateWorkflowInput!) {
    instantiateWorkflow(input: $input) {
      id name
      nodes { id nodeKey type name status }
    }
  }
`;

const COMPLETE_HUMAN_NODE = `
  mutation CompleteHumanNode($instanceId: ID!, $nodeId: ID!, $input: String) {
    completeHumanNode(instanceId: $instanceId, nodeId: $nodeId, input: $input) { id nodeKey name status }
  }
`;

const FAIL_NODE = `
  mutation FailNode($instanceId: ID!, $nodeId: ID!, $reason: String) {
    failNode(instanceId: $instanceId, nodeId: $nodeId, reason: $reason) {
      id nodeKey name status retryCount nextRetryAt retryPhase
      failInfo { reason source at }
    }
  }
`;

const WORKFLOW_INSTANCE_QUERY = `
  query WorkflowInstance($id: ID!) {
    workflowInstance(id: $id) {
      id name currentNodeNames
      nodes { id nodeKey name status sessionId retryCount nextRetryAt retryPhase failInfo { reason source at } }
    }
  }
`;

const SESSION_MESSAGES_QUERY = `
  query SessionMessages($sessionId: ID!) {
    sessionMessages(sessionId: $sessionId, limit: 100) { id direction type content }
  }
`;

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
async function registerFakeController(token: string, tag: string) {
  const keyRes = await gqlRequest(CREATE_KEY, { input: { name: `wmf-${tag}-${Date.now()}`, type: 'local' } }, token);
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
  const heartbeat = setInterval(() => {
    if (client.connected) client.emit('heartbeat');
  }, 30_000);
  client.on('disconnect', () => clearInterval(heartbeat));

  const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
  client.emit('register', {
    key: rawKey,
    hostname: `wmf-${tag}-host`,
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
  const path = `/tmp/wmf-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const res = await gqlRequest(CREATE_WORKSPACE, { input: { controllerId, path } }, token);
  const body = await res.json();
  if (body.errors) throw new Error(`createWorkspace failed: ${JSON.stringify(body.errors)}`);
  return body.data.createWorkspace.id;
}

/** 三节点线性图：HUMAN(input) → AI(exec) → AI(after)，下游用于「保持等待」断言 */
function blankNodes() {
  return [
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
      agentConfig: { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: false },
    },
    {
      nodeKey: 'after',
      type: 'AI',
      name: 'AI收尾',
      stage: '阶段二',
      prompts: ['根据执行结果收尾'],
      artifactTitles: ['收尾结果'],
      dependsOn: ['exec'],
      requiresWorktree: false,
      agentConfig: { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: false },
    },
  ];
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
      name: string;
      status: string;
      sessionId: string | null;
      retryCount: number;
      nextRetryAt: string | null;
      retryPhase: string | null;
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

/** 模拟 agent-controller 经主 WebSocket relay 调用平台工作流 MCP 工具 */
async function callWorkflowTool(
  socket: ClientSocket,
  sessionId: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; data: Record<string, any> }> {
  const requestId = `mcpreq_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const body = await new Promise<Record<string, any>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP relay timeout for ${name}`)), 15000);
    const onResponse = (data: { requestId: string; status: number; body: Record<string, any> }) => {
      if (data.requestId !== requestId) return;
      clearTimeout(timer);
      socket.off('mcp:response', onResponse);
      resolve(data.body);
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
  expect(body.error).toBeUndefined();
  const result = body.result;
  expect(result?.content?.[0]?.text).toBeDefined();
  return { isError: Boolean(result.isError), data: JSON.parse(result.content[0].text) };
}

describe.skipIf(!HAS_MONGO)('Workflow Node Manual Fail API (T-MNF-API1~3)', () => {
  let token = '';
  let fake: Awaited<ReturnType<typeof registerFakeController>>;
  let workspaceId = '';

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(MONGODB_URI);
    const { token: t } = await createFrontUser();
    token = t;
    fake = await registerFakeController(token, 'manual-fail');
    const available = await refreshCapabilities(token, fake.controllerId);
    expect(available).toContain('opencode');
    workspaceId = await createWorkspace(token, fake.controllerId);
  }, 60_000);

  afterAll(async () => {
    fake?.client.disconnect();
    await mongoose.disconnect().catch(() => undefined);
  });

  async function createInstance(tag: string) {
    const res = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      {
        input: {
          source: 'BLANK',
          controllerId: fake.controllerId,
          workspaceId,
          name: `wmf-${tag}-实例-${Date.now()}`,
          nodes: blankNodes(),
          createWorkflowWorktree: false,
        },
      },
      token,
    );
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    return body.data.instantiateWorkflow as {
      id: string;
      nodes: Array<{ id: string; nodeKey: string; type: string; status: string }>;
    };
  }

  /** 推进到 AI exec 节点会话已启动（返回 instanceId/nodeId/afterNodeId/sessionId/mcpToken） */
  async function advanceToExecRunning(tag: string) {
    const inst = await createInstance(tag);
    const inputNode = inst.nodes.find((n) => n.nodeKey === 'input')!;
    const afterNode = inst.nodes.find((n) => n.nodeKey === 'after')!;
    const startEvent = waitForEvent<StartEventData>(fake.client, 'acp:start', 15000);
    await gqlRequest(
      COMPLETE_HUMAN_NODE,
      { instanceId: inst.id, nodeId: inputNode.id, input: '做一个计算器' },
      token,
    );
    const start = await startEvent;
    await sleep(500);
    const execNode = (await getInstance(token, inst.id)).nodes.find((n) => n.nodeKey === 'exec')!;
    expect(execNode.status).toBe('RUNNING');
    return {
      instanceId: inst.id,
      nodeId: execNode.id,
      afterNodeId: afterNode.id,
      sessionId: start.sessionId,
      mcpToken: start.mcpEndpoint!.token,
    };
  }

  function countResumes(sessionId: string): number {
    return fake.resumes.filter((r) => r.sessionId === sessionId).length;
  }

  it('T-MNF-API1 全链路：failNode → FAILED(MANUAL)、重试字段清空、fake 收到 stop、DB 复核', async () => {
    const { instanceId, nodeId, afterNodeId, sessionId } = await advanceToExecRunning('api1');
    const stopBefore = fake.stops.filter((s) => s === sessionId).length;

    const res = await gqlRequest(FAIL_NODE, { instanceId, nodeId }, token);
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.failNode).toMatchObject({
      status: 'FAILED',
      retryCount: 0,
      nextRetryAt: null,
      failInfo: { source: 'MANUAL', reason: '人工标记失败' },
    });

    // fake controller 收到会话停止
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const timer = setInterval(() => {
        if (fake.stops.filter((s) => s === sessionId).length > stopBefore) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error('timeout waiting acp:stop'));
        }
      }, 200);
    });

    // GraphQL 复核：节点 FAILED、来源 MANUAL、下游保持等待
    const inst = await getInstance(token, instanceId);
    const exec = inst.nodes.find((n) => n.nodeKey === 'exec')!;
    expect(exec.status).toBe('FAILED');
    expect(exec.failInfo).toMatchObject({ source: 'MANUAL', reason: '人工标记失败' });
    expect(exec.nextRetryAt).toBeNull();
    expect(exec.retryPhase).toBeNull();
    const after = inst.nodes.find((n) => n.nodeKey === 'after')!;
    expect(after.status).toBe('INITIALIZING');
    expect(after.id).toBe(afterNodeId);

    // 直读 DB 复核
    const doc = await workflowInstances().findOne({ _id: new mongoose.Types.ObjectId(instanceId) });
    const dbNode = (doc!.nodes as Array<Record<string, any>>).find((n) => n.nodeId === nodeId)!;
    expect(dbNode.status).toBe('FAILED');
    expect(dbNode.failInfo).toMatchObject({ source: 'MANUAL' });
  }, 90_000);

  it('T-MNF-API2 拒绝矩阵逐字透出（他人/HUMAN/DONE/控制器离线）', async () => {
    const { instanceId, nodeId } = await advanceToExecRunning('api2');

    // 他人实例
    const { token: otherToken } = await createFrontUser();
    const other = await gqlRequest(FAIL_NODE, { instanceId, nodeId }, otherToken);
    const otherBody = await other.json();
    expect(otherBody.errors?.[0]?.message).toBe('工作流实例不存在或无权限');

    // HUMAN 节点
    const inst = await getInstance(token, instanceId);
    const humanNode = inst.nodes.find((n) => n.nodeKey === 'input')!;
    const humanRes = await gqlRequest(FAIL_NODE, { instanceId, nodeId: humanNode.id }, token);
    expect((await humanRes.json()).errors?.[0]?.message).toBe('仅 AI 节点支持立即失败');

    // DONE 节点：先由 AI 调 completeCurrentNode 完成 exec，再 failNode → 引擎状态机拒绝文案
    const { instanceId: doneInstanceId, nodeId: doneNodeId, mcpToken } =
      await advanceToExecRunning('api2-done');
    const completed = await callWorkflowTool(fake.client, (await getInstance(token, doneInstanceId)).nodes.find((n) => n.nodeKey === 'exec')!.sessionId!, mcpToken, 'completeCurrentNode', {
      artifacts: [{ title: '执行结果', value: '已完成' }],
    });
    expect(completed.isError).toBe(false);
    await sleep(500);
    const doneRes = await gqlRequest(FAIL_NODE, { instanceId: doneInstanceId, nodeId: doneNodeId }, token);
    expect((await doneRes.json()).errors?.[0]?.message).toBe(
      '节点「AI执行」当前状态为 DONE，不允许执行「标记失败」（fail）',
    );

    // 控制器离线（直写 DB）→ 不可用文案
    await mongoose.connection.db!.collection('controllers').updateOne(
      { _id: new mongoose.Types.ObjectId(fake.controllerId) },
      { $set: { status: 'offline' } },
    );
    const offlineRes = await gqlRequest(FAIL_NODE, { instanceId, nodeId }, token);
    expect((await offlineRes.json()).errors?.[0]?.message).toBe(
      '工作流实例不可用（控制器离线或已删除），请先接续后再操作',
    );
    await mongoose.connection.db!.collection('controllers').updateOne(
      { _id: new mongoose.Types.ObjectId(fake.controllerId) },
      { $set: { status: 'online' } },
    );
  }, 120_000);

  it('T-MNF-API3 重试短路：已排期节点 failNode 后不再发生任何自动重试', async () => {
    const { instanceId, nodeId, sessionId } = await advanceToExecRunning('api3');
    // 预置「已排期」：SCHEDULED + nextRetryAt 过去时刻 + retryCount=3
    await patchNode(instanceId, nodeId, {
      retryCount: 3,
      retryPhase: 'SCHEDULED',
      nextRetryAt: new Date(Date.now() - 1000),
      retryTrigger: 'ENDED',
    });

    const resumesBefore = countResumes(sessionId);
    const messagesBefore = (await getSessionMessagesText(token, sessionId)).length;

    const res = await gqlRequest(FAIL_NODE, { instanceId, nodeId }, token);
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.failNode).toMatchObject({ status: 'FAILED', retryCount: 3, nextRetryAt: null });

    // 等待 > 1 个扫描周期（30s）
    await sleep(35_000);

    expect(countResumes(sessionId)).toBe(resumesBefore);
    const messagesAfter = await getSessionMessagesText(token, sessionId);
    expect(messagesAfter.length).toBe(messagesBefore);
    expect(messagesAfter.some((m) => m.includes('系统检测到会话已结束'))).toBe(false);

    const inst = await getInstance(token, instanceId);
    const exec = inst.nodes.find((n) => n.nodeKey === 'exec')!;
    expect(exec.status).toBe('FAILED');
    expect(exec.retryCount).toBe(3);
    expect(exec.nextRetryAt).toBeNull();
    expect(exec.retryPhase).toBeNull();
  }, 120_000);
});
