import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';
import { createFrontUser } from '../support/front-users.js';

/**
 * 工作流打回/返工会话行为 —— API 用例 T-SB-API1 ~ T-SB-API4。
 *
 * 契约：`contracts/workflow.graphql` 的 `WorkflowNodeSessionBehavior` 与节点 4 字段。
 * 覆盖：模板创建/读取归一；已配置工作流配置归一（新会话 compact 强制 false）；
 * 实例化快照与 updateWorkflowNode；「返工时=新会话」行为链路（旧会话 stop + 新会话 start +
 * 首条消息含「## 返工说明」与 completeCurrentRework）与默认配置链路（acp:resume）零回归。
 */
const AGENT_API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273';

function gqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(AGENT_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
}

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

const SESSION_BEHAVIOR_FIELDS = `
  reworkSessionBehavior reworkCompactOriginalContext resumeSessionBehavior resumeCompactOriginalContext
`;

const TEMPLATE_NODE_FIELDS = `
  nodeKey type name stage prompts artifactTitles dependsOn requiresWorktree
  ${SESSION_BEHAVIOR_FIELDS}
`;

const CONFIGURED_NODE_FIELDS = `
  nodeKey type name stage prompts artifactTitles dependsOn requiresWorktree
  agentConfig { acpServerType modeId modelId initNewWorktree }
  ${SESSION_BEHAVIOR_FIELDS}
`;

const CREATE_WORKFLOW_TEMPLATE = `
  mutation CreateWorkflowTemplate($input: WorkflowTemplateInput!) {
    createWorkflowTemplate(input: $input) { id name version nodes { ${TEMPLATE_NODE_FIELDS} } }
  }
`;

const CONFIGURE_WORKFLOW = `
  mutation ConfigureWorkflow($templateId: ID!, $input: ConfigureWorkflowInput!) {
    configureWorkflow(templateId: $templateId, input: $input) { id name nodes { ${CONFIGURED_NODE_FIELDS} } }
  }
`;

const INSTANTIATE_WORKFLOW = `
  mutation InstantiateWorkflow($input: InstantiateWorkflowInput!) {
    instantiateWorkflow(input: $input) {
      id name nodes {
        id nodeKey name status sessionId
        reworkSessionBehavior reworkCompactOriginalContext resumeSessionBehavior resumeCompactOriginalContext
      }
    }
  }
`;

const WORKFLOW_INSTANCE_QUERY = `
  query WorkflowInstance($id: ID!) {
    workflowInstance(id: $id) {
      id nodes {
        id nodeKey name status sessionId
        reworkSessionBehavior reworkCompactOriginalContext resumeSessionBehavior resumeCompactOriginalContext
      }
    }
  }
`;

const UPDATE_WORKFLOW_NODE = `
  mutation UpdateWorkflowNode($instanceId: ID!, $nodeId: ID!, $input: WorkflowNodeUpdateInput!) {
    updateWorkflowNode(instanceId: $instanceId, nodeId: $nodeId, input: $input) {
      id nodeKey status
      reworkSessionBehavior reworkCompactOriginalContext resumeSessionBehavior resumeCompactOriginalContext
    }
  }
`;

const COMPLETE_HUMAN_NODE = `
  mutation CompleteHumanNode($instanceId: ID!, $nodeId: ID!, $input: String) {
    completeHumanNode(instanceId: $instanceId, nodeId: $nodeId, input: $input) { id nodeKey status }
  }
`;

const REJECT_NODE = `
  mutation RejectNode($instanceId: ID!, $nodeId: ID!, $reason: String!) {
    rejectNode(instanceId: $instanceId, nodeId: $nodeId, reason: $reason) { id nodeKey status }
  }
`;

const SESSION_MESSAGES_QUERY = `
  query SessionMessages($sessionId: ID!) {
    sessionMessages(sessionId: $sessionId, limit: 100) { id direction type content }
  }
`;

interface StartEventData {
  requestId: string;
  sessionId: string;
  serverType?: string;
  mcpEndpoint?: { token: string; serverNames: string[] };
}

interface ResumeEventData {
  requestId: string;
  sessionId: string;
}

interface FakeController {
  client: ClientSocket;
  controllerId: string;
  starts: StartEventData[];
  resumes: ResumeEventData[];
  stops: string[];
}

