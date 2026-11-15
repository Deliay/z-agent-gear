import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';
import Redis from 'ioredis';
import mongoose from 'mongoose';
import { createFrontUser } from '../support/front-users.js';

/**
 * 已实例化工作流接续 —— API 用例 T-WFC1 ~ T-WFC6。
 *
 * 前置：`aspire start`（agent-api + controller-api 就绪）+ `MONGODB_URI`（直连改控制器状态与节点快照）。
 * 控制器离线/删除不可经真实链路稳定复现，统一直连 Mongo 等价覆盖（与 T-WFIR 同口径）。
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
    createWorkflowTemplate(input: $input) { id name version }
  }
`;

const CONFIGURE_WORKFLOW = `
  mutation ConfigureWorkflow($templateId: ID!, $input: ConfigureWorkflowInput!) {
    configureWorkflow(templateId: $templateId, input: $input) { id name controllerId }
  }
`;

const INSTANTIATE_WORKFLOW = `
  mutation InstantiateWorkflow($input: InstantiateWorkflowInput!) {
    instantiateWorkflow(input: $input) {
      id name controllerId workspaceId nodes { id nodeKey type status sessionId }
    }
  }
`;

const COMPLETE_HUMAN_NODE = `
  mutation CompleteHumanNode($instanceId: ID!, $nodeId: ID!, $input: String) {
    completeHumanNode(instanceId: $instanceId, nodeId: $nodeId, input: $input) { id status }
  }
`;

const RESTART_NODE = `
  mutation RestartNode($instanceId: ID!, $nodeId: ID!) {
    restartNode(instanceId: $instanceId, nodeId: $nodeId) { id status failInfo { reason source } }
  }
`;

const CONTINUE_WORKFLOW_INSTANCE = `
  mutation ContinueWorkflowInstance($id: ID!, $input: ContinueWorkflowInstanceInput!) {
    continueWorkflowInstance(id: $id, input: $input) {
      id controllerId workspaceId workflowWorktreePath unavailableReason
      continuationHistory { fromControllerId fromWorkspaceId toControllerId toWorkspaceId at }
      nodes {
        id nodeKey type status sessionId
        agentConfig { acpServerType }
        failInfo { reason source at }
      }
    }
  }
`;

const WORKFLOW_INSTANCE_QUERY = `
  query WorkflowInstance($id: ID!) {
    workflowInstance(id: $id) {
      id controllerId workspaceId unavailableReason
      continuationHistory { fromControllerId fromWorkspaceId toControllerId toWorkspaceId at }
      nodes {
        id nodeKey type status sessionId
        agentConfig { acpServerType }
        failInfo { reason source at }
      }
    }
  }
`;

const WORKFLOW_INSTANCES_QUERY = `
  query { workflowInstances { id controllerId unavailableReason } }
`;

const HOME_OVERVIEW_QUERY = `
  query { homeOverview { workflowInstances { id controllerId unavailableReason } } }
`;

interface FakeController {
  client: ClientSocket;
  controllerId: string;
  starts: Array<{ sessionId: string; serverType?: string }>;
  worktrees: Array<{ repoPath: string; worktreePath: string; branch: string }>;
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

async function registerFakeController(
  token: string,
  tag: string,
  options: { servers?: string[]; isGitRepo?: boolean } = {},
): Promise<FakeController> {
  const { servers = ['opencode', 'kimi_code'], isGitRepo = false } = options;
  const keyRes = await gqlRequest(CREATE_KEY, { input: { name: `wfc-${tag}-${Date.now()}`, type: 'local' } }, token);
  const rawKey = (await keyRes.json()).data.createControllerKey.rawKey;

  const client = createClient();
  const starts: FakeController['starts'] = [];
  const worktrees: FakeController['worktrees'] = [];

  client.on('acp:check', (data: { requestId: string }) => {
    client.emit('acp:check:result', {
      requestId: data.requestId,
      servers: servers.map((type) => ({ type, available: true, version: '1.0.0' })),
    });
  });
  client.on('git:check', (data: { requestId: string }) => {
    client.emit('git:check:result', { requestId: data.requestId, isGitRepo });
  });
  client.on('git:worktree:list', (data: { requestId: string }) => {
    client.emit('git:worktree:list:result', { requestId: data.requestId, success: true, worktrees: [] });
  });
  client.on('git:worktree:add', (data: { requestId: string; repoPath: string; worktreePath: string; branch: string }) => {
    worktrees.push({ repoPath: data.repoPath, worktreePath: data.worktreePath, branch: data.branch });
    client.emit('git:worktree:add:result', {
      requestId: data.requestId,
      success: true,
      worktreePath: data.worktreePath,
    });
  });
  client.on('git:worktree:remove', (data: { requestId: string }) => {
    client.emit('git:worktree:remove:result', { requestId: data.requestId, success: true });
  });
  client.on('acp:start', (data: { requestId: string; sessionId: string; serverType?: string }) => {
    starts.push({ sessionId: data.sessionId, serverType: data.serverType });
    client.emit('acp:start:result', {
      requestId: data.requestId,
      sessionId: data.sessionId,
      success: true,
      externalSessionId: `ext_${tag}_${data.sessionId}`,
    });
  });
  client.on('acp:resume', (data: { requestId: string; sessionId: string }) => {
    client.emit('acp:resume:result', { requestId: data.requestId, sessionId: data.sessionId, success: true });
  });
  client.on('acp:stop', (data: { sessionId: string }) => {
    client.emit('acp:stopped', { sessionId: data.sessionId, reason: 'user_close' });
  });

  const heartbeat = setInterval(() => {
    if (client.connected) client.emit('heartbeat');
  }, 30_000);
  client.on('disconnect', () => clearInterval(heartbeat));

  const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
  client.emit('register', {
    key: rawKey,
    hostname: `wfc-${tag}-host`,
    version: '2.20.0',
    homeDir: '/home/fake',
    platform: 'linux',
  });
  const regData = await registered;
  return { client, controllerId: regData.controllerId, starts, worktrees };
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
  const path = `/tmp/wfc-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const res = await gqlRequest(CREATE_WORKSPACE, { input: { controllerId, path } }, token);
  const body = await res.json();
  if (body.errors) throw new Error(`createWorkspace failed: ${JSON.stringify(body.errors)}`);
  return body.data.createWorkspace.id;
}

function twoNodeTemplate() {
  return {
    name: `wfc-tpl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    description: 'API 测试用两节点工作流',
    nodes: [
      { nodeKey: 'input', type: 'HUMAN', name: '需求输入', stage: '阶段一', dependsOn: [], requiresWorktree: false },
      {
        nodeKey: 'exec',
        type: 'AI',
        name: 'AI执行',
        stage: '阶段一',
        prompts: ['执行'],
        artifactTitles: ['执行结果'],
        dependsOn: ['input'],
        requiresWorktree: false,
      },
    ],
  };
}

async function createInstance(
  token: string,
  controllerId: string,
  workspaceId: string,
  options: { startAi?: boolean } = {},
): Promise<{ id: string; nodes: Array<{ id: string; nodeKey: string; type: string; status: string; sessionId: string | null }> }> {
  const template = twoNodeTemplate();
  const tplRes = await gqlRequest(CREATE_WORKFLOW_TEMPLATE, { input: template }, token);
  const tplBody = await tplRes.json();
  expect(tplBody.errors).toBeUndefined();

  const cfgRes = await gqlRequest(
    CONFIGURE_WORKFLOW,
    {
      templateId: tplBody.data.createWorkflowTemplate.id,
      input: {
        name: `${template.name}-cfg`,
        controllerId,
        nodes: template.nodes.map((node) => ({
          ...node,
          agentConfig: node.type === 'AI' ? { acpServerType: 'opencode', initNewWorktree: false } : null,
        })),
      },
    },
    token,
  );
  const cfgBody = await cfgRes.json();
  expect(cfgBody.errors).toBeUndefined();

  const instRes = await gqlRequest(
    INSTANTIATE_WORKFLOW,
    {
      input: {
        source: 'CONFIGURED',
        configuredWorkflowId: cfgBody.data.configureWorkflow.id,
        controllerId,
        workspaceId,
        name: `${template.name}-inst`,
        nodes: template.nodes.map((node) => ({
          ...node,
          agentConfig: node.type === 'AI' ? { acpServerType: 'opencode', initNewWorktree: false } : null,
        })),
        createWorkflowWorktree: false,
      },
    },
    token,
  );
  const instBody = await instRes.json();
  expect(instBody.errors).toBeUndefined();
  const instance = instBody.data.instantiateWorkflow;

  if (options.startAi) {
    const human = instance.nodes.find((node: { type: string }) => node.type === 'HUMAN');
    await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId: instance.id, nodeId: human.id, input: '已提交' }, token);
    return getInstance(token, instance.id);
  }
  return instance;
}

async function getInstance(token: string, id: string): Promise<{
  id: string;
  controllerId: string;
  workspaceId: string;
  unavailableReason: string | null;
  continuationHistory: Array<Record<string, string>>;
  nodes: Array<{
    id: string;
    nodeKey: string;
    type: string;
    status: string;
    sessionId: string | null;
    agentConfig: { acpServerType: string } | null;
    failInfo: { reason: string; source: string } | null;
  }>;
}> {
  const res = await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id }, token);
  const body = await res.json();
  expect(body.errors).toBeUndefined();
  return body.data.workflowInstance;
}

async function setControllerStatus(controllerId: string, status: 'online' | 'offline') {
  await mongoose.connection.db!.collection('controllers').updateOne(
    { _id: new mongoose.Types.ObjectId(controllerId) },
    { $set: { status } },
  );
}

async function takeControllerOffline(controller: FakeController) {
  controller.client.disconnect();
  await setControllerStatus(controller.controllerId, 'offline');
}

async function deleteControllerDoc(controllerId: string) {
  await mongoose.connection.db!.collection('controllers').deleteOne({
    _id: new mongoose.Types.ObjectId(controllerId),
  });
}

async function setWorkspaceDefaultBranch(workspaceId: string, defaultBranch: string) {
  await mongoose.connection.db!.collection('controllerworkspaces').updateOne(
    { _id: new mongoose.Types.ObjectId(workspaceId) },
    { $set: { defaultBranch } },
  );
}

function instancesCollection() {
  return mongoose.connection.db!.collection('workflowinstances');
}

function errorMessage(body: { errors?: Array<{ message: string }> }): string {
  return (body.errors ?? []).map((e) => e.message).join('; ');
}

describe.skipIf(!HAS_MONGO)('Workflow Instance Continuation API (T-WFC1~6)', () => {
  let token = '';
  let otherToken = '';
  let controllerA: FakeController;
  let controllerB: FakeController;
  let controllerC: FakeController;
  let workspaceA = '';
  let workspaceB = '';
  let workspaceNoGit = '';

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(MONGODB_URI);
    token = (await createFrontUser()).token;
    otherToken = (await createFrontUser()).token;

    controllerA = await registerFakeController(token, 'a');
    controllerB = await registerFakeController(token, 'b', { isGitRepo: true });
    controllerC = await registerFakeController(token, 'c', { isGitRepo: true });
    expect(await refreshCapabilities(token, controllerA.controllerId)).toContain('opencode');
    expect(await refreshCapabilities(token, controllerB.controllerId)).toContain('opencode');
    expect(await refreshCapabilities(token, controllerC.controllerId)).toContain('opencode');

    workspaceA = await createWorkspace(token, controllerA.controllerId);
    workspaceB = await createWorkspace(token, controllerB.controllerId);
    workspaceNoGit = await createWorkspace(token, controllerB.controllerId);
    await setWorkspaceDefaultBranch(workspaceB, 'main');
  }, 120_000);

  afterAll(async () => {
    controllerA?.client.disconnect();
    controllerB?.client.disconnect();
    controllerC?.client.disconnect();
    await mongoose.disconnect().catch(() => undefined);
    redis.disconnect();
  });

  it('T-WFC1 unavailableReason 透出：列表/详情/首页聚合随控制器状态实时变化', async () => {
    const instance = await createInstance(token, controllerA.controllerId, workspaceA);
    await takeControllerOffline(controllerA);

    const detail = await getInstance(token, instance.id);
    expect(detail.unavailableReason).toBe('CONTROLLER_OFFLINE');

    for (const query of [WORKFLOW_INSTANCES_QUERY, HOME_OVERVIEW_QUERY]) {
      const res = await gqlRequest(query, {}, token);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      const rows =
        body.data.workflowInstances ??
        body.data.homeOverview.workflowInstances ??
        [];
      expect(rows.find((row: { id: string }) => row.id === instance.id)?.unavailableReason).toBe(
        'CONTROLLER_OFFLINE',
      );
    }

    await deleteControllerDoc(controllerA.controllerId);
    const deleted = await getInstance(token, instance.id);
    expect(deleted.unavailableReason).toBe('CONTROLLER_DELETED');

    // 恢复 online 不可行（文档已删）：用新控制器 D 的实例验证「在线 → null」
    controllerA = await registerFakeController(token, 'a2');
    await refreshCapabilities(token, controllerA.controllerId);
    workspaceA = await createWorkspace(token, controllerA.controllerId);
    const available = await createInstance(token, controllerA.controllerId, workspaceA);
    expect((await getInstance(token, available.id)).unavailableReason).toBeNull();
  }, 90_000);

  it('T-WFC2 全链路：离线 → 接续到 B（新 Worktree/逐节点 Harness）→ FAILED 收敛 → 重启于 B 拉起新会话', async () => {
    const instance = await createInstance(token, controllerA.controllerId, workspaceA, { startAi: true });
    const aiNode = instance.nodes.find((node) => node.type === 'AI')!;
    expect(aiNode.status).toBe('RUNNING');
    expect(aiNode.sessionId).toBeTruthy();

    await takeControllerOffline(controllerA);
    const startsBefore = controllerB.starts.length;

    const res = await gqlRequest(
      CONTINUE_WORKFLOW_INSTANCE,
      {
        id: instance.id,
        input: {
          controllerId: controllerB.controllerId,
          workspaceId: workspaceB,
          createWorkflowWorktree: true,
          harnessMappings: [{ nodeId: aiNode.id, acpServerType: 'kimi_code' }],
        },
      },
      token,
    );
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    const continued = body.data.continueWorkflowInstance;

    expect(continued.controllerId).toBe(controllerB.controllerId);
    expect(continued.workspaceId).toBe(workspaceB);
    expect(continued.unavailableReason).toBeNull();
    expect(continued.continuationHistory).toHaveLength(1);
    expect(continued.continuationHistory[0]).toMatchObject({
      fromControllerId: controllerA.controllerId,
      fromWorkspaceId: workspaceA,
      toControllerId: controllerB.controllerId,
      toWorkspaceId: workspaceB,
    });
    expect(continued.workflowWorktreePath).toBeTruthy();
    expect(controllerB.worktrees.at(-1)?.repoPath).toBeTruthy();

    const continuedAi = continued.nodes.find((node: { id: string }) => node.id === aiNode.id);
    expect(continuedAi.status).toBe('FAILED');
    expect(continuedAi.failInfo?.source).toBe('CONTROLLER_UNAVAILABLE');
    expect(continuedAi.sessionId).toBeNull();
    expect(continuedAi.agentConfig?.acpServerType).toBe('kimi_code');

    // 重启节点：新控制器 B 收到 acp:start（新会话）
    const restartRes = await gqlRequest(RESTART_NODE, { instanceId: instance.id, nodeId: aiNode.id }, token);
    const restartBody = await restartRes.json();
    expect(restartBody.errors).toBeUndefined();
    expect(restartBody.data.restartNode.status).toBe('RUNNING');
    expect(controllerB.starts.length).toBeGreaterThan(startsBefore);
    expect(controllerB.starts.at(-1)?.serverType).toBe('kimi_code');
  }, 120_000);

  it('T-WFC3 校验失败矩阵经 GraphQL 逐字透出', async () => {
    const available = await createInstance(token, controllerA.controllerId, workspaceA);
    const availableRes = await gqlRequest(
      CONTINUE_WORKFLOW_INSTANCE,
      {
        id: available.id,
        input: {
          controllerId: controllerB.controllerId,
          workspaceId: workspaceB,
          createWorkflowWorktree: false,
          harnessMappings: [],
        },
      },
      token,
    );
    expect(errorMessage(await availableRes.json())).toContain('工作流实例当前可用，无需接续');

    // 他人实例
    const foreignRes = await gqlRequest(
      CONTINUE_WORKFLOW_INSTANCE,
      {
        id: available.id,
        input: {
          controllerId: controllerB.controllerId,
          workspaceId: workspaceB,
          createWorkflowWorktree: false,
          harnessMappings: [],
        },
      },
      otherToken,
    );
    expect(errorMessage(await foreignRes.json())).toContain('工作流实例不存在或无权限');

    // 已完成实例
    const finished = await createInstance(token, controllerA.controllerId, workspaceA);
    await instancesCollection().updateOne(
      { _id: new mongoose.Types.ObjectId(finished.id) },
      { $set: { finishedAt: new Date() } },
    );
    await takeControllerOffline(controllerA);
    const finishedRes = await gqlRequest(
      CONTINUE_WORKFLOW_INSTANCE,
      {
        id: finished.id,
        input: {
          controllerId: controllerB.controllerId,
          workspaceId: workspaceB,
          createWorkflowWorktree: false,
          harnessMappings: [],
        },
      },
      token,
    );
    expect(errorMessage(await finishedRes.json())).toContain('工作流实例已完成，无需接续');

    // 映射缺失：未完成 AI 节点未覆盖
    const instance = await createInstance(token, controllerA.controllerId, workspaceA);
    const aiNode = instance.nodes.find((node) => node.type === 'AI')!;
    const mappingMissing = await gqlRequest(
      CONTINUE_WORKFLOW_INSTANCE,
      {
        id: instance.id,
        input: {
          controllerId: controllerB.controllerId,
          workspaceId: workspaceB,
          createWorkflowWorktree: false,
          harnessMappings: [],
        },
      },
      token,
    );
    expect(errorMessage(await mappingMissing.json())).toContain('Harness 映射必须恰好覆盖全部未完成 AI 节点');

    // 映射包含已完成节点
    const humanNode = instance.nodes.find((node) => node.type === 'HUMAN')!;
    await instancesCollection().updateOne(
      { _id: new mongoose.Types.ObjectId(instance.id), 'nodes.nodeId': humanNode.id },
      { $set: { 'nodes.$.status': 'DONE' } },
    );
    const mappingDone = await gqlRequest(
      CONTINUE_WORKFLOW_INSTANCE,
      {
        id: instance.id,
        input: {
          controllerId: controllerB.controllerId,
          workspaceId: workspaceB,
          createWorkflowWorktree: false,
          harnessMappings: [
            { nodeId: aiNode.id, acpServerType: 'opencode' },
            { nodeId: humanNode.id, acpServerType: 'opencode' },
          ],
        },
      },
      token,
    );
    expect(errorMessage(await mappingDone.json())).toContain('Harness 映射包含非 AI 或已完成节点');

    // Harness 不在目标能力清单
    const harnessRes = await gqlRequest(
      CONTINUE_WORKFLOW_INSTANCE,
      {
        id: instance.id,
        input: {
          controllerId: controllerB.controllerId,
          workspaceId: workspaceB,
          createWorkflowWorktree: false,
          harnessMappings: [{ nodeId: aiNode.id, acpServerType: 'cursor' }],
        },
      },
      token,
    );
    expect(errorMessage(await harnessRes.json())).toContain('控制器不支持该 Harness 类型: cursor');

    // 非 Git 工作区勾选 Worktree（无 defaultBranch 且 git:check=false）
    const noGitRes = await gqlRequest(
      CONTINUE_WORKFLOW_INSTANCE,
      {
        id: instance.id,
        input: {
          controllerId: controllerB.controllerId,
          workspaceId: workspaceNoGit,
          createWorkflowWorktree: true,
          harnessMappings: [{ nodeId: aiNode.id, acpServerType: 'opencode' }],
        },
      },
      token,
    );
    expect(errorMessage(await noGitRes.json())).toContain(
      '该工作区不是 Git 仓库（未设置默认分支），无法创建 Worktree',
    );
  }, 120_000);

  it('T-WFC4 重复接续：B 再离线后接续到 C，history 两条按时间升序', async () => {
    const instance = await createInstance(token, controllerA.controllerId, workspaceA);
    const aiNode = instance.nodes.find((node) => node.type === 'AI')!;
    await takeControllerOffline(controllerA);

    const first = await gqlRequest(
      CONTINUE_WORKFLOW_INSTANCE,
      {
        id: instance.id,
        input: {
          controllerId: controllerB.controllerId,
          workspaceId: workspaceB,
          createWorkflowWorktree: false,
          harnessMappings: [{ nodeId: aiNode.id, acpServerType: 'opencode' }],
        },
      },
      token,
    );
    expect((await first.json()).errors).toBeUndefined();

    await setControllerStatus(controllerB.controllerId, 'offline');
    const second = await gqlRequest(
      CONTINUE_WORKFLOW_INSTANCE,
      {
        id: instance.id,
        input: {
          controllerId: controllerC.controllerId,
          workspaceId: workspaceB,
          createWorkflowWorktree: false,
          harnessMappings: [{ nodeId: aiNode.id, acpServerType: 'opencode' }],
        },
      },
      token,
    );
    const secondBody = await second.json();
    // workspaceB 属于 controllerB，不属于 C：先断言归属拒绝文案
    expect(errorMessage(secondBody)).toContain('工作区不存在、无权限或不属于该控制器');

    const workspaceC = await createWorkspace(token, controllerC.controllerId);
    const retry = await gqlRequest(
      CONTINUE_WORKFLOW_INSTANCE,
      {
        id: instance.id,
        input: {
          controllerId: controllerC.controllerId,
          workspaceId: workspaceC,
          createWorkflowWorktree: false,
          harnessMappings: [{ nodeId: aiNode.id, acpServerType: 'opencode' }],
        },
      },
      token,
    );
    const retryBody = await retry.json();
    expect(retryBody.errors).toBeUndefined();
    const history = retryBody.data.continueWorkflowInstance.continuationHistory as Array<{ at: string }>;
    expect(history).toHaveLength(2);
    expect(new Date(history[0].at).getTime()).toBeLessThanOrEqual(new Date(history[1].at).getTime());
    // 恢复 B 在线，避免影响后续用例的「目标控制器」语义
    await setControllerStatus(controllerB.controllerId, 'online');
  }, 120_000);

  it('T-WFC5 restartNode 于不可用实例拒绝；接续后同调用成功', async () => {
    const instance = await createInstance(token, controllerA.controllerId, workspaceA, { startAi: true });
    const aiNode = instance.nodes.find((node) => node.type === 'AI')!;
    await takeControllerOffline(controllerA);

    const denied = await gqlRequest(RESTART_NODE, { instanceId: instance.id, nodeId: aiNode.id }, token);
    expect(errorMessage(await denied.json())).toContain(
      '工作流实例不可用（控制器离线或已删除），请先接续后再操作',
    );

    await setControllerStatus(controllerB.controllerId, 'online');
    const continued = await gqlRequest(
      CONTINUE_WORKFLOW_INSTANCE,
      {
        id: instance.id,
        input: {
          controllerId: controllerB.controllerId,
          workspaceId: workspaceB,
          createWorkflowWorktree: false,
          harnessMappings: [{ nodeId: aiNode.id, acpServerType: 'opencode' }],
        },
      },
      token,
    );
    expect((await continued.json()).errors).toBeUndefined();

    const restarted = await gqlRequest(RESTART_NODE, { instanceId: instance.id, nodeId: aiNode.id }, token);
    const restartedBody = await restarted.json();
    expect(restartedBody.errors).toBeUndefined();
    expect(restartedBody.data.restartNode.status).toBe('RUNNING');
  }, 120_000);

  it('T-WFC6 未完成节点 sessionId 清空、DONE 节点保留；已完成节点状态与黑板产物零改动', async () => {
    const instance = await createInstance(token, controllerA.controllerId, workspaceA, { startAi: true });
    const aiNode = instance.nodes.find((node) => node.type === 'AI')!;
    const humanNode = instance.nodes.find((node) => node.type === 'HUMAN')!;
    // 构造「已完成 AI 节点保留 sessionId + 黑板产物」快照
    await instancesCollection().updateOne(
      { _id: new mongoose.Types.ObjectId(instance.id), 'nodes.nodeId': humanNode.id },
      {
        $set: {
          'nodes.$.status': 'DONE',
          'nodes.$.sessionId': new mongoose.Types.ObjectId(),
          [`blackboard.${humanNode.id}-需求输入-产物-输入`]: '原始产物',
        },
      },
    );
    await takeControllerOffline(controllerA);

    const res = await gqlRequest(
      CONTINUE_WORKFLOW_INSTANCE,
      {
        id: instance.id,
        input: {
          controllerId: controllerB.controllerId,
          workspaceId: workspaceB,
          createWorkflowWorktree: false,
          harnessMappings: [{ nodeId: aiNode.id, acpServerType: 'opencode' }],
        },
      },
      token,
    );
    expect((await res.json()).errors).toBeUndefined();

    const raw = await instancesCollection().findOne({ _id: new mongoose.Types.ObjectId(instance.id) });
    const rawNodes = (raw?.nodes ?? []) as Array<{ nodeId: string; status: string; sessionId?: unknown }>;
    const doneNode = rawNodes.find((node) => node.nodeId === humanNode.id)!;
    const runningNode = rawNodes.find((node) => node.nodeId === aiNode.id)!;
    expect(doneNode.status).toBe('DONE');
    expect(doneNode.sessionId).toBeTruthy();
    expect(runningNode.sessionId ?? null).toBeNull();
    expect(raw?.blackboard?.[`${humanNode.id}-需求输入-产物-输入`]).toBe('原始产物');
  }, 120_000);
});