async function registerFakeController(token: string, tag: string): Promise<FakeController> {
  const keyRes = await gqlRequest(CREATE_KEY, { input: { name: `wfsb-${tag}-${Date.now()}`, type: 'local' } }, token);
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
    client.emit('acp:resume:result', { requestId: data.requestId, sessionId: data.sessionId, success: true });
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
    hostname: `wfsb-${tag}-host`,
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
  const path = `/tmp/wf-sb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const res = await gqlRequest(CREATE_WORKSPACE, { input: { controllerId, path } }, token);
  const body = await res.json();
  expect(body.errors).toBeUndefined();
  return body.data.createWorkspace.id;
}

/** 三节点图：HUMAN(input) → AI(exec) → HUMAN(review)，用于打回链路 */
function graphNodes(behavior: Record<string, unknown> = {}) {
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
      ...behavior,
    },
    { nodeKey: 'review', type: 'HUMAN', name: '评审', stage: '阶段二', dependsOn: ['exec'], requiresWorktree: false },
  ];
}

function configureNodes() {
  return graphNodes().map((node) => ({
    ...node,
    agentConfig: node.type === 'AI' ? { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: false } : null,
  }));
}

async function createTemplateWithBehavior(
  token: string,
  name: string,
  behavior: Record<string, unknown>,
  humanBehavior: Record<string, unknown> = {},
) {
  const nodes = graphNodes(behavior).map((node) =>
    node.type === 'HUMAN' ? { ...node, ...humanBehavior } : node,
  );
  const res = await gqlRequest(CREATE_WORKFLOW_TEMPLATE, { input: { name, nodes } }, token);
  const body = await res.json();
  if (body.errors) throw new Error(`create template failed: ${JSON.stringify(body.errors)}`);
  return body.data.createWorkflowTemplate as { id: string; nodes: Record<string, any>[] };
}

async function configureWithBehavior(
  token: string,
  templateId: string,
  controllerId: string,
  name: string,
  behavior: Record<string, unknown>,
) {
  const nodes = configureNodes().map((node) => (node.type === 'AI' ? { ...node, ...behavior } : node));
  const res = await gqlRequest(CONFIGURE_WORKFLOW, { templateId, input: { name, controllerId, nodes } }, token);
  const body = await res.json();
  if (body.errors) throw new Error(`configure failed: ${JSON.stringify(body.errors)}`);
  return body.data.configureWorkflow as { id: string; nodes: Record<string, any>[] };
}

async function instantiateWithBehavior(
  token: string,
  controllerId: string,
  configuredWorkflowId: string,
  workspaceId: string,
  name: string,
  behavior: Record<string, unknown>,
) {
  const nodes = configureNodes().map((node) => (node.type === 'AI' ? { ...node, ...behavior } : node));
  const res = await gqlRequest(
    INSTANTIATE_WORKFLOW,
    { input: { source: 'CONFIGURED', configuredWorkflowId, controllerId, workspaceId, name, nodes } },
    token,
  );
  const body = await res.json();
  if (body.errors) throw new Error(`instantiate failed: ${JSON.stringify(body.errors)}`);
  return body.data.instantiateWorkflow as { id: string; nodes: Record<string, any>[] };
}

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

async function getMessages(token: string, sessionId: string): Promise<string[]> {
  const res = await gqlRequest(SESSION_MESSAGES_QUERY, { sessionId }, token);
  const body = await res.json();
  expect(body.errors).toBeUndefined();
  return (body.data.sessionMessages as { content: unknown }[]).map((m) =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  );
}

async function getInstance(token: string, instanceId: string) {
  const res = await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token);
  const body = await res.json();
  expect(body.errors).toBeUndefined();
  return body.data.workflowInstance as { nodes: Record<string, any>[] };
}

describe('Workflow Session Behavior API (T-SB-API)', () => {
  let token = '';
  let fake: FakeController;

  beforeAll(async () => {
    const user = await createFrontUser();
    token = user.token;
    expect(token).toBeTruthy();
    fake = await registerFakeController(token, 'api');
    const available = await refreshCapabilities(token, fake.controllerId);
    expect(available).toContain('opencode');
  }, 30_000);

  afterAll(() => {
    fake?.client.disconnect();
  });

  it('T-SB-API1: 模板创建/读取 4 字段逐字段回显；缺省读取归一默认值；HUMAN 恒 null', async () => {
    const created = await createTemplateWithBehavior(
      token,
      `wf-sb-tpl-${Date.now()}`,
      {
        reworkSessionBehavior: 'NEW_SESSION',
        reworkCompactOriginalContext: true,
        resumeSessionBehavior: 'ORIGINAL_SESSION',
        resumeCompactOriginalContext: true,
      },
      // HUMAN 节点即使传入也应为 null
      {
        reworkSessionBehavior: 'NEW_SESSION',
        reworkCompactOriginalContext: true,
        resumeSessionBehavior: 'ORIGINAL_SESSION',
        resumeCompactOriginalContext: true,
      },
    );

    const exec = created.nodes.find((n) => n.nodeKey === 'exec')!;
    expect(exec).toMatchObject({
      reworkSessionBehavior: 'NEW_SESSION',
      // 新会话时 compact 强制 false（服务端归一）
      reworkCompactOriginalContext: false,
      resumeSessionBehavior: 'ORIGINAL_SESSION',
      resumeCompactOriginalContext: true,
    });
    const human = created.nodes.find((n) => n.nodeKey === 'input')!;
    expect(human.reworkSessionBehavior).toBeNull();
    expect(human.reworkCompactOriginalContext).toBeNull();
    expect(human.resumeSessionBehavior).toBeNull();
    expect(human.resumeCompactOriginalContext).toBeNull();

    // 缺省创建：AI 节点读取归一为默认值（ORIGINAL/NEW）
    const plain = await createTemplateWithBehavior(token, `wf-sb-tpl-default-${Date.now()}`, {});
    const plainExec = plain.nodes.find((n) => n.nodeKey === 'exec')!;
    expect(plainExec).toMatchObject({
      reworkSessionBehavior: 'ORIGINAL_SESSION',
      reworkCompactOriginalContext: false,
      resumeSessionBehavior: 'NEW_SESSION',
      resumeCompactOriginalContext: false,
    });
  }, 30_000);

  it('T-SB-API2: 已配置工作流 4 字段透传与归一（新会话+compact=true → false）', async () => {
    const template = await createTemplateWithBehavior(token, `wf-sb-cfg-tpl-${Date.now()}`, {});
    const configured = await configureWithBehavior(
      token,
      template.id,
      fake.controllerId,
      `wf-sb-cfg-${Date.now()}`,
      {
        reworkSessionBehavior: 'NEW_SESSION',
        reworkCompactOriginalContext: true,
        resumeSessionBehavior: 'ORIGINAL_SESSION',
        resumeCompactOriginalContext: true,
      },
    );

    const exec = configured.nodes.find((n) => n.nodeKey === 'exec')!;
    expect(exec).toMatchObject({
      reworkSessionBehavior: 'NEW_SESSION',
      reworkCompactOriginalContext: false,
      resumeSessionBehavior: 'ORIGINAL_SESSION',
      resumeCompactOriginalContext: true,
    });
    const human = configured.nodes.find((n) => n.nodeKey === 'input')!;
    expect(human.reworkSessionBehavior).toBeNull();
  }, 30_000);

  it('T-SB-API3: 实例化快照携带 4 字段；未开始节点可改、已开始拒绝；读取归一', async () => {
    const template = await createTemplateWithBehavior(token, `wf-sb-inst-tpl-${Date.now()}`, {});
    const configured = await configureWithBehavior(
      token,
      template.id,
      fake.controllerId,
      `wf-sb-inst-cfg-${Date.now()}`,
      {},
    );
    const workspaceId = await createWorkspace(token, fake.controllerId);
    const instance = await instantiateWithBehavior(
      token,
      fake.controllerId,
      configured.id,
      workspaceId,
      `wf-sb-inst-${Date.now()}`,
      {
        reworkSessionBehavior: 'NEW_SESSION',
        reworkCompactOriginalContext: true,
        resumeSessionBehavior: 'ORIGINAL_SESSION',
        resumeCompactOriginalContext: true,
      },
    );

    const exec = instance.nodes.find((n) => n.nodeKey === 'exec')!;
    expect(exec).toMatchObject({
      reworkSessionBehavior: 'NEW_SESSION',
      reworkCompactOriginalContext: false,
      resumeSessionBehavior: 'ORIGINAL_SESSION',
      resumeCompactOriginalContext: true,
    });
    const human = instance.nodes.find((n) => n.nodeKey === 'input')!;
    expect(human.reworkSessionBehavior).toBeNull();

    // 未开始节点（exec INITIALIZING）可改；新会话 compact 强制 false
    const updated = await gqlRequest(
      UPDATE_WORKFLOW_NODE,
      {
        instanceId: instance.id,
        nodeId: exec.id,
        input: {
          reworkSessionBehavior: 'ORIGINAL_SESSION',
          reworkCompactOriginalContext: true,
          resumeSessionBehavior: 'NEW_SESSION',
          resumeCompactOriginalContext: true,
        },
      },
      token,
    );
    const updatedBody = await updated.json();
    expect(updatedBody.errors).toBeUndefined();
    expect(updatedBody.data.updateWorkflowNode).toMatchObject({
      reworkSessionBehavior: 'ORIGINAL_SESSION',
      reworkCompactOriginalContext: true,
      resumeSessionBehavior: 'NEW_SESSION',
      resumeCompactOriginalContext: false,
    });

    // 实例读取归一：HUMAN 恒 null
    const reloaded = await getInstance(token, instance.id);
    expect(reloaded.nodes.find((n) => n.nodeKey === 'input')!.reworkSessionBehavior).toBeNull();
  }, 30_000);

  it('T-SB-API4a: 返工时=新会话 → 旧会话 stop + 新会话 start，首条消息含「## 返工说明」与 completeCurrentRework', async () => {
    const template = await createTemplateWithBehavior(token, `wf-sb-rework-tpl-${Date.now()}`, {});
    const configured = await configureWithBehavior(
      token,
      template.id,
      fake.controllerId,
      `wf-sb-rework-cfg-${Date.now()}`,
      { reworkSessionBehavior: 'NEW_SESSION' },
    );
    const workspaceId = await createWorkspace(token, fake.controllerId);
    const instance = await instantiateWithBehavior(
      token,
      fake.controllerId,
      configured.id,
      workspaceId,
      `wf-sb-rework-${Date.now()}`,
      { reworkSessionBehavior: 'NEW_SESSION' },
    );

    const inputNode = instance.nodes.find((n) => n.nodeKey === 'input')!;
    const reviewNode = instance.nodes.find((n) => n.nodeKey === 'review')!;

    const firstStart = waitForEvent<StartEventData>(fake.client, 'acp:start', 15000);
    const completeRes = await gqlRequest(
      COMPLETE_HUMAN_NODE,
      { instanceId: instance.id, nodeId: inputNode.id, input: '做一个计算器' },
      token,
    );
    expect((await completeRes.json()).errors).toBeUndefined();

    const startEvent = await firstStart;
    const execSessionId = startEvent.sessionId;
    const execToken = startEvent.mcpEndpoint!.token;
    fake.client.emit('acp:start:result', {
      requestId: startEvent.requestId,
      sessionId: execSessionId,
      success: true,
      externalSessionId: `ext_rework_${Date.now()}`,
    });

    // AI 节点完成 → review RUNNING
    const toolRes = await callWorkflowTool(fake.client, execSessionId, execToken, 'completeCurrentNode', {
      artifacts: [{ title: '执行结果', value: '计算器已实现' }],
    });
    expect(toolRes.body.error).toBeUndefined();
    await waitFor(async () => {
      const inst = await getInstance(token, instance.id);
      const review = inst.nodes.find((n) => n.nodeKey === 'review')!;
      return review.status === 'RUNNING' ? true : undefined;
    }, 15000, 'review RUNNING');

    const startCountBefore = fake.starts.length;
    const nextStart = waitForEvent<StartEventData>(fake.client, 'acp:start', 20000);
    const rejectRes = await gqlRequest(
      REJECT_NODE,
      { instanceId: instance.id, nodeId: reviewNode.id, reason: '执行结果缺少边界校验' },
      token,
    );
    expect((await rejectRes.json()).errors).toBeUndefined();

    // 旧会话被关闭（acp:stop），新会话拉起（acp:start）
    await waitFor(async () => {
      return fake.stops.includes(execSessionId) ? true : undefined;
    }, 15000, 'old exec session stopped');

    const newStart = await nextStart;
    expect(newStart.sessionId).not.toBe(execSessionId);
    expect(fake.starts.length).toBeGreaterThanOrEqual(startCountBefore + 1);
    fake.client.emit('acp:start:result', {
      requestId: newStart.requestId,
      sessionId: newStart.sessionId,
      success: true,
      externalSessionId: `ext_rework_new_${Date.now()}`,
    });

    const messages = await waitFor(async () => {
      const list = await getMessages(token, newStart.sessionId);
      return list.some((m) => m.includes('## 返工说明')) ? list : undefined;
    }, 15000, 'rework prompt message');
    const prompt = messages.find((m) => m.includes('## 返工说明'))!;
    expect(prompt).toContain('执行结果缺少边界校验');
    expect(prompt).toContain('completeCurrentRework');
    expect(prompt).not.toContain('completeCurrentNode');

    // 实例节点 sessionId 已切换为新会话
    const inst = await getInstance(token, instance.id);
    expect(inst.nodes.find((n) => n.nodeKey === 'exec')!.sessionId).toBe(newStart.sessionId);
  }, 90_000);

  it('T-SB-API4b: 默认配置（返工时=原始会话）→ acp:resume 而非新会话（现状零回归）', async () => {
    const template = await createTemplateWithBehavior(token, `wf-sb-default-tpl-${Date.now()}`, {});
    const configured = await configureWithBehavior(
      token,
      template.id,
      fake.controllerId,
      `wf-sb-default-cfg-${Date.now()}`,
      {},
    );
    const workspaceId = await createWorkspace(token, fake.controllerId);
    const instance = await instantiateWithBehavior(
      token,
      fake.controllerId,
      configured.id,
      workspaceId,
      `wf-sb-default-${Date.now()}`,
      {},
    );

    const inputNode = instance.nodes.find((n) => n.nodeKey === 'input')!;
    const reviewNode = instance.nodes.find((n) => n.nodeKey === 'review')!;

    const firstStart = waitForEvent<StartEventData>(fake.client, 'acp:start', 15000);
    const completeRes = await gqlRequest(
      COMPLETE_HUMAN_NODE,
      { instanceId: instance.id, nodeId: inputNode.id, input: '做一个计算器' },
      token,
    );
    expect((await completeRes.json()).errors).toBeUndefined();

    const startEvent = await firstStart;
    const execSessionId = startEvent.sessionId;
    const execToken = startEvent.mcpEndpoint!.token;
    fake.client.emit('acp:start:result', {
      requestId: startEvent.requestId,
      sessionId: execSessionId,
      success: true,
      externalSessionId: `ext_default_${Date.now()}`,
    });

    const toolRes = await callWorkflowTool(fake.client, execSessionId, execToken, 'completeCurrentNode', {
      artifacts: [{ title: '执行结果', value: '计算器已实现' }],
    });
    expect(toolRes.body.error).toBeUndefined();
    await waitFor(async () => {
      const inst = await getInstance(token, instance.id);
      return inst.nodes.find((n) => n.nodeKey === 'review')!.status === 'RUNNING' ? true : undefined;
    }, 15000, 'review RUNNING');

    const resumeEvent = waitForEvent<ResumeEventData>(fake.client, 'acp:resume', 20000);
    const rejectRes = await gqlRequest(
      REJECT_NODE,
      { instanceId: instance.id, nodeId: reviewNode.id, reason: '执行结果缺少边界校验' },
      token,
    );
    expect((await rejectRes.json()).errors).toBeUndefined();

    const resume = await resumeEvent;
    expect(resume.sessionId).toBe(execSessionId);

    const messages = await waitFor(async () => {
      const list = await getMessages(token, execSessionId);
      return list.some((m) => m.includes('需要返工')) ? list : undefined;
    }, 15000, 'rework prompt on original session');
    const prompt = messages.find((m) => m.includes('需要返工'))!;
    expect(prompt).toContain('执行结果缺少边界校验');
    expect(prompt).toContain('completeCurrentRework');

    const inst = await getInstance(token, instance.id);
    expect(inst.nodes.find((n) => n.nodeKey === 'exec')!.sessionId).toBe(execSessionId);
  }, 90_000);
});
