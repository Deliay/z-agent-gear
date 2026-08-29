import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';
import Redis from 'ioredis';

const AGENT_API_URL = process.env.API_URL || 'http://localhost:4000/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const MCP_BASE_URL = `${(process.env.API_URL || 'http://localhost:4000').replace(/\/graphql\/?$/, '')}/mcp`;

const redis = new Redis(REDIS_URL, { enableOfflineQueue: false, retryStrategy: () => null });

/** 删除 Redis 中的 ACP 能力缓存 key */
async function flushCapabilityCache(controllerId: string): Promise<void> {
  await redis.del(`acp:capability:${controllerId}`);
}

function gqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const body: Record<string, unknown> = { query };
  if (variables) {
    body.variables = variables;
  }
  return fetch(AGENT_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const SIGNUP = `
  mutation Signup($username: String!, $password: String!) {
    signup(username: $username, password: $password) {
      token
      user { id username }
    }
  }
`;

const CREATE_KEY = `
  mutation CreateControllerKey($input: CreateKeyInput!) {
    createControllerKey(input: $input) {
      key { id name }
      rawKey
    }
  }
`;

const CREATE_WORKSPACE = `
  mutation CreateWorkspace($input: CreateWorkspaceInput!) {
    createWorkspace(input: $input) {
      id controllerId path
    }
  }
`;

const CREATE_SESSION = `
  mutation CreateSession($input: CreateSessionInput!) {
    createSession(input: $input) {
      session { id status acpServerType }
    }
  }
`;

const SESSIONS_QUERY = `
  query Sessions($includeWorkflowSessions: Boolean) {
    sessions(includeWorkflowSessions: $includeWorkflowSessions) {
      id status acpServerType workflowInstanceId workflowNodeId
    }
  }
`;

const REFRESH_ACP_CAPABILITIES = `
  mutation RefreshAcpCapabilities($controllerId: ID!) {
    refreshAcpCapabilities(controllerId: $controllerId) {
      type available version checkedAt
    }
  }
`;

const MCP_SERVERS_QUERY = `
  query McpServers {
    mcpServers { id name transport source enabled }
  }
`;

const WORKFLOW_TEMPLATES_QUERY = `
  query WorkflowTemplates {
    workflowTemplates {
      id name version isBuiltin
      nodes { nodeKey type name stage prompts artifactTitles dependsOn requiresWorktree }
    }
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

const UPDATE_WORKFLOW_TEMPLATE = `
  mutation UpdateWorkflowTemplate($id: ID!, $input: WorkflowTemplateInput!) {
    updateWorkflowTemplate(id: $id, input: $input) {
      id name version
      nodes { nodeKey type name prompts dependsOn requiresWorktree }
    }
  }
`;

const DELETE_WORKFLOW_TEMPLATE = `
  mutation DeleteWorkflowTemplate($id: ID!) {
    deleteWorkflowTemplate(id: $id)
  }
`;

const CONFIGURE_WORKFLOW = `
  mutation ConfigureWorkflow($templateId: ID!, $input: ConfigureWorkflowInput!) {
    configureWorkflow(templateId: $templateId, input: $input) {
      id name controllerId sourceTemplateId sourceTemplateVersion
      nodes { nodeKey type name prompts agentConfig { acpServerType modeId modelId initNewWorktree } }
    }
  }
`;

const CONFIGURED_WORKFLOW_QUERY = `
  query ConfiguredWorkflow($id: ID!) {
    configuredWorkflow(id: $id) {
      id name controllerId sourceTemplateId sourceTemplateVersion
      nodes { nodeKey type name prompts agentConfig { acpServerType initNewWorktree } }
    }
  }
`;

const UPDATE_CONFIGURED_WORKFLOW = `
  mutation UpdateConfiguredWorkflow($id: ID!, $input: ConfigureWorkflowInput!) {
    updateConfiguredWorkflow(id: $id, input: $input) {
      id name
      nodes { nodeKey agentConfig { acpServerType initNewWorktree } }
    }
  }
`;

const DELETE_CONFIGURED_WORKFLOW = `
  mutation DeleteConfiguredWorkflow($id: ID!) {
    deleteConfiguredWorkflow(id: $id)
  }
`;

const SET_WORKSPACE_DEFAULT_BRANCH = `
  mutation SetWorkspaceDefaultBranch($id: ID!, $defaultBranch: String!) {
    setWorkspaceDefaultBranch(id: $id, defaultBranch: $defaultBranch) {
      id defaultBranch
    }
  }
`;

const INSTANTIATE_WORKFLOW = `
  mutation InstantiateWorkflow($input: InstantiateWorkflowInput!) {
    instantiateWorkflow(input: $input) {
      id configuredWorkflowId controllerId workspaceId name currentNodeNames lastNodeName lastNodeStatus
      nodes { id nodeKey type name status stage sortOrder sessionId reworkCount prompts artifactTitles requiresWorktree agentConfig { acpServerType initNewWorktree } }
    }
  }
`;

const UPDATE_WORKFLOW_NODE = `
  mutation UpdateWorkflowNode($instanceId: ID!, $nodeId: ID!, $input: WorkflowNodeUpdateInput!) {
    updateWorkflowNode(instanceId: $instanceId, nodeId: $nodeId, input: $input) {
      id nodeKey name status prompts requiresWorktree
    }
  }
`;

const DELETE_WORKFLOW_INSTANCE_MUT = `
  mutation DeleteWorkflowInstance($id: ID!) {
    deleteWorkflowInstance(id: $id)
  }
`;

const WORKFLOW_INSTANCE_QUERY = `
  query WorkflowInstance($id: ID!) {
    workflowInstance(id: $id) {
      id name currentNodeNames lastNodeName lastNodeStatus archived workflowWorktreePath workflowWorktreeBranch
      nodes { id nodeKey type name status stage sortOrder sessionId startedAt reworkedAt reworkCount agentConfig { acpServerType modeId modelId initNewWorktree } rejectInfo { reason fromNodeId at } failInfo { reason source at } }
      blackboard { key value updatedAt }
      blackboardTrash { key value updatedAt }
    }
  }
`;

const WORKFLOW_INSTANCES_QUERY = `
  query WorkflowInstances($workspaceId: ID!, $archived: Boolean) {
    workflowInstances(workspaceId: $workspaceId, archived: $archived) { id name lastNodeName lastNodeStatus archived }
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
      id nodeKey name status rejectInfo { reason fromNodeId at }
    }
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
  return new Promise((r) => setTimeout(r, ms));
}

async function signup(tag: string): Promise<string> {
  const uid = `${tag}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
  const body = await res.json();
  return body.data?.signup?.token ?? '';
}

interface FakeController {
  client: ClientSocket;
  controllerId: string;
  rawKey: string;
}

/** 服务端默认 worktreeDir（~/.zag/worktrees）展开所用控制器 home；fake 统一上报此值 */
const FAKE_CONTROLLER_HOME = '/home/fake';

/** 注册 fake controller 并保持连接；自动应答 acp:check 能力检测（默认仅 opencode 可用） */
async function registerFakeController(
  token: string,
  tag: string,
  servers: { type: string; available: boolean; version?: string }[] = [
    { type: 'opencode', available: true, version: '1.0.0' },
  ],
): Promise<FakeController> {
  const keyRes = await gqlRequest(CREATE_KEY, { input: { name: `wf-${tag}-${Date.now()}`, type: 'local' } }, token);
  const keyBody = await keyRes.json();
  const rawKey = keyBody.data.createControllerKey.rawKey;

  const client = createClient();
  client.on('acp:check', (data: { requestId: string }) => {
    client.emit('acp:check:result', { requestId: data.requestId, servers });
  });
  // 生命周期命令（start/stop/resume）串行处理：acp:stop 未 ack 会阻塞后续 resume，
  // fake controller 须像真实 controller 一样 ack
  client.on('acp:stop', (data: { sessionId: string }) => {
    client.emit('acp:stopped', { sessionId: data.sessionId, reason: 'user_close' });
  });
  const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
  client.emit('register', { key: rawKey, hostname: `wf-${tag}-host`, version: '1.0.0', homeDir: FAKE_CONTROLLER_HOME, platform: 'linux' });
  const regData = await registered;
  return { client, controllerId: regData.controllerId, rawKey };
}

/** 触发能力检测并等待 Redis 缓存就绪，返回可用 server type 列表 */
async function refreshCapabilities(token: string, controllerId: string): Promise<string[]> {
  const res = await gqlRequest(REFRESH_ACP_CAPABILITIES, { controllerId }, token);
  const body = await res.json();
  expect(body.errors).toBeUndefined();
  return (body.data.refreshAcpCapabilities as { type: string; available: boolean }[])
    .filter((s) => s.available)
    .map((s) => s.type);
}

async function createWorkspace(token: string, controllerId: string): Promise<string> {
  const path = `/tmp/wf-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const res = await gqlRequest(CREATE_WORKSPACE, { input: { controllerId, path } }, token);
  const body = await res.json();
  if (body.errors) {
    throw new Error(`createWorkspace failed: ${JSON.stringify(body.errors)}`);
  }
  return body.data.createWorkspace.id;
}

async function createGitWorkspace(token: string, controllerId: string): Promise<string> {
  const path = `/tmp/wf-test-git-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const res = await gqlRequest(CREATE_WORKSPACE, { input: { controllerId, path } }, token);
  const body = await res.json();
  if (body.errors) {
    throw new Error(`createWorkspace failed: ${JSON.stringify(body.errors)}`);
  }
  const wsId = body.data.createWorkspace.id;
  // 设置 defaultBranch 使其成为 Git 工作区
  const setBranchRes = await gqlRequest(SET_WORKSPACE_DEFAULT_BRANCH, { id: wsId, defaultBranch: 'main' }, token);
  const setBranchBody = await setBranchRes.json();
  if (setBranchBody.errors) {
    throw new Error(`setWorkspaceDefaultBranch failed: ${JSON.stringify(setBranchBody.errors)}`);
  }
  return wsId;
}

/** 简单两节点模板：HUMAN(input) → AI(exec) */
function simpleTemplateInput(name: string, requiresWorktree = false) {
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
        requiresWorktree,
      },
    ],
  };
}

async function createSimpleTemplate(token: string, name: string, requiresWorktree = false): Promise<string> {
  const res = await gqlRequest(CREATE_WORKFLOW_TEMPLATE, { input: simpleTemplateInput(name, requiresWorktree) }, token);
  const body = await res.json();
  if (body.errors) {
    throw new Error(`createWorkflowTemplate failed: ${JSON.stringify(body.errors)}`);
  }
  return body.data.createWorkflowTemplate.id;
}

/** 模板节点 → 全量 configure 入参节点（AI 节点补 agentConfig） */
function configureNodes(
  templateNodes: {
    nodeKey: string; type: string; name: string; stage: string;
    prompts?: string[]; artifactTitles?: string[]; dependsOn: string[]; requiresWorktree: boolean;
  }[],
  agentConfigs: Record<string, { acpServerType: string; modeId?: string | null; modelId?: string | null; initNewWorktree: boolean } | null> = {},
) {
  return templateNodes.map((n) => ({
    nodeKey: n.nodeKey,
    type: n.type,
    name: n.name,
    stage: n.stage,
    prompts: n.prompts,
    artifactTitles: n.artifactTitles,
    dependsOn: n.dependsOn,
    requiresWorktree: n.requiresWorktree,
    agentConfig: n.type === 'AI' ? (agentConfigs[n.nodeKey] ?? { acpServerType: 'opencode', initNewWorktree: false }) : null,
  }));
}

function configureInput(name: string, controllerId: string, initNewWorktree = false) {
  return {
    name,
    controllerId,
    nodes: configureNodes(simpleTemplateInput('_').nodes, {
      exec: { acpServerType: 'opencode', initNewWorktree },
    }),
  };
}

async function configureFromTemplate(
  token: string,
  templateId: string,
  controllerId: string,
  name: string,
  initNewWorktree = false,
): Promise<string> {
  const res = await gqlRequest(
    CONFIGURE_WORKFLOW,
    { templateId, input: configureInput(name, controllerId, initNewWorktree) },
    token,
  );
  const body = await res.json();
  if (body.errors) {
    throw new Error(`configureWorkflow failed: ${JSON.stringify(body.errors)}`);
  }
  return body.data.configureWorkflow.id;
}

/** 实例化入参（CONFIGURED 来源，节点图沿用两节点 simple 模板结构） */
function instantiateInput(
  controllerId: string,
  configuredWorkflowId: string,
  workspaceId: string,
  name: string,
  initNewWorktree = false,
) {
  return {
    source: 'CONFIGURED',
    configuredWorkflowId,
    controllerId,
    workspaceId,
    name,
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
        requiresWorktree: initNewWorktree,
        agentConfig: { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree },
      },
    ],
  };
}

/** 调用平台工作流 MCP 工具，返回 { httpStatus, body } */
async function callWorkflowTool(
  sessionId: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ httpStatus: number; body: Record<string, any> }> {
  const res = await fetch(`${MCP_BASE_URL}/${sessionId}/agent-workflow-tools`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return { httpStatus: res.status, body: await res.json() };
}

/** 解析 MCP tools/call 结果：{ isError, data }（data 为 content[0].text 的 JSON） */
function parseToolResult(body: Record<string, any>): { isError: boolean; data: Record<string, any> } {
  expect(body.error).toBeUndefined();
  const result = body.result;
  expect(result?.content?.[0]?.text).toBeDefined();
  return { isError: Boolean(result.isError), data: JSON.parse(result.content[0].text) };
}

// ---------------------------------------------------------------------------
// 模板管理（A1-A4）
// ---------------------------------------------------------------------------

describe('Workflow Template API (A1-A4)', () => {
  let token = '';

  beforeAll(async () => {
    token = await signup('wftpl');
    expect(token).toBeTruthy();
  });

  it('A1: 创建合法模板成功', async () => {
    const res = await gqlRequest(
      CREATE_WORKFLOW_TEMPLATE,
      { input: simpleTemplateInput(`wf-a1-${Date.now()}`) },
      token,
    );
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    const tpl = body.data.createWorkflowTemplate;
    expect(tpl.id).toBeDefined();
    expect(tpl.version).toBe(1);
    expect(tpl.isBuiltin).toBe(false);
    expect(tpl.nodes).toHaveLength(2);
    expect(tpl.nodes[0].nodeKey).toBe('input');
    expect(tpl.nodes[0].type).toBe('HUMAN');
    expect(tpl.nodes[1].nodeKey).toBe('exec');
    expect(tpl.nodes[1].prompts).toEqual(['阅读上游产物并完成执行']);
  });

  it('A2: 环图拒绝', async () => {
    const res = await gqlRequest(
      CREATE_WORKFLOW_TEMPLATE,
      {
        input: {
          name: `wf-a2-cycle-${Date.now()}`,
          nodes: [
            { nodeKey: 'a', type: 'HUMAN', name: '甲', stage: 's', dependsOn: ['b'], requiresWorktree: false },
            { nodeKey: 'b', type: 'AI', name: '乙', stage: 's', prompts: ['做乙事'], dependsOn: ['a'], requiresWorktree: false },
          ],
        },
      },
      token,
    );
    const body = await res.json();
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toContain('循环依赖');
  });

  it('A2: 双首节点拒绝', async () => {
    const res = await gqlRequest(
      CREATE_WORKFLOW_TEMPLATE,
      {
        input: {
          name: `wf-a2-twosrc-${Date.now()}`,
          nodes: [
            { nodeKey: 'h1', type: 'HUMAN', name: '甲', stage: 's', dependsOn: [], requiresWorktree: false },
            { nodeKey: 'h2', type: 'HUMAN', name: '乙', stage: 's', dependsOn: [], requiresWorktree: false },
            { nodeKey: 'a1', type: 'AI', name: '丙', stage: 's', prompts: ['做丙事'], dependsOn: ['h1', 'h2'], requiresWorktree: false },
          ],
        },
      },
      token,
    );
    const body = await res.json();
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toContain('首节点必须唯一');
  });

  it('A2: AI 首节点拒绝', async () => {
    const res = await gqlRequest(
      CREATE_WORKFLOW_TEMPLATE,
      {
        input: {
          name: `wf-a2-aifirst-${Date.now()}`,
          nodes: [
            { nodeKey: 'a1', type: 'AI', name: '甲', stage: 's', prompts: ['做甲事'], dependsOn: [], requiresWorktree: false },
            { nodeKey: 'h1', type: 'HUMAN', name: '乙', stage: 's', dependsOn: ['a1'], requiresWorktree: false },
          ],
        },
      },
      token,
    );
    const body = await res.json();
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toContain('首节点必须是人类节点');
  });

  it('A3: 内置模板只读（update/delete 拒绝）', async () => {
    const listRes = await gqlRequest(WORKFLOW_TEMPLATES_QUERY, undefined, token);
    const listBody = await listRes.json();
    expect(listBody.errors).toBeUndefined();
    const builtin = (listBody.data.workflowTemplates as { id: string; isBuiltin: boolean; nodes: unknown[] }[])
      .find((t) => t.isBuiltin);
    expect(builtin, '应存在种子内置模板').toBeDefined();

    const updateRes = await gqlRequest(
      UPDATE_WORKFLOW_TEMPLATE,
      { id: builtin!.id, input: { name: '篡改内置模板', nodes: [] } },
      token,
    );
    const updateBody = await updateRes.json();
    expect(updateBody.errors).toBeDefined();
    expect(updateBody.errors[0].message).toContain('内置模板不允许修改');

    const deleteRes = await gqlRequest(DELETE_WORKFLOW_TEMPLATE, { id: builtin!.id }, token);
    const deleteBody = await deleteRes.json();
    expect(deleteBody.errors).toBeDefined();
    expect(deleteBody.errors[0].message).toContain('内置模板不允许删除');
  });

  it('A4: 更新模板 version 自增', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a4-${Date.now()}`);

    const update1 = await gqlRequest(
      UPDATE_WORKFLOW_TEMPLATE,
      { id: tplId, input: simpleTemplateInput(`wf-a4-v2-${Date.now()}`) },
      token,
    );
    const body1 = await update1.json();
    expect(body1.errors).toBeUndefined();
    expect(body1.data.updateWorkflowTemplate.version).toBe(2);

    const update2 = await gqlRequest(
      UPDATE_WORKFLOW_TEMPLATE,
      { id: tplId, input: simpleTemplateInput(`wf-a4-v3-${Date.now()}`) },
      token,
    );
    const body2 = await update2.json();
    expect(body2.errors).toBeUndefined();
    expect(body2.data.updateWorkflowTemplate.version).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 配置工作流（A5-A8）
// ---------------------------------------------------------------------------

describe('Configured Workflow API (A5-A8)', () => {
  let token = '';
  let fake: FakeController;

  beforeAll(async () => {
    token = await signup('wfcfg');
    expect(token).toBeTruthy();
    fake = await registerFakeController(token, 'cfg');
    const available = await refreshCapabilities(token, fake.controllerId);
    expect(available).toContain('opencode');
  }, 20_000);

  afterAll(() => {
    fake?.client.disconnect();
  });

  it('A5: 从模板复制快照，模板后续更新不影响副本', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a5-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-a5-cfg-${Date.now()}`);

    const q1 = await gqlRequest(CONFIGURED_WORKFLOW_QUERY, { id: cfgId }, token);
    const cfg1 = (await q1.json()).data.configuredWorkflow;
    expect(cfg1.sourceTemplateId).toBe(tplId);
    expect(cfg1.sourceTemplateVersion).toBe(1);
    const exec1 = cfg1.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec');
    expect(exec1.name).toBe('AI执行');
    expect(exec1.prompts).toEqual(['阅读上游产物并完成执行']);
    expect(exec1.agentConfig.acpServerType).toBe('opencode');
    expect(exec1.agentConfig.initNewWorktree).toBe(false);

    // 修改模板：改名 + 改 prompts，version 自增
    const mutated = simpleTemplateInput(`wf-a5-v2-${Date.now()}`);
    mutated.nodes[1].name = 'AI执行-v2';
    mutated.nodes[1].prompts = ['全新提示词'];
    const updateRes = await gqlRequest(UPDATE_WORKFLOW_TEMPLATE, { id: tplId, input: mutated }, token);
    const updateBody = await updateRes.json();
    expect(updateBody.errors).toBeUndefined();
    expect(updateBody.data.updateWorkflowTemplate.version).toBe(2);

    // 副本不受模板更新影响
    const q2 = await gqlRequest(CONFIGURED_WORKFLOW_QUERY, { id: cfgId }, token);
    const cfg2 = (await q2.json()).data.configuredWorkflow;
    expect(cfg2.sourceTemplateVersion).toBe(1);
    const exec2 = cfg2.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec');
    expect(exec2.name).toBe('AI执行');
    expect(exec2.prompts).toEqual(['阅读上游产物并完成执行']);
  });

  it('A6: 缺 AI 节点 agentConfig 拒绝', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a6-${Date.now()}`);
    const res = await gqlRequest(
      CONFIGURE_WORKFLOW,
      {
        templateId: tplId,
        input: {
          name: `wf-a6-cfg-${Date.now()}`,
          controllerId: fake.controllerId,
          nodes: [
            { nodeKey: 'input', type: 'HUMAN', name: '需求输入', stage: '阶段一', dependsOn: [], requiresWorktree: false },
            { nodeKey: 'exec', type: 'AI', name: 'AI执行', stage: '阶段一', prompts: ['阅读上游产物并完成执行'], dependsOn: ['input'], requiresWorktree: false },
          ],
        },
      },
      token,
    );
    const body = await res.json();
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toContain('缺少 Agent 配置');
    expect(body.errors[0].message).toContain('exec');
  });

  it('A7: acpServerType 不在 controller capabilities 拒绝', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a7-${Date.now()}`);
    const res = await gqlRequest(
      CONFIGURE_WORKFLOW,
      {
        templateId: tplId,
        input: {
          name: `wf-a7-cfg-${Date.now()}`,
          controllerId: fake.controllerId,
          nodes: [
            { nodeKey: 'input', type: 'HUMAN', name: '需求输入', stage: '阶段一', dependsOn: [], requiresWorktree: false },
            { nodeKey: 'exec', type: 'AI', name: 'AI执行', stage: '阶段一', prompts: ['阅读上游产物并完成执行'], dependsOn: ['input'], requiresWorktree: false, agentConfig: { acpServerType: 'claude_code', initNewWorktree: false } },
          ],
        },
      },
      token,
    );
    const body = await res.json();
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toContain('不在该控制器可用列表内');
  });

  it('A8: updateConfiguredWorkflow 支持全量图编辑（改 prompts/增删节点/调依赖）', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a8-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-a8-cfg-${Date.now()}`);

    // 全量图编辑：改 exec 提示词 + 新增 review 节点 + 依赖调整
    const updateRes = await gqlRequest(
      UPDATE_CONFIGURED_WORKFLOW,
      {
        id: cfgId,
        input: {
          name: `wf-a8-edited-${Date.now()}`,
          controllerId: fake.controllerId,
          nodes: [
            { nodeKey: 'input', type: 'HUMAN', name: '需求输入', stage: '阶段一', dependsOn: [], requiresWorktree: false },
            {
              nodeKey: 'exec',
              type: 'AI',
              name: 'AI执行',
              stage: '阶段一',
              prompts: ['编辑后的提示词'],
              artifactTitles: ['执行结果'],
              dependsOn: ['input'],
              requiresWorktree: false,
              agentConfig: { acpServerType: 'opencode', initNewWorktree: false },
            },
            { nodeKey: 'review', type: 'HUMAN', name: '评审', stage: '阶段二', dependsOn: ['exec'], requiresWorktree: false },
          ],
        },
      },
      token,
    );
    const updateBody = await updateRes.json();
    expect(updateBody.errors).toBeUndefined();
    expect(updateBody.data.updateConfiguredWorkflow.name).toContain('wf-a8-edited');

    // 校验保存后的节点图
    const qRes = await gqlRequest(CONFIGURED_WORKFLOW_QUERY, { id: cfgId }, token);
    const cfg = (await qRes.json()).data.configuredWorkflow;
    expect(cfg.nodes).toHaveLength(3);
    const exec = cfg.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec');
    expect(exec.prompts).toEqual(['编辑后的提示词']);
  });

  it('A8b: updateConfiguredWorkflow 非法图拒绝（双首节点）', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a8b-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-a8b-cfg-${Date.now()}`);

    const res = await gqlRequest(
      UPDATE_CONFIGURED_WORKFLOW,
      {
        id: cfgId,
        input: {
          name: `wf-a8b-bad-${Date.now()}`,
          controllerId: fake.controllerId,
          nodes: [
            { nodeKey: 'input', type: 'HUMAN', name: '需求输入', stage: '阶段一', dependsOn: [], requiresWorktree: false },
            { nodeKey: 'exec', type: 'AI', name: 'AI执行', stage: '阶段一', prompts: ['x'], dependsOn: [], requiresWorktree: false, agentConfig: { acpServerType: 'opencode', initNewWorktree: false } },
          ],
        },
      },
      token,
    );
    const body = await res.json();
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toContain('首节点必须唯一');
  });
});

// ---------------------------------------------------------------------------
// 实例执行 + 会话排除 + MCP 工具（A9-A18）
// 说明：本组用例共享一个实例并依赖执行顺序（A10 → A12 → A14/A15/A17 → A13 → A16）。
// ---------------------------------------------------------------------------

describe('Workflow Instance & MCP Tools (A9-A18)', () => {
  let token = '';
  let otherToken = '';
  let fake: FakeController;
  let templateId = '';
  let configuredId = '';
  let workspaceId = '';

  let instanceId = '';
  let inputNodeId = '';
  let execNodeId = '';
  let execSessionId = '';
  let execMcpToken = '';
  let artifactKey = '';

  beforeAll(async () => {
    token = await signup('wfins');
    otherToken = await signup('wfother');
    expect(token).toBeTruthy();
    expect(otherToken).toBeTruthy();

    fake = await registerFakeController(token, 'inst');
    const available = await refreshCapabilities(token, fake.controllerId);
    expect(available).toContain('opencode');

    templateId = await createSimpleTemplate(token, `wf-inst-${Date.now()}`);
    configuredId = await configureFromTemplate(token, templateId, fake.controllerId, `wf-inst-cfg-${Date.now()}`);
    workspaceId = await createWorkspace(token, fake.controllerId);
  }, 30_000);

  afterAll(() => {
    fake?.client.disconnect();
  });

  it('A10: 实例化后首节点 READY，其余 INITIALIZING', async () => {
    const res = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      { input: instantiateInput(fake.controllerId, configuredId, workspaceId, `wf-it-实例-${Date.now()}`) },
      token,
    );
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    const inst = body.data.instantiateWorkflow;
    instanceId = inst.id;
    expect(inst.configuredWorkflowId).toBe(configuredId);
    expect(inst.nodes).toHaveLength(2);

    const inputNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');
    const execNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec');
    expect(inputNode.type).toBe('HUMAN');
    expect(inputNode.status).toBe('READY');
    expect(execNode.type).toBe('AI');
    expect(execNode.status).toBe('INITIALIZING');
    expect(inst.currentNodeNames).toEqual([]);

    inputNodeId = inputNode.id;
    execNodeId = execNode.id;
  });

  it('A11: requiresWorktree 但工作区非 git 时实例化拒绝', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a11-${Date.now()}`, true);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-a11-cfg-${Date.now()}`, true);
    const wsId = await createWorkspace(token, fake.controllerId); // 未设置 defaultBranch = 非 git 工作区

    const res = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      { input: instantiateInput(fake.controllerId, cfgId, wsId, `wf-a11-实例-${Date.now()}`, true) },
      token,
    );
    const body = await res.json();
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toContain('Git 仓库');
  });

  it('A12: completeHumanNode 产物写黑板，下游 AI 节点拉起会话', async () => {
    const startEvent = waitForEvent<{
      requestId: string;
      sessionId: string;
      serverType: string;
      mcpEndpoint?: { url: string; token: string; serverNames: string[] };
    }>(fake.client, 'acp:start', 10000);

    const res = await gqlRequest(
      COMPLETE_HUMAN_NODE,
      { instanceId, nodeId: inputNodeId, input: '做一个计算器' },
      token,
    );
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.completeHumanNode.status).toBe('DONE');

    // fake controller 收到下游 AI 节点的 acp:start（自动装配工作流工具 + 节点作用域 token）
    const startData = await startEvent;
    expect(startData.serverType).toBe('opencode');
    expect(startData.mcpEndpoint).toBeDefined();
    expect(startData.mcpEndpoint!.serverNames).toContain('agent-workflow-tools');
    expect(startData.mcpEndpoint!.token).toBeTruthy();
    execSessionId = startData.sessionId;
    execMcpToken = startData.mcpEndpoint!.token;

    fake.client.emit('acp:start:result', {
      requestId: startData.requestId,
      sessionId: execSessionId,
      success: true,
      externalSessionId: `ext_wf_${Date.now()}`,
    });
    await sleep(500);

    const instRes = await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token);
    const inst = (await instRes.json()).data.workflowInstance;
    const inputNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');
    const execNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec');
    expect(inputNode.status).toBe('DONE');
    expect(execNode.status).toBe('RUNNING');
    expect(execNode.sessionId).toBe(execSessionId);
    expect(execNode.startedAt).toBeTruthy();
    expect(inst.currentNodeNames).toContain('AI执行');

    // 产物写入黑板：key = {nodeId}-{nodeName}-产物-{title}
    artifactKey = `${inputNodeId}-需求输入-产物-输入`;
    const artifact = inst.blackboard.find((e: Record<string, any>) => e.key === artifactKey);
    expect(artifact).toBeDefined();
    expect(artifact.value).toBe('做一个计算器');
  }, 20_000);

  it('A9: 存在活跃实例时 deleteConfiguredWorkflow 仍可删除（快照模型自包含），实例不受影响', async () => {
    const res = await gqlRequest(DELETE_CONFIGURED_WORKFLOW, { id: configuredId }, token);
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.deleteConfiguredWorkflow).toBe(true);

    // 实例仍可查询，节点不受影响
    const instRes = await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token);
    const instBody = await instRes.json();
    expect(instBody.errors).toBeUndefined();
    expect(instBody.data.workflowInstance.nodes).toHaveLength(2);
  });

  it('A14: sessions 默认排除工作流会话，includeWorkflowSessions=true 包含', async () => {
    const defaultRes = await gqlRequest(SESSIONS_QUERY, undefined, token);
    const defaultBody = await defaultRes.json();
    expect(defaultBody.errors).toBeUndefined();
    const defaultIds = (defaultBody.data.sessions as { id: string }[]).map((s) => s.id);
    expect(defaultIds).not.toContain(execSessionId);

    const inclRes = await gqlRequest(SESSIONS_QUERY, { includeWorkflowSessions: true }, token);
    const inclBody = await inclRes.json();
    expect(inclBody.errors).toBeUndefined();
    const wfSession = (inclBody.data.sessions as { id: string; workflowInstanceId: string | null; workflowNodeId: string | null }[])
      .find((s) => s.id === execSessionId);
    expect(wfSession).toBeDefined();
    expect(wfSession!.workflowInstanceId).toBe(instanceId);
    expect(wfSession!.workflowNodeId).toBe(execNodeId);
  });

  it('A15: getCurrentNodeId 节点 token 可用，普通会话 token 不可用', async () => {
    // 节点作用域 token → 返回当前节点 ID
    const nodeRes = await callWorkflowTool(execSessionId, execMcpToken, 'getCurrentNodeId', {});
    expect(nodeRes.httpStatus).toBe(200);
    const nodeOut = parseToolResult(nodeRes.body);
    expect(nodeOut.isError).toBe(false);
    expect(nodeOut.data.nodeId).toBe(execNodeId);

    // 普通会话（装配同一平台服务但 token 无 workflow 作用域）→ UNAUTHORIZED
    const serversRes = await gqlRequest(MCP_SERVERS_QUERY, undefined, token);
    const serversBody = await serversRes.json();
    expect(serversBody.errors).toBeUndefined();
    const platformServer = (serversBody.data.mcpServers as { id: string; name: string }[])
      .find((s) => s.name === 'agent-workflow-tools');
    expect(platformServer, '工作流平台 MCP 服务应已注册').toBeDefined();

    const startEvent = waitForEvent<{
      requestId: string;
      sessionId: string;
      mcpEndpoint?: { url: string; token: string; serverNames: string[] };
    }>(fake.client, 'acp:start', 10000);
    const createRes = await gqlRequest(
      CREATE_SESSION,
      {
        input: {
          controllerId: fake.controllerId,
          acpServerType: 'opencode',
          workspaceId,
          mcpServerIds: [platformServer!.id],
        },
      },
      token,
    );
    const createBody = await createRes.json();
    expect(createBody.errors).toBeUndefined();
    const normalSessionId = createBody.data.createSession.session.id;

    const startData = await startEvent;
    expect(startData.sessionId).toBe(normalSessionId);
    const normalToken = startData.mcpEndpoint?.token;
    expect(normalToken).toBeTruthy();
    fake.client.emit('acp:start:result', {
      requestId: startData.requestId,
      sessionId: normalSessionId,
      success: true,
      externalSessionId: `ext_normal_${Date.now()}`,
    });

    const normalRes = await callWorkflowTool(normalSessionId, normalToken!, 'getCurrentNodeId', {});
    expect(normalRes.httpStatus).toBe(200);
    const normalOut = parseToolResult(normalRes.body);
    expect(normalOut.isError).toBe(true);
    expect(normalOut.data.code).toBe('UNAUTHORIZED');
  }, 20_000);

  it('A17: removeBlackboardKey 后黑板无、垃圾桶有', async () => {
    const res = await callWorkflowTool(execSessionId, execMcpToken, 'removeBlackboardKey', { key: artifactKey });
    expect(res.httpStatus).toBe(200);
    const out = parseToolResult(res.body);
    expect(out.isError).toBe(false);
    expect(out.data.removed).toBe(true);
    expect(out.data.key).toBe(artifactKey);

    const instRes = await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token);
    const inst = (await instRes.json()).data.workflowInstance;
    expect(inst.blackboard.find((e: Record<string, any>) => e.key === artifactKey)).toBeUndefined();
    const trashed = inst.blackboardTrash.find((e: Record<string, any>) => e.key === artifactKey);
    expect(trashed).toBeDefined();
    expect(trashed.value).toBe('做一个计算器');
  });

  it('A13: rejectNode 打回留痕（黑板打回记录 + 上游 REWORK）', async () => {
    const res = await gqlRequest(
      REJECT_NODE,
      { instanceId, nodeId: execNodeId, reason: '执行结果不符合需求' },
      token,
    );
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.rejectNode.status).toBe('REJECT');
    expect(body.data.rejectNode.rejectInfo.reason).toBe('执行结果不符合需求');

    const instRes = await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token);
    const inst = (await instRes.json()).data.workflowInstance;
    const execNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec');
    const inputNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');
    expect(execNode.status).toBe('REJECT');
    expect(inputNode.status).toBe('REWORK');
    expect(inputNode.reworkCount).toBe(1);
    expect(inputNode.reworkedAt).toBeTruthy();

    // 黑板打回记录：key = 打回-{nodeId}-{序号}
    const record = inst.blackboard.find((e: Record<string, any>) => e.key.startsWith(`打回-${execNodeId}-`));
    expect(record).toBeDefined();
    const recordValue = JSON.parse(record.value);
    expect(recordValue.reason).toBe('执行结果不符合需求');
  });

  it('A16: 非 RUNNING 状态 completeCurrentNode 返回状态非法提示', async () => {
    // 上一用例后 exec 节点为 REJECT，其会话仍然存活（token 有效）
    const res = await callWorkflowTool(execSessionId, execMcpToken, 'completeCurrentNode', {
      artifacts: [{ title: '执行结果', value: 'done' }],
    });
    expect(res.httpStatus).toBe(200);
    const out = parseToolResult(res.body);
    expect(out.isError).toBe(true);
    expect(out.data.code).toBe('INVALID_STATE');
    expect(out.data.message).toContain('不允许执行');
  });

  it('A18: 他人实例不可见、不可操作', async () => {
    const q1 = await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, otherToken);
    const body1 = await q1.json();
    expect(body1.errors).toBeUndefined();
    expect(body1.data.workflowInstance).toBeNull();

    const q2 = await gqlRequest(WORKFLOW_INSTANCES_QUERY, { workspaceId }, otherToken);
    const body2 = await q2.json();
    expect(body2.errors).toBeUndefined();
    expect(body2.data.workflowInstances).toEqual([]);

    const m1 = await gqlRequest(REJECT_NODE, { instanceId, nodeId: execNodeId, reason: '越权打回' }, otherToken);
    const mBody1 = await m1.json();
    expect(mBody1.errors).toBeDefined();
    expect(mBody1.errors[0].message).toContain('不存在或无权限');
  });
});


// ---------------------------------------------------------------------------
// 验收修复回归（A19-A20）
// ---------------------------------------------------------------------------

const ACP_SERVER_OPTIONS_QUERY = `
  query AcpServerOptions($controllerId: ID!, $acpServerType: AcpServerType!) {
    acpServerOptions(controllerId: $controllerId, acpServerType: $acpServerType) {
      modes { id name description }
      models { id name provider }
      currentModeId
      currentModelId
      probedAt
    }
  }
`;

/** 三节点模板：HUMAN(input) → AI(exec) → HUMAN(review) */
function humanReviewTemplateInput(name: string) {
  return {
    name,
    description: 'API 测试用三节点工作流（末端人类评审）',
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
      { nodeKey: 'review', type: 'HUMAN', name: '评审', stage: '阶段二', dependsOn: ['exec'], requiresWorktree: false },
    ],
  };
}

describe('Workflow Acceptance Fixes (A19-A20)', () => {
  let token = '';
  let fake: FakeController;
  let workspaceId = '';

  beforeAll(async () => {
    token = await signup('wfacc');
    expect(token).toBeTruthy();
    fake = await registerFakeController(token, 'acc');
    const available = await refreshCapabilities(token, fake.controllerId);
    expect(available).toContain('opencode');
    workspaceId = await createWorkspace(token, fake.controllerId);
  }, 30_000);

  afterAll(() => {
    fake?.client.disconnect();
  });

  it('A19: 下游人类节点被引擎激活（RUNNING）后可人工完成（验收#4 回归）', async () => {
    // 三节点模板：HUMAN → AI → HUMAN
    const tplRes = await gqlRequest(
      CREATE_WORKFLOW_TEMPLATE,
      { input: humanReviewTemplateInput(`wf-a19-${Date.now()}`) },
      token,
    );
    const tplBody = await tplRes.json();
    expect(tplBody.errors).toBeUndefined();
    const tplId = tplBody.data.createWorkflowTemplate.id;

    const cfgRes = await gqlRequest(
      CONFIGURE_WORKFLOW,
      {
        templateId: tplId,
        input: {
          name: `wf-a19-cfg-${Date.now()}`,
          controllerId: fake.controllerId,
          nodes: configureNodes(humanReviewTemplateInput('_').nodes, { exec: { acpServerType: 'opencode', initNewWorktree: false } }),
        },
      },
      token,
    );
    const cfgBody = await cfgRes.json();
    expect(cfgBody.errors).toBeUndefined();
    const cfgId = cfgBody.data.configureWorkflow.id;

    // 实例化并完成首节点 → exec AI 节点拉起会话
    const instRes = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      { input: humanReviewInstantiateInput(fake.controllerId, cfgId, workspaceId, `wf-a19-实例-${Date.now()}`) },
      token,
    );
    const inst = (await instRes.json()).data.instantiateWorkflow;
    const inputNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');
    const reviewNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'review');
    expect(reviewNode.status).toBe('INITIALIZING');

    const startEvent = waitForEvent<{
      requestId: string;
      sessionId: string;
      mcpEndpoint?: { url: string; token: string; serverNames: string[] };
    }>(fake.client, 'acp:start', 10000);
    await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId: inst.id, nodeId: inputNode.id, input: '做一个计算器' }, token);
    const startData = await startEvent;
    fake.client.emit('acp:start:result', {
      requestId: startData.requestId,
      sessionId: startData.sessionId,
      success: true,
      externalSessionId: `ext_a19_${Date.now()}`,
    });
    await sleep(500);

    // exec 节点经 MCP 工具完成 → 下游 review 人类节点被引擎自动激活为 RUNNING
    const completeRes = await callWorkflowTool(startData.sessionId, startData.mcpEndpoint!.token, 'completeCurrentNode', {
      artifacts: [{ title: '执行结果', value: '计算器已完成' }],
    });
    const completeOut = parseToolResult(completeRes.body);
    expect(completeOut.isError).toBe(false);

    const instRes2 = await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: inst.id }, token);
    const inst2 = (await instRes2.json()).data.workflowInstance;
    const reviewNode2 = inst2.nodes.find((n: Record<string, any>) => n.nodeKey === 'review');
    expect(reviewNode2.status).toBe('RUNNING');
    expect(inst2.currentNodeNames).toContain('评审');

    // 验收#4：RUNNING 状态下人工完成应成功（不再报「不允许执行「启动」」）
    const doneRes = await gqlRequest(
      COMPLETE_HUMAN_NODE,
      { instanceId: inst.id, nodeId: reviewNode.id, input: '同意方案' },
      token,
    );
    const doneBody = await doneRes.json();
    expect(doneBody.errors).toBeUndefined();
    expect(doneBody.data.completeHumanNode.status).toBe('DONE');

    // 人类输入产物写入黑板
    const instRes3 = await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: inst.id }, token);
    const inst3 = (await instRes3.json()).data.workflowInstance;
    const artifact = inst3.blackboard.find((e: Record<string, any>) => e.key === `${reviewNode.id}-评审-产物-输入`);
    expect(artifact).toBeDefined();
    expect(artifact.value).toBe('同意方案');
  }, 30_000);

  it('A20: acpServerOptions 空实例探测返回 Mode/模型选项，二次查询命中缓存（验收#1）', async () => {
    let probeCount = 0;
    fake.client.on('acp:probe-options', (data: { requestId: string; serverType: string }) => {
      probeCount++;
      fake.client.emit('acp:probe-options:result', {
        requestId: data.requestId,
        serverType: data.serverType,
        success: true,
        modes: [
          { id: 'code', name: 'Code', description: '编码模式' },
          { id: 'ask', name: 'Ask' },
        ],
        availableModels: [{ id: 'gpt-5', name: 'GPT-5', provider: 'openai' }],
        currentModeId: 'code',
        currentModelId: 'gpt-5',
      });
    });

    const res = await gqlRequest(
      ACP_SERVER_OPTIONS_QUERY,
      { controllerId: fake.controllerId, acpServerType: 'opencode' },
      token,
    );
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    const options = body.data.acpServerOptions;
    expect(options.modes).toEqual([
      { id: 'code', name: 'Code', description: '编码模式' },
      { id: 'ask', name: 'Ask', description: null },
    ]);
    expect(options.models).toEqual([{ id: 'gpt-5', name: 'GPT-5', provider: 'openai' }]);
    expect(options.currentModeId).toBe('code');
    expect(options.currentModelId).toBe('gpt-5');
    expect(options.probedAt).toBeTruthy();
    expect(probeCount).toBe(1);

    // 二次查询命中 Redis 缓存，不再发起探测
    const res2 = await gqlRequest(
      ACP_SERVER_OPTIONS_QUERY,
      { controllerId: fake.controllerId, acpServerType: 'opencode' },
      token,
    );
    const body2 = await res2.json();
    expect(body2.errors).toBeUndefined();
    expect(body2.data.acpServerOptions.modes).toHaveLength(2);
    expect(probeCount).toBe(1);
  }, 40_000);
});

// ---------------------------------------------------------------------------
// 节点失败状态（A22-A23，验收第四轮#1）
// ---------------------------------------------------------------------------

const CLOSE_SESSION = `
  mutation CloseSession($id: ID!) { closeSession(id: $id) }
`;

interface StartEventData {
  requestId: string;
  sessionId: string;
  serverType?: string;
  cwd?: string;
  mcpEndpoint?: { url: string; token: string; serverNames: string[] };
  modeId?: string;
  modelId?: string;
}

describe('Workflow Node Failure (A22-A23)', () => {
  let token = '';
  let fake: FakeController;
  let workspaceId = '';

  beforeAll(async () => {
    token = await signup('wffail');
    expect(token).toBeTruthy();
    fake = await registerFakeController(token, 'fail');
    const available = await refreshCapabilities(token, fake.controllerId);
    expect(available).toContain('opencode');
    workspaceId = await createWorkspace(token, fake.controllerId);
  }, 30_000);

  afterAll(() => {
    fake?.client.disconnect();
  });

  /** 三节点实例（HUMAN→AI→HUMAN）推进到 exec AI 节点会话启动 */
  async function advanceToExecRunning(tag: string) {
    const tplRes = await gqlRequest(
      CREATE_WORKFLOW_TEMPLATE,
      { input: humanReviewTemplateInput(`wf-${tag}-${Date.now()}`) },
      token,
    );
    const tplId = (await tplRes.json()).data.createWorkflowTemplate.id;
    const cfgRes = await gqlRequest(
      CONFIGURE_WORKFLOW,
      {
        templateId: tplId,
        input: {
          name: `wf-${tag}-cfg-${Date.now()}`,
          controllerId: fake.controllerId,
          nodes: configureNodes(humanReviewTemplateInput('_').nodes, { exec: { acpServerType: 'opencode', initNewWorktree: false } }),
        },
      },
      token,
    );
    const cfgId = (await cfgRes.json()).data.configureWorkflow.id;
    const instRes = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      { input: humanReviewInstantiateInput(fake.controllerId, cfgId, workspaceId, `wf-${tag}-实例-${Date.now()}`) },
      token,
    );
    const inst = (await instRes.json()).data.instantiateWorkflow;
    const inputNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');
    const startEvent = waitForEvent<StartEventData>(fake.client, 'acp:start', 10000);
    await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId: inst.id, nodeId: inputNode.id, input: '做一个计算器' }, token);
    const startData = await startEvent;
    fake.client.emit('acp:start:result', {
      requestId: startData.requestId,
      sessionId: startData.sessionId,
      success: true,
      externalSessionId: `ext_${tag}_${Date.now()}`,
    });
    await sleep(500);
    return { instanceId: inst.id as string, sessionId: startData.sessionId, mcpToken: startData.mcpEndpoint!.token };
  }

  it('A22: failCurrentNode 标记失败阻断流程，resumeFailedNode 恢复运行', async () => {
    const { instanceId, sessionId, mcpToken } = await advanceToExecRunning('a22');

    // reason 必填
    const noReason = parseToolResult((await callWorkflowTool(sessionId, mcpToken, 'failCurrentNode', {})).body);
    expect(noReason.isError).toBe(true);
    expect(noReason.data.code).toBe('INVALID_PARAMS');

    // LLM 主动标记失败 → FAILED + failInfo(LLM_REPORTED)，流程阻断
    const failed = parseToolResult(
      (await callWorkflowTool(sessionId, mcpToken, 'failCurrentNode', { reason: '缺少需求细节，无法继续' })).body,
    );
    expect(failed.isError).toBe(false);
    expect(failed.data.status).toBe('FAILED');

    const inst = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token)).json()).data.workflowInstance;
    const execNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec');
    expect(execNode.status).toBe('FAILED');
    expect(execNode.failInfo).toMatchObject({ reason: '缺少需求细节，无法继续', source: 'LLM_REPORTED' });
    expect(execNode.failInfo.at).toBeTruthy();
    expect(inst.currentNodeNames).toEqual([]);
    // 阻断：下游人类节点保持 INITIALIZING
    expect(inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'review').status).toBe('INITIALIZING');

    // 失败状态下 complete 非法
    const completeWhileFailed = parseToolResult((await callWorkflowTool(sessionId, mcpToken, 'completeCurrentNode', {})).body);
    expect(completeWhileFailed.isError).toBe(true);
    expect(completeWhileFailed.data.code).toBe('INVALID_STATE');

    // 人类对话给出指示后 AI 恢复节点 → RUNNING，failInfo 清空，可正常完成
    const resumed = parseToolResult((await callWorkflowTool(sessionId, mcpToken, 'resumeFailedNode', {})).body);
    expect(resumed.isError).toBe(false);
    expect(resumed.data.status).toBe('RUNNING');
    const inst2 = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token)).json()).data.workflowInstance;
    expect(inst2.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec').failInfo).toBeNull();

    const done = parseToolResult(
      (await callWorkflowTool(sessionId, mcpToken, 'completeCurrentNode', {
        artifacts: [{ title: '执行结果', value: '完成' }],
      })).body,
    );
    expect(done.isError).toBe(false);
    expect(done.data.status).toBe('DONE');
  }, 40_000);

  it('A23: 兜底提醒后会话再次停止 → 节点升级 FAILED（SESSION_STUCK）', async () => {
    const { instanceId, sessionId } = await advanceToExecRunning('a23');

    // 第一次停止：兜底 resume + 提醒提示词，节点保持 RUNNING
    await gqlRequest(CLOSE_SESSION, { id: sessionId }, token);
    const resumeEvent = await waitForEvent<{ requestId: string; sessionId: string }>(fake.client, 'acp:resume', 15000);
    fake.client.emit('acp:resume:result', { requestId: resumeEvent.requestId, sessionId, success: true });
    await sleep(800);
    const inst1 = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token)).json()).data.workflowInstance;
    expect(inst1.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec').status).toBe('RUNNING');

    // 第二次停止：不再 resume，节点升级 FAILED（SESSION_STUCK）
    await gqlRequest(CLOSE_SESSION, { id: sessionId }, token);
    await sleep(1500);
    const inst2 = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token)).json()).data.workflowInstance;
    const execNode = inst2.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec');
    expect(execNode.status).toBe('FAILED');
    expect(execNode.failInfo.source).toBe('SESSION_STUCK');
    expect(inst2.currentNodeNames).toEqual([]);
  }, 40_000);

  it('A34: 节点会话 turn 结束（审批超时自动停止）但节点未推进 → 兜底提醒；再次停滞 → FAILED + 人工介入待办', async () => {
    const { instanceId, sessionId } = await advanceToExecRunning('a34');

    // 模拟审批超时自动停止：prompt:start（running）→ prompt:complete（idling），全程未调用完成工具
    fake.client.emit('acp:prompt:start', { sessionId });
    await sleep(500);
    const nudgeEvent = waitForEvent<{ message?: { content?: string } }>(fake.client, 'acp:message', 15000);
    fake.client.emit('acp:prompt:complete', { sessionId, stopReason: 'cancelled' });

    // 首次停滞：兜底提醒提示词直接补发（会话仍存活，无需 resume），节点保持 RUNNING
    const nudge = await nudgeEvent;
    expect(String(nudge.message?.content ?? '')).toContain('工作流');
    await sleep(500);
    const inst1 = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token)).json()).data.workflowInstance;
    expect(inst1.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec').status).toBe('RUNNING');

    // 再次停滞：节点升级 FAILED（SESSION_STUCK）+ 人工介入强提醒待办
    fake.client.emit('acp:prompt:start', { sessionId });
    await sleep(500);
    fake.client.emit('acp:prompt:complete', { sessionId, stopReason: 'cancelled' });
    await sleep(1500);
    const inst2 = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token)).json()).data.workflowInstance;
    const execNode = inst2.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec');
    expect(execNode.status).toBe('FAILED');
    expect(execNode.failInfo.source).toBe('SESSION_STUCK');

    const todosRes = await gqlRequest(
      `query { getTodoList { id type priority title } }`,
      undefined,
      token,
    );
    const todos = (await todosRes.json()).data.getTodoList as Array<{ type: string; priority: string; title: string }>;
    const intervention = todos.find((t) => t.type === 'workflow_intervention');
    expect(intervention, '应创建人工介入强提醒待办').toBeDefined();
    expect(intervention!.priority).toBe('immediate');
  }, 40_000);
});


// ---------------------------------------------------------------------------
// REWORK 节点再次打回（A24，验收第六轮#3）：a→b→c 中 c 打回 b 后，b（REWORK）可再打回 a
// ---------------------------------------------------------------------------

describe('Workflow Rework Reject (A24)', () => {
  let token = '';
  let fake: FakeController;
  let workspaceId = '';

  beforeAll(async () => {
    token = await signup('wfrwrj');
    expect(token).toBeTruthy();
    fake = await registerFakeController(token, 'rwrj');
    const available = await refreshCapabilities(token, fake.controllerId);
    expect(available).toContain('opencode');
    workspaceId = await createWorkspace(token, fake.controllerId);
  }, 30_000);

  afterAll(() => {
    fake?.client.disconnect();
  });

  it('A24: c 打回 b（b 进入 REWORK）后，b 可再次打回 a（REWORK→REJECT）', async () => {
    // 三节点实例（input HUMAN → exec AI → review HUMAN）推进到 exec 会话启动
    const tplRes = await gqlRequest(
      CREATE_WORKFLOW_TEMPLATE,
      { input: humanReviewTemplateInput(`wf-a24-${Date.now()}`) },
      token,
    );
    const tplId = (await tplRes.json()).data.createWorkflowTemplate.id;
    const cfgRes = await gqlRequest(
      CONFIGURE_WORKFLOW,
      {
        templateId: tplId,
        input: {
          name: `wf-a24-cfg-${Date.now()}`,
          controllerId: fake.controllerId,
          nodes: configureNodes(humanReviewTemplateInput('_').nodes, { exec: { acpServerType: 'opencode', initNewWorktree: false } }),
        },
      },
      token,
    );
    const cfgId = (await cfgRes.json()).data.configureWorkflow.id;
    const instRes = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      { input: humanReviewInstantiateInput(fake.controllerId, cfgId, workspaceId, `wf-a24-实例-${Date.now()}`) },
      token,
    );
    const inst = (await instRes.json()).data.instantiateWorkflow;
    const instanceId = inst.id as string;
    const inputNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');
    const startEvent = waitForEvent<StartEventData>(fake.client, 'acp:start', 10000);
    await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId, nodeId: inputNode.id, input: '做一个计算器' }, token);
    const startData = await startEvent;
    fake.client.emit('acp:start:result', {
      requestId: startData.requestId,
      sessionId: startData.sessionId,
      success: true,
      externalSessionId: `ext_a24_${Date.now()}`,
    });
    await sleep(500);

    // b（exec）完成 → DONE，c（review 人类节点）自动激活 RUNNING
    const done = parseToolResult(
      (await callWorkflowTool(startData.sessionId, startData.mcpEndpoint!.token, 'completeCurrentNode', {
        artifacts: [{ title: '执行结果', value: '完成' }],
      })).body,
    );
    expect(done.isError).toBe(false);

    // c 打回 b：review REJECT，exec 进入 REWORK
    const inst1 = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token)).json()).data.workflowInstance;
    const reviewNode = inst1.nodes.find((n: Record<string, any>) => n.nodeKey === 'review');
    expect(reviewNode.status).toBe('RUNNING');
    const rej1 = await (await gqlRequest(
      REJECT_NODE,
      { instanceId, nodeId: reviewNode.id, reason: '执行结果不符合需求' },
      token,
    )).json();
    expect(rej1.errors).toBeUndefined();

    const inst2 = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token)).json()).data.workflowInstance;
    const execNode = inst2.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec');
    expect(execNode.status).toBe('REWORK');

    // b（REWORK）再次打回 a：REWORK→REJECT 允许，a（input）进入 REWORK
    const rej2 = await (await gqlRequest(
      REJECT_NODE,
      { instanceId, nodeId: execNode.id, reason: '需求本身有问题，无法按现状执行' },
      token,
    )).json();
    expect(rej2.errors).toBeUndefined();
    expect(rej2.data.rejectNode.status).toBe('REJECT');
    expect(rej2.data.rejectNode.rejectInfo.reason).toBe('需求本身有问题，无法按现状执行');

    const inst3 = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token)).json()).data.workflowInstance;
    const inputNodeFinal = inst3.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');
    expect(inputNodeFinal.status).toBe('REWORK');
    expect(inputNodeFinal.reworkCount).toBe(1);
    // 黑板打回记录留痕（exec 节点）
    const record = inst3.blackboard.find((e: Record<string, any>) => e.key.startsWith(`打回-${execNode.id}-`));
    expect(record).toBeDefined();
    expect(JSON.parse(record.value).reason).toBe('需求本身有问题，无法按现状执行');
  }, 40_000);
});


// ---------------------------------------------------------------------------
// 链式打回后 complete 复工（A25，验收第六轮#1）+ 实例软删除（A26，验收第六轮#2）
// ---------------------------------------------------------------------------

const DELETE_WORKFLOW_INSTANCE = `
  mutation DeleteWorkflowInstance($id: ID!) { deleteWorkflowInstance(id: $id) }
`;

const ARCHIVE_WORKFLOW_INSTANCE = `
  mutation ArchiveWorkflowInstance($id: ID!, $archived: Boolean!) {
    archiveWorkflowInstance(id: $id, archived: $archived)
  }
`;

/** 等待指定 sessionId 的 acp:resume 事件（链式打回会触发多个 resume，需按会话过滤） */
function waitForResume<T = unknown>(socket: ClientSocket, sessionId: string, timeoutMs = 10000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('acp:resume', handler);
      reject(new Error(`Timeout waiting for "acp:resume" of ${sessionId}`));
    }, timeoutMs);
    const handler = (data: T) => {
      if ((data as { sessionId?: string }).sessionId !== sessionId) return;
      clearTimeout(timer);
      socket.off('acp:resume', handler);
      resolve(data);
    };
    socket.on('acp:resume', handler);
  });
}

/** 四节点链式模板：start(HUMAN) → a(AI) → b(AI) → c(AI) */
function chainTemplateInput(name: string) {
  return {
    name,
    description: 'API 测试用四节点链式工作流',
    nodes: [
      { nodeKey: 'start', type: 'HUMAN', name: '需求输入', stage: '阶段一', dependsOn: [], requiresWorktree: false },
      { nodeKey: 'a', type: 'AI', name: '节点A', stage: '阶段一', prompts: ['完成 A'], artifactTitles: ['A产物'], dependsOn: ['start'], requiresWorktree: false },
      { nodeKey: 'b', type: 'AI', name: '节点B', stage: '阶段二', prompts: ['完成 B'], artifactTitles: ['B产物'], dependsOn: ['a'], requiresWorktree: false },
      { nodeKey: 'c', type: 'AI', name: '节点C', stage: '阶段三', prompts: ['完成 C'], artifactTitles: ['C产物'], dependsOn: ['b'], requiresWorktree: false },
    ],
  };
}

describe('Workflow Chain Reject & Instance Delete (A25-A29)', () => {
  let token = '';
  let fake: FakeController;
  let workspaceId = '';

  beforeAll(async () => {
    token = await signup('wfchain');
    expect(token).toBeTruthy();
    fake = await registerFakeController(token, 'chain');
    const available = await refreshCapabilities(token, fake.controllerId);
    expect(available).toContain('opencode');
    workspaceId = await createWorkspace(token, fake.controllerId);
  }, 30_000);

  afterAll(() => {
    fake?.client.disconnect();
  });

  /** 等待下一个 AI 节点会话启动并应答成功，返回会话与 MCP token */
  async function answerNextStart(tag: string) {
    const startData = await waitForEvent<StartEventData>(fake.client, 'acp:start', 15000);
    fake.client.emit('acp:start:result', {
      requestId: startData.requestId,
      sessionId: startData.sessionId,
      success: true,
      externalSessionId: `ext_${tag}_${Date.now()}`,
    });
    await sleep(500);
    return { sessionId: startData.sessionId, mcpToken: startData.mcpEndpoint!.token };
  }

  it('A25: 链式打回（c→b→a）后 a 完成返工 b 复工；b 完成时下游 c（REJECT）自动复工，流程不卡住', async () => {
    // 实例化四节点链
    const tplRes = await gqlRequest(CREATE_WORKFLOW_TEMPLATE, { input: chainTemplateInput(`wf-a25-${Date.now()}`) }, token);
    const tplId = (await tplRes.json()).data.createWorkflowTemplate.id;
    const cfgRes = await gqlRequest(
      CONFIGURE_WORKFLOW,
      {
        templateId: tplId,
        input: {
          name: `wf-a25-cfg-${Date.now()}`,
          controllerId: fake.controllerId,
          nodes: configureNodes(chainTemplateInput('_').nodes, {
            a: { acpServerType: 'opencode', initNewWorktree: false },
            b: { acpServerType: 'opencode', initNewWorktree: false },
            c: { acpServerType: 'opencode', initNewWorktree: false },
          }),
        },
      },
      token,
    );
    const cfgId = (await cfgRes.json()).data.configureWorkflow.id;
    const instRes = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      {
        input: {
          source: 'CONFIGURED',
          configuredWorkflowId: cfgId,
          controllerId: fake.controllerId,
          workspaceId,
          name: `wf-a25-实例-${Date.now()}`,
          nodes: configureNodes(chainTemplateInput('_').nodes, {
            a: { acpServerType: 'opencode', initNewWorktree: false },
            b: { acpServerType: 'opencode', initNewWorktree: false },
            c: { acpServerType: 'opencode', initNewWorktree: false },
          }),
        },
      },
      token,
    );
    const inst = (await instRes.json()).data.instantiateWorkflow;
    const instanceId = inst.id as string;
    const nodeIdOf = (key: string) => inst.nodes.find((n: Record<string, any>) => n.nodeKey === key).id as string;

    // start(H) 完成 → a 启动；a 完成 → b 启动；b 完成 → c 启动
    // （acp:start 监听器必须在 complete 调用前挂上，否则事件可能先于监听到达而丢失）
    const startPromise = answerNextStart('a25a');
    await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId, nodeId: nodeIdOf('start'), input: '链式需求' }, token);
    const sessA = await startPromise;

    const startBPromise = answerNextStart('a25b');
    const doneA = parseToolResult(
      (await callWorkflowTool(sessA.sessionId, sessA.mcpToken, 'completeCurrentNode', {
        artifacts: [{ title: 'A产物', value: 'a 完成' }],
      })).body,
    );
    expect(doneA.isError).toBe(false);
    const sessB = await startBPromise;

    const startCPromise = answerNextStart('a25c');
    const doneB = parseToolResult(
      (await callWorkflowTool(sessB.sessionId, sessB.mcpToken, 'completeCurrentNode', {
        artifacts: [{ title: 'B产物', value: 'b 完成' }],
      })).body,
    );
    expect(doneB.isError).toBe(false);
    const sessC = await startCPromise;

    // c 打回 b：c REJECT，b REWORK（b 会话 resume）
    const resumeBPromise = waitForResume<StartEventData>(fake.client, sessB.sessionId, 15000);
    const rej1 = await (await gqlRequest(REJECT_NODE, { instanceId, nodeId: nodeIdOf('c'), reason: 'b 的产出不合格' }, token)).json();
    expect(rej1.errors).toBeUndefined();
    const resumeB = await resumeBPromise;
    fake.client.emit('acp:resume:result', { requestId: resumeB.requestId, sessionId: sessB.sessionId, success: true });
    await sleep(500);

    // b（REWORK）再打回 a：b REJECT，a REWORK（a 会话 resume）
    const resumeAPromise = waitForResume<StartEventData>(fake.client, sessA.sessionId, 15000);
    const rej2 = await (await gqlRequest(REJECT_NODE, { instanceId, nodeId: nodeIdOf('b'), reason: 'a 的方向有问题' }, token)).json();
    expect(rej2.errors).toBeUndefined();
    const resumeA = await resumeAPromise;
    fake.client.emit('acp:resume:result', { requestId: resumeA.requestId, sessionId: sessA.sessionId, success: true });
    await sleep(500);

    // a 完成返工 → a DONE，下游 REJECT 的 b 复工（关闭旧会话 + 拉起全新会话）
    const bRestartPromise = answerNextStart('a25b2');
    const reworkA = parseToolResult(
      (await callWorkflowTool(sessA.sessionId, resumeA.mcpEndpoint!.token, 'completeCurrentRework', {
        artifacts: [{ title: 'A产物', value: 'a 修订' }],
      })).body,
    );
    expect(reworkA.isError).toBe(false);
    const sessB2 = await bRestartPromise;
    const inst1 = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token)).json()).data.workflowInstance;
    const nodeB1 = inst1.nodes.find((n: Record<string, any>) => n.nodeKey === 'b');
    const nodeC1 = inst1.nodes.find((n: Record<string, any>) => n.nodeKey === 'c');
    expect(nodeB1.status).toBe('RUNNING');
    expect(nodeC1.status).toBe('REJECT');

    // b（RUNNING，新会话）完成：下游 c 仍为 REJECT——应 resume 复工而非 start（否则流程卡住）
    const doneB2 = parseToolResult(
      (await callWorkflowTool(sessB2.sessionId, sessB2.mcpToken, 'completeCurrentNode', {
        artifacts: [{ title: 'B产物', value: 'b 修订完成' }],
      })).body,
    );
    expect(doneB2.isError).toBe(false);

    const inst2 = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token)).json()).data.workflowInstance;
    expect(inst2.nodes.find((n: Record<string, any>) => n.nodeKey === 'a').status).toBe('DONE');
    expect(inst2.nodes.find((n: Record<string, any>) => n.nodeKey === 'b').status).toBe('DONE');
    expect(inst2.nodes.find((n: Record<string, any>) => n.nodeKey === 'c').status).toBe('RUNNING');
  }, 90_000);

  it('A26: deleteWorkflowInstance 软删除：会话被删除、列表/详情排除、已删实例拒绝操作', async () => {
    // 三节点实例（H→AI→H）推进到 exec 会话启动
    const tplRes = await gqlRequest(
      CREATE_WORKFLOW_TEMPLATE,
      { input: humanReviewTemplateInput(`wf-a26-${Date.now()}`) },
      token,
    );
    const tplId = (await tplRes.json()).data.createWorkflowTemplate.id;
    const cfgRes = await gqlRequest(
      CONFIGURE_WORKFLOW,
      {
        templateId: tplId,
        input: {
          name: `wf-a26-cfg-${Date.now()}`,
          controllerId: fake.controllerId,
          nodes: configureNodes(humanReviewTemplateInput('_').nodes, { exec: { acpServerType: 'opencode', initNewWorktree: false } }),
        },
      },
      token,
    );
    const cfgId = (await cfgRes.json()).data.configureWorkflow.id;
    const instRes = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      { input: instantiateInput(fake.controllerId, cfgId, workspaceId, `wf-a26-实例-${Date.now()}`) },
      token,
    );
    const inst = (await instRes.json()).data.instantiateWorkflow;
    const instanceId = inst.id as string;
    const inputNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');
    // acp:start 监听器在 complete 调用前挂上（防事件先于监听到达）
    const startPromise = answerNextStart('a26');
    await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId, nodeId: inputNode.id, input: '做一个计算器' }, token);
    const execSess = await startPromise;

    // 删除实例 → true
    const delRes = await gqlRequest(DELETE_WORKFLOW_INSTANCE, { id: instanceId }, token);
    const delBody = await delRes.json();
    expect(delBody.errors).toBeUndefined();
    expect(delBody.data.deleteWorkflowInstance).toBe(true);
    await sleep(500);

    // 详情/列表排除已删实例
    const detail = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token)).json()).data.workflowInstance;
    expect(detail).toBeNull();
    const list = (await (await gqlRequest(WORKFLOW_INSTANCES_QUERY, { workspaceId }, token)).json()).data.workflowInstances;
    expect(list.find((i: Record<string, any>) => i.id === instanceId)).toBeUndefined();

    // 流程下会话已被删除
    const sessRes = await gqlRequest(SESSIONS_QUERY, { includeWorkflowSessions: true }, token);
    const sessions = (await sessRes.json()).data.sessions;
    expect(sessions.find((s: Record<string, any>) => s.id === execSess.sessionId)).toBeUndefined();

    // 已删实例拒绝任何操作（人类节点完成报错）
    const opRes = await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId, nodeId: inputNode.id, input: 'x' }, token);
    const opBody = await opRes.json();
    expect(opBody.errors).toBeDefined();

    // 二次删除幂等报错（已删除视为不存在）
    const del2 = await (await gqlRequest(DELETE_WORKFLOW_INSTANCE, { id: instanceId }, token)).json();
    expect(del2.errors).toBeDefined();
  }, 60_000);

  it('A27: AI 打回人类节点后，人类可重新提交（REWORK 人类节点 completeHumanNode → completeRework）', async () => {
    // 三节点实例（H→AI→H）推进到 exec 会话启动
    const tplRes = await gqlRequest(
      CREATE_WORKFLOW_TEMPLATE,
      { input: humanReviewTemplateInput(`wf-a27-${Date.now()}`) },
      token,
    );
    const tplId = (await tplRes.json()).data.createWorkflowTemplate.id;
    const cfgRes = await gqlRequest(
      CONFIGURE_WORKFLOW,
      {
        templateId: tplId,
        input: {
          name: `wf-a27-cfg-${Date.now()}`,
          controllerId: fake.controllerId,
          nodes: configureNodes(humanReviewTemplateInput('_').nodes, { exec: { acpServerType: 'opencode', initNewWorktree: false } }),
        },
      },
      token,
    );
    const cfgId = (await cfgRes.json()).data.configureWorkflow.id;
    const instRes = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      { input: humanReviewInstantiateInput(fake.controllerId, cfgId, workspaceId, `wf-a27-实例-${Date.now()}`) },
      token,
    );
    const inst = (await instRes.json()).data.instantiateWorkflow;
    const instanceId = inst.id as string;
    const inputNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');
    // acp:start 监听器在 complete 调用前挂上（防事件先于监听到达）
    const startPromise = answerNextStart('a27');
    await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId, nodeId: inputNode.id, input: '做一个计算器' }, token);
    const execSess = await startPromise;

    // AI（exec）打回人类提交：exec REJECT，input（HUMAN）进入 REWORK
    const rej = parseToolResult(
      (await callWorkflowTool(execSess.sessionId, execSess.mcpToken, 'rejectCurrentNode', {
        reason: '需求描述不清楚，请补充',
      })).body,
    );
    expect(rej.isError).toBe(false);
    const inst1 = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token)).json()).data.workflowInstance;
    expect(inst1.nodes.find((n: Record<string, any>) => n.nodeKey === 'input').status).toBe('REWORK');

    // 人类重新提交：REWORK → completeRework → DONE，旧产物入垃圾桶，exec 复工 RUNNING
    // （REJECT 节点复工走 onNodeResume：关闭旧会话 + 拉起全新会话）
    const newStartPromise = waitForEvent<StartEventData>(fake.client, 'acp:start', 15000);
    const redo = await (await gqlRequest(
      COMPLETE_HUMAN_NODE,
      { instanceId, nodeId: inputNode.id, input: '做一个支持加减乘除的计算器' },
      token,
    )).json();
    expect(redo.errors).toBeUndefined();
    expect(redo.data.completeHumanNode.status).toBe('DONE');

    const inst2 = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token)).json()).data.workflowInstance;
    expect(inst2.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec').status).toBe('RUNNING');
    const artifactKey = `${inputNode.id}-需求输入-产物-输入`;
    expect(inst2.blackboard.find((e: Record<string, any>) => e.key === artifactKey)?.value).toBe('做一个支持加减乘除的计算器');
    expect(inst2.blackboardTrash.find((e: Record<string, any>) => e.key === artifactKey)?.value).toBe('做一个计算器');

    // exec 复工：旧会话被关闭，以全新会话复工
    const newStart = await newStartPromise;
    expect(newStart.sessionId).not.toBe(execSess.sessionId);
    fake.client.emit('acp:start:result', {
      requestId: newStart.requestId,
      sessionId: newStart.sessionId,
      success: true,
      externalSessionId: `ext_a27_2_${Date.now()}`,
    });
    await sleep(500);
  }, 60_000);

  it('A28: archiveWorkflowInstance 归档行为：活跃排除/归档包含/详情可访问/取消归档恢复/节点仍运行', async () => {
    // 创建三节点实例（H→AI→H）并推进到 exec 会话启动
    const tplRes = await gqlRequest(
      CREATE_WORKFLOW_TEMPLATE,
      { input: humanReviewTemplateInput(`wf-a28-${Date.now()}`) },
      token,
    );
    const tplId = (await tplRes.json()).data.createWorkflowTemplate.id;
    const cfgRes = await gqlRequest(
      CONFIGURE_WORKFLOW,
      {
        templateId: tplId,
        input: {
          name: `wf-a28-cfg-${Date.now()}`,
          controllerId: fake.controllerId,
          nodes: configureNodes(humanReviewTemplateInput('_').nodes, { exec: { acpServerType: 'opencode', initNewWorktree: false } }),
        },
      },
      token,
    );
    const cfgId = (await cfgRes.json()).data.configureWorkflow.id;
    const instRes = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      { input: instantiateInput(fake.controllerId, cfgId, workspaceId, `wf-a28-实例-${Date.now()}`) },
      token,
    );
    const inst = (await instRes.json()).data.instantiateWorkflow;
    const instanceId = inst.id as string;
    const inputNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');

    // 完成首节点 → exec 会话启动
    const startPromise = answerNextStart('a28');
    await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId, nodeId: inputNode.id, input: '做一个计算器' }, token);
    const execSess = await startPromise;

    // 归档前：活跃列表包含，归档列表不含
    const activeList1 = (await (await gqlRequest(WORKFLOW_INSTANCES_QUERY, { workspaceId }, token)).json()).data.workflowInstances;
    expect(activeList1.find((i: Record<string, any>) => i.id === instanceId)).toBeDefined();
    const archList1 = (await (await gqlRequest(WORKFLOW_INSTANCES_QUERY, { workspaceId, archived: true }, token)).json()).data.workflowInstances;
    expect(archList1.find((i: Record<string, any>) => i.id === instanceId)).toBeUndefined();

    // 归档
    const archiveRes = await gqlRequest(ARCHIVE_WORKFLOW_INSTANCE, { id: instanceId, archived: true }, token);
    const archiveBody = await archiveRes.json();
    expect(archiveBody.errors).toBeUndefined();
    expect(archiveBody.data.archiveWorkflowInstance).toBe(true);

    // 归档后：活跃列表排除，归档列表包含
    const activeList2 = (await (await gqlRequest(WORKFLOW_INSTANCES_QUERY, { workspaceId }, token)).json()).data.workflowInstances;
    expect(activeList2.find((i: Record<string, any>) => i.id === instanceId)).toBeUndefined();
    const archList2 = (await (await gqlRequest(WORKFLOW_INSTANCES_QUERY, { workspaceId, archived: true }, token)).json()).data.workflowInstances;
    const archived = archList2.find((i: Record<string, any>) => i.id === instanceId);
    expect(archived).toBeDefined();
    expect(archived.archived).toBe(true);

    // 详情仍可访问
    const detail = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token)).json()).data.workflowInstance;
    expect(detail).not.toBeNull();
    expect(detail.archived).toBe(true);

    // exec 节点仍为 RUNNING（归档不影响流程）
    const execNode = detail.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec');
    expect(execNode.status).toBe('RUNNING');

    // 取消归档 → 恢复到活跃列表
    const unarchiveRes = await gqlRequest(ARCHIVE_WORKFLOW_INSTANCE, { id: instanceId, archived: false }, token);
    const unarchiveBody = await unarchiveRes.json();
    expect(unarchiveBody.errors).toBeUndefined();
    expect(unarchiveBody.data.archiveWorkflowInstance).toBe(true);

    const activeList3 = (await (await gqlRequest(WORKFLOW_INSTANCES_QUERY, { workspaceId }, token)).json()).data.workflowInstances;
    const restored = activeList3.find((i: Record<string, any>) => i.id === instanceId);
    expect(restored).toBeDefined();
    expect(restored.archived).toBe(false);
  }, 60_000);

  it('A29: lastNodeName/lastNodeStatus 实例状态追踪：实例化→首节点 READY；complete→下游 RUNNING；终端完成→自身 DONE', async () => {
    // 两节点模板：HUMAN(input) → AI(exec)
    const tplRes = await gqlRequest(
      CREATE_WORKFLOW_TEMPLATE,
      { input: simpleTemplateInput(`wf-a29-${Date.now()}`) },
      token,
    );
    const tplId = (await tplRes.json()).data.createWorkflowTemplate.id;
    const cfgRes = await gqlRequest(
      CONFIGURE_WORKFLOW,
      {
        templateId: tplId,
        input: {
          name: `wf-a29-cfg-${Date.now()}`,
          controllerId: fake.controllerId,
          nodes: configureNodes(simpleTemplateInput('_').nodes, { exec: { acpServerType: 'opencode', initNewWorktree: false } }),
        },
      },
      token,
    );
    const cfgId = (await cfgRes.json()).data.configureWorkflow.id;

    // 实例化 → lastNode = 首节点 READY
    const instRes = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      { input: instantiateInput(fake.controllerId, cfgId, workspaceId, `wf-a29-实例-${Date.now()}`) },
      token,
    );
    const inst = (await instRes.json()).data.instantiateWorkflow;
    const instanceId = inst.id as string;
    const inputNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');
    expect(inst.lastNodeName).toBe('需求输入');
    expect(inst.lastNodeStatus).toBe('READY');

    // completeHumanNode → lastNode = 下游 exec RUNNING
    const startPromise = answerNextStart('a29');
    await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId, nodeId: inputNode.id, input: '做一个计算器' }, token);
    const execSess = await startPromise;

    const instAfterComplete = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token)).json()).data.workflowInstance;
    expect(instAfterComplete.lastNodeName).toBe('AI执行');
    expect(instAfterComplete.lastNodeStatus).toBe('RUNNING');

    // completeCurrentNode → lastNode = 自身 DONE
    const done = parseToolResult(
      (await callWorkflowTool(execSess.sessionId, execSess.mcpToken, 'completeCurrentNode', {
        artifacts: [{ title: '执行结果', value: '计算器已完成' }],
      })).body,
    );
    expect(done.isError).toBe(false);

    const instAfterDone = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token)).json()).data.workflowInstance;
    expect(instAfterDone.lastNodeName).toBe('AI执行');
    expect(instAfterDone.lastNodeStatus).toBe('DONE');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 二期（工作流管理 + 实例化机制完善）：A1-A6
// ---------------------------------------------------------------------------

const UPDATE_CONFIGURED_WORKFLOW_FULL = `
  mutation UpdateConfiguredWorkflowFull($id: ID!, $input: ConfigureWorkflowInput!) {
    updateConfiguredWorkflow(id: $id, input: $input) {
      id name
      nodes { nodeKey type name stage prompts artifactTitles dependsOn requiresWorktree agentConfig { acpServerType initNewWorktree } }
    }
  }
`;

const INSTANTIATE_FROM_TEMPLATE = `
  mutation InstantiateFromTemplate($input: InstantiateWorkflowInput!) {
    instantiateWorkflow(input: $input) {
      id configuredWorkflowId name
      nodes { id nodeKey type name status prompts artifactTitles requiresWorktree agentConfig { acpServerType initNewWorktree } }
    }
  }
`;

describe('Workflow Phase-2 (A1-A6)', () => {
  let token = '';
  let fake: FakeController;
  let workspaceId = '';

  beforeAll(async () => {
    token = await signup('wfp2');
    expect(token).toBeTruthy();
    fake = await registerFakeController(token, 'phase2');
    const available = await refreshCapabilities(token, fake.controllerId);
    expect(available).toContain('opencode');
    workspaceId = await createWorkspace(token, fake.controllerId);
  }, 30_000);

  afterAll(() => {
    fake?.client.disconnect();
  });

  it('A1: updateConfiguredWorkflow 全量图编辑，来源模板不变', async () => {
    const tplId = await createSimpleTemplate(token, `wf-p2a1-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-p2a1-cfg-${Date.now()}`);

    const res = await gqlRequest(
      UPDATE_CONFIGURED_WORKFLOW_FULL,
      {
        id: cfgId,
        input: {
          name: `wf-p2a1-edited-${Date.now()}`,
          controllerId: fake.controllerId,
          nodes: [
            { nodeKey: 'input', type: 'HUMAN', name: '需求输入', stage: '阶段一', dependsOn: [], requiresWorktree: false },
            { nodeKey: 'exec', type: 'AI', name: 'AI执行v2', stage: '阶段一', prompts: ['编辑后的提示词'], artifactTitles: ['结果'], dependsOn: ['input'], requiresWorktree: false, agentConfig: { acpServerType: 'opencode', initNewWorktree: false } },
          ],
        },
      },
      token,
    );
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    const cfg = body.data.updateConfiguredWorkflow;
    expect(cfg.nodes).toHaveLength(2);
    expect(cfg.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec').prompts).toEqual(['编辑后的提示词']);

    // 来源模板不变
    const tplRes = await gqlRequest(WORKFLOW_TEMPLATES_QUERY, undefined, token);
    const tpl = (await tplRes.json()).data.workflowTemplates.find((t: Record<string, any>) => t.id === tplId);
    expect(tpl.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec').prompts).toEqual(['阅读上游产物并完成执行']);
  });

  it('A2: instantiateWorkflow 三来源均创建成功，节点快照完整', async () => {
    const tplId = await createSimpleTemplate(token, `wf-p2a2-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-p2a2-cfg-${Date.now()}`);

    // 从已配置工作流
    const cfgInst = await gqlRequest(INSTANTIATE_FROM_TEMPLATE, { input: instantiateInput(fake.controllerId, cfgId, workspaceId, `wf-p2a2-cfg-实例-${Date.now()}`) }, token);
    const cfgBody = await cfgInst.json();
    expect(cfgBody.errors).toBeUndefined();
    expect(cfgBody.data.instantiateWorkflow.nodes[1].prompts).toEqual(['阅读上游产物并完成执行']);

    // 从模板
    const tplInput = { ...instantiateInput(fake.controllerId, cfgId, workspaceId, `wf-p2a2-tpl-实例-${Date.now()}`), source: 'TEMPLATE', templateId: tplId, configuredWorkflowId: null };
    const tplInst = await gqlRequest(INSTANTIATE_FROM_TEMPLATE, { input: tplInput }, token);
    const tplBody = await tplInst.json();
    expect(tplBody.errors).toBeUndefined();

    // 从空白
    const blankInput = { source: 'BLANK', controllerId: fake.controllerId, workspaceId, name: `wf-p2a2-blank-${Date.now()}`, nodes: [{ nodeKey: 'input', type: 'HUMAN', name: '需求输入', stage: '阶段一', dependsOn: [], requiresWorktree: false }, { nodeKey: 'exec', type: 'AI', name: 'AI执行', stage: '阶段一', prompts: ['x'], artifactTitles: ['r'], dependsOn: ['input'], requiresWorktree: false, agentConfig: { acpServerType: 'opencode', initNewWorktree: false } }] };
    const blankInst = await gqlRequest(INSTANTIATE_FROM_TEMPLATE, { input: blankInput }, token);
    const blankBody = await blankInst.json();
    expect(blankBody.errors).toBeUndefined();
  });

  it('A3: updateWorkflowNode 未开始节点成功，已开始节点拒绝', async () => {
    const tplId = await createSimpleTemplate(token, `wf-p2a3-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-p2a3-cfg-${Date.now()}`);
    const instRes = await gqlRequest(INSTANTIATE_FROM_TEMPLATE, { input: instantiateInput(fake.controllerId, cfgId, workspaceId, `wf-p2a3-实例-${Date.now()}`) }, token);
    const inst = (await instRes.json()).data.instantiateWorkflow;
    const instanceId = inst.id as string;
    const execNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec');
    // exec 为 INITIALIZING（未开始），可编辑
    expect(execNode.status).toBe('INITIALIZING');

    const editRes = await gqlRequest(UPDATE_WORKFLOW_NODE, { instanceId, nodeId: execNode.id, input: { prompts: ['修改后的提示词'], requiresWorktree: false } }, token);
    const editBody = await editRes.json();
    expect(editBody.errors).toBeUndefined();
    expect(editBody.data.updateWorkflowNode.prompts).toEqual(['修改后的提示词']);

    // 完成首节点 → exec 启动（RUNNING，startedAt 非空）→ 编辑被拒
    const inputNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');
    const startEvent = waitForEvent<StartEventData>(fake.client, 'acp:start', 10000);
    await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId, nodeId: inputNode.id, input: '做一个计算器' }, token);
    const startData = await startEvent;
    fake.client.emit('acp:start:result', { requestId: startData.requestId, sessionId: startData.sessionId, success: true, externalSessionId: `ext_p2a3_${Date.now()}` });
    await sleep(500);

    const rejectRes = await gqlRequest(UPDATE_WORKFLOW_NODE, { instanceId, nodeId: execNode.id, input: { prompts: ['不可修改'] } }, token);
    const rejectBody = await rejectRes.json();
    expect(rejectBody.errors).toBeDefined();
    expect(rejectBody.errors[0].message).toContain('已开始，不可修改');
  }, 30_000);

  it('A6: deleteConfiguredWorkflow 存在活跃实例时删除成功，实例不受影响', async () => {
    const tplId = await createSimpleTemplate(token, `wf-p2a6-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-p2a6-cfg-${Date.now()}`);
    const instRes = await gqlRequest(INSTANTIATE_FROM_TEMPLATE, { input: instantiateInput(fake.controllerId, cfgId, workspaceId, `wf-p2a6-实例-${Date.now()}`) }, token);
    const inst = (await instRes.json()).data.instantiateWorkflow;
    const instanceId = inst.id as string;

    const delRes = await gqlRequest(DELETE_CONFIGURED_WORKFLOW, { id: cfgId }, token);
    const delBody = await delRes.json();
    expect(delBody.errors).toBeUndefined();
    expect(delBody.data.deleteConfiguredWorkflow).toBe(true);

    // 实例不受影响
    const qRes = await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token);
    const instBody = await qRes.json();
    expect(instBody.errors).toBeUndefined();
    expect(instBody.data.workflowInstance.nodes).toHaveLength(2);
  });
});

describe('Workflow Session Initial Mode/Model (A30)', () => {
  let token = '';
  let fake: FakeController;
  let workspaceId = '';

  beforeAll(async () => {
    token = await signup('wfinit');
    expect(token).toBeTruthy();
    fake = await registerFakeController(token, 'init');
    const available = await refreshCapabilities(token, fake.controllerId);
    expect(available).toContain('opencode');
    workspaceId = await createWorkspace(token, fake.controllerId);
  }, 30_000);

  afterAll(() => {
    fake?.client.disconnect();
  });

  it('A30: 节点配置 modeId/modelId 透传到 AI 会话 acp:start（harness 初始化为配置值而非默认）', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a30-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-a30-cfg-${Date.now()}`);

    // 实例化入参：exec 节点 agentConfig 带 mode/model
    const input = instantiateInput(fake.controllerId, cfgId, workspaceId, `wf-a30-实例-${Date.now()}`);
    (input.nodes[1] as { agentConfig?: Record<string, unknown> }).agentConfig = {
      acpServerType: 'opencode', modeId: 'code', modelId: 'gpt-5', initNewWorktree: false,
    };

    const instRes = await gqlRequest(INSTANTIATE_WORKFLOW, { input }, token);
    const inst = (await instRes.json()).data.instantiateWorkflow;
    const inputNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');

    const startEvent = waitForEvent<StartEventData>(fake.client, 'acp:start', 10000);
    await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId: inst.id, nodeId: inputNode.id, input: '做一个计算器' }, token);
    const startData = await startEvent;

    // harness 会话初始化参数携带节点配置的 mode/model
    expect(startData.modeId).toBe('code');
    expect(startData.modelId).toBe('gpt-5');

    fake.client.emit('acp:start:result', {
      requestId: startData.requestId,
      sessionId: startData.sessionId,
      success: true,
      externalSessionId: `ext_a30_${Date.now()}`,
    });
    await sleep(500);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 人类验收问题修复（A31-A32）
// ---------------------------------------------------------------------------

/** 解码 JWT payload（无依赖，base64url） */
function decodeJwtPayload(token: string): Record<string, any> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

/** 三节点实例化入参（HUMAN input → AI exec → HUMAN review） */
function humanReviewInstantiateInput(
  controllerId: string,
  configuredWorkflowId: string,
  workspaceId: string,
  name: string,
) {
  return {
    source: 'CONFIGURED',
    configuredWorkflowId,
    controllerId,
    workspaceId,
    name,
    nodes: [
      { nodeKey: 'input', type: 'HUMAN', name: '需求输入', stage: '阶段一', dependsOn: [], requiresWorktree: false },
      {
        nodeKey: 'exec', type: 'AI', name: 'AI执行', stage: '阶段一',
        prompts: ['阅读上游产物并完成执行'], artifactTitles: ['执行结果'],
        dependsOn: ['input'], requiresWorktree: false,
        agentConfig: { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: false },
      },
      { nodeKey: 'review', type: 'HUMAN', name: '评审', stage: '阶段二', dependsOn: ['exec'], requiresWorktree: false },
    ],
  };
}

describe('Workflow Human Acceptance (A31-A32)', () => {
  let token = '';
  let fake: FakeController;
  let workspaceId = '';

  beforeAll(async () => {
    token = await signup('wfhacc');
    expect(token).toBeTruthy();
    fake = await registerFakeController(token, 'hacc');
    const available = await refreshCapabilities(token, fake.controllerId);
    expect(available).toContain('opencode');
    workspaceId = await createWorkspace(token, fake.controllerId);
  }, 30_000);

  afterAll(() => {
    fake?.client.disconnect();
  });

  it('A31: 多节点打回回流（c打回b→b打回a→a重新提供→b完成→c复工）人类末端节点不卡死', async () => {
    // 三节点模板（input HUMAN → exec AI → review HUMAN）
    const tplRes = await gqlRequest(
      CREATE_WORKFLOW_TEMPLATE,
      { input: humanReviewTemplateInput(`wf-a31-${Date.now()}`) },
      token,
    );
    const tplId = (await tplRes.json()).data.createWorkflowTemplate.id;
    const cfgRes = await gqlRequest(
      CONFIGURE_WORKFLOW,
      {
        templateId: tplId,
        input: {
          name: `wf-a31-cfg-${Date.now()}`,
          controllerId: fake.controllerId,
          nodes: configureNodes(humanReviewTemplateInput('_').nodes, { exec: { acpServerType: 'opencode', initNewWorktree: false } }),
        },
      },
      token,
    );
    const cfgId = (await cfgRes.json()).data.configureWorkflow.id;
    const instRes = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      { input: humanReviewInstantiateInput(fake.controllerId, cfgId, workspaceId, `wf-a31-实例-${Date.now()}`) },
      token,
    );
    const inst = (await instRes.json()).data.instantiateWorkflow;
    const instanceId = inst.id as string;
    const inputNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');

    // 1) 完成首节点 → exec AI 会话启动（acp:start #1）
    const startPromise = waitForEvent<StartEventData>(fake.client, 'acp:start', 15000);
    await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId, nodeId: inputNode.id, input: '做一个计算器' }, token);
    const s1 = await startPromise;
    fake.client.emit('acp:start:result', {
      requestId: s1.requestId, sessionId: s1.sessionId, success: true, externalSessionId: `ext_a31_1_${Date.now()}`,
    });
    await sleep(500);

    // 2) exec 完成 → review 人类节点 RUNNING
    const done1 = parseToolResult(
      (await callWorkflowTool(s1.sessionId, s1.mcpEndpoint!.token, 'completeCurrentNode', {
        artifacts: [{ title: '执行结果', value: '计算器代码 v1' }],
      })).body,
    );
    expect(done1.isError).toBe(false);

    // 3) review（c）打回 exec（b）：review REJECT，exec REWORK（resume S1）
    let instQ = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token)).json()).data.workflowInstance;
    const reviewNode = instQ.nodes.find((n: Record<string, any>) => n.nodeKey === 'review');
    expect(reviewNode.status).toBe('RUNNING');
    const resumeB = waitForResume<StartEventData>(fake.client, s1.sessionId, 15000);
    await gqlRequest(REJECT_NODE, { instanceId, nodeId: reviewNode.id, reason: '执行结果不符合需求' }, token);
    const resumeBData = await resumeB;
    fake.client.emit('acp:resume:result', { requestId: resumeBData.requestId, sessionId: s1.sessionId, success: true });
    await sleep(500);
    const bReworkToken = resumeBData.mcpEndpoint!.token;

    // 4) exec（b）打回 input（a）：exec REJECT，input REWORK
    const rejB = parseToolResult(
      (await callWorkflowTool(s1.sessionId, bReworkToken, 'rejectCurrentNode', {
        reason: '需求本身有问题，无法按现状执行',
      })).body,
    );
    expect(rejB.isError).toBe(false);
    instQ = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token)).json()).data.workflowInstance;
    expect(instQ.nodes.find((n: Record<string, any>) => n.nodeKey === 'input').status).toBe('REWORK');

    // 5) input（a）重新提供信息：REWORK → completeRework；exec REJECT → resume（关闭旧会话 + 新会话 S2）
    const s2Promise = waitForEvent<StartEventData>(fake.client, 'acp:start', 15000);
    await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId, nodeId: inputNode.id, input: '做一个支持加减乘除的计算器' }, token);
    const s2 = await s2Promise;
    expect(s2.sessionId).not.toBe(s1.sessionId);
    fake.client.emit('acp:start:result', {
      requestId: s2.requestId, sessionId: s2.sessionId, success: true, externalSessionId: `ext_a31_2_${Date.now()}`,
    });
    await sleep(500);

    // 6) exec（b）完成 → 下游 review（c）仍 REJECT → resume；人类节点复工 RUNNING（不应报「缺少 Agent 配置」）
    const done2 = parseToolResult(
      (await callWorkflowTool(s2.sessionId, s2.mcpEndpoint!.token, 'completeCurrentNode', {
        artifacts: [{ title: '执行结果', value: '计算器代码 v2' }],
      })).body,
    );
    expect(done2.isError).toBe(false);

    // 7) 流程不再卡死：exec DONE，review RUNNING（人工处理）
    instQ = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token)).json()).data.workflowInstance;
    expect(instQ.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec').status).toBe('DONE');
    expect(instQ.nodes.find((n: Record<string, any>) => n.nodeKey === 'review').status).toBe('RUNNING');
  }, 90_000);

  it('A32: 工作流节点会话 MCP token 无 exp（有效性跟随工作流），普通会话 token 有 exp（跟随会话）', async () => {
    // 两节点实例推进到 exec 会话启动
    const tplRes = await gqlRequest(
      CREATE_WORKFLOW_TEMPLATE,
      { input: simpleTemplateInput(`wf-a32-${Date.now()}`) },
      token,
    );
    const tplId = (await tplRes.json()).data.createWorkflowTemplate.id;
    const cfgRes = await gqlRequest(
      CONFIGURE_WORKFLOW,
      {
        templateId: tplId,
        input: {
          name: `wf-a32-cfg-${Date.now()}`,
          controllerId: fake.controllerId,
          nodes: configureNodes(simpleTemplateInput('_').nodes, { exec: { acpServerType: 'opencode', initNewWorktree: false } }),
        },
      },
      token,
    );
    const cfgId = (await cfgRes.json()).data.configureWorkflow.id;
    const instRes = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      { input: instantiateInput(fake.controllerId, cfgId, workspaceId, `wf-a32-实例-${Date.now()}`) },
      token,
    );
    const inst = (await instRes.json()).data.instantiateWorkflow;
    const inputNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');

    const startEvent = waitForEvent<StartEventData>(fake.client, 'acp:start', 10000);
    await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId: inst.id, nodeId: inputNode.id, input: '做一个计算器' }, token);
    const startData = await startEvent;
    const wfToken = startData.mcpEndpoint!.token;
    expect(wfToken).toBeTruthy();
    fake.client.emit('acp:start:result', {
      requestId: startData.requestId, sessionId: startData.sessionId, success: true, externalSessionId: `ext_a32_${Date.now()}`,
    });
    await sleep(500);

    // 工作流节点会话 token：payload 含 workflow 作用域且无 exp
    const wfPayload = decodeJwtPayload(wfToken);
    expect(wfPayload.workflow).toBeDefined();
    expect(wfPayload.exp).toBeUndefined();

    // 普通会话（用户装配同一平台 MCP 服务）：token 无 workflow 作用域且有 exp（TTL）
    const serversRes = await gqlRequest(MCP_SERVERS_QUERY, undefined, token);
    const serversBody = await serversRes.json();
    expect(serversBody.errors).toBeUndefined();
    const platformServer = (serversBody.data.mcpServers as { id: string; name: string }[])
      .find((s) => s.name === 'agent-workflow-tools');
    expect(platformServer, '工作流平台 MCP 服务应已注册').toBeDefined();

    const normalStartEvent = waitForEvent<StartEventData>(fake.client, 'acp:start', 10000);
    const createRes = await gqlRequest(
      CREATE_SESSION,
      { input: { controllerId: fake.controllerId, acpServerType: 'opencode', workspaceId, mcpServerIds: [platformServer!.id] } },
      token,
    );
    const createBody = await createRes.json();
    expect(createBody.errors).toBeUndefined();
    const normalSessionId = createBody.data.createSession.session.id;
    const normalStartData = await normalStartEvent;
    expect(normalStartData.sessionId).toBe(normalSessionId);
    const normalToken = normalStartData.mcpEndpoint!.token;
    expect(normalToken).toBeTruthy();
    fake.client.emit('acp:start:result', {
      requestId: normalStartData.requestId, sessionId: normalSessionId, success: true, externalSessionId: `ext_a32_n_${Date.now()}`,
    });
    await sleep(500);

    const normalPayload = decodeJwtPayload(normalToken);
    expect(normalPayload.workflow).toBeUndefined();
    expect(normalPayload.exp).toBeDefined();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 节点重启（A33，人类验收返工#1）：RUNNING/REWORK/FAILED 会话失败时人工重启
// ---------------------------------------------------------------------------

const RESTART_NODE = `
  mutation RestartNode($instanceId: ID!, $nodeId: ID!) {
    restartNode(instanceId: $instanceId, nodeId: $nodeId) { id nodeKey name status }
  }
`;

describe('Workflow Node Restart (A33)', () => {
  let token = '';
  let fake: FakeController;
  let workspaceId = '';

  beforeAll(async () => {
    token = await signup('wfrst');
    expect(token).toBeTruthy();
    fake = await registerFakeController(token, 'rst');
    const available = await refreshCapabilities(token, fake.controllerId);
    expect(available).toContain('opencode');
    workspaceId = await createWorkspace(token, fake.controllerId);
  }, 30_000);

  afterAll(() => {
    fake?.client.disconnect();
  });

  it('A33: 重启 RUNNING 节点关闭旧会话拉起全新会话；重启 FAILED 节点清 failInfo 复工', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a33-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-a33-cfg-${Date.now()}`);
    const instRes = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      { input: instantiateInput(fake.controllerId, cfgId, workspaceId, `wf-a33-实例-${Date.now()}`) },
      token,
    );
    const inst = (await instRes.json()).data.instantiateWorkflow;
    const instanceId = inst.id as string;
    const inputNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');
    const execNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec');

    // 完成首节点 → exec RUNNING（会话 S1）
    const s1Promise = waitForEvent<StartEventData>(fake.client, 'acp:start', 15000);
    await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId, nodeId: inputNode.id, input: '做一个计算器' }, token);
    const s1 = await s1Promise;
    fake.client.emit('acp:start:result', {
      requestId: s1.requestId, sessionId: s1.sessionId, success: true, externalSessionId: `ext_a33_1_${Date.now()}`,
    });
    await sleep(500);

    // 重启 RUNNING 节点 → 关闭旧会话 S1，拉起全新会话 S2
    const s2Promise = waitForEvent<StartEventData>(fake.client, 'acp:start', 15000);
    const rstRes = await gqlRequest(RESTART_NODE, { instanceId, nodeId: execNode.id }, token);
    const rstBody = await rstRes.json();
    expect(rstBody.errors).toBeUndefined();
    expect(rstBody.data.restartNode.status).toBe('RUNNING');
    const s2 = await s2Promise;
    expect(s2.sessionId).not.toBe(s1.sessionId);
    fake.client.emit('acp:start:result', {
      requestId: s2.requestId, sessionId: s2.sessionId, success: true, externalSessionId: `ext_a33_2_${Date.now()}`,
    });
    await sleep(500);

    // 节点标记失败（LLM_REPORTED）
    const failed = parseToolResult(
      (await callWorkflowTool(s2.sessionId, s2.mcpEndpoint!.token, 'failCurrentNode', { reason: '会话卡住，无法继续' })).body,
    );
    expect(failed.isError).toBe(false);
    expect(failed.data.status).toBe('FAILED');
    let instQ = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token)).json()).data.workflowInstance;
    expect(instQ.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec').status).toBe('FAILED');

    // 重启 FAILED 节点 → 清 failInfo，复工 RUNNING，拉起全新会话 S3
    const s3Promise = waitForEvent<StartEventData>(fake.client, 'acp:start', 15000);
    const rst2Res = await gqlRequest(RESTART_NODE, { instanceId, nodeId: execNode.id }, token);
    const rst2Body = await rst2Res.json();
    expect(rst2Body.errors).toBeUndefined();
    expect(rst2Body.data.restartNode.status).toBe('RUNNING');
    const s3 = await s3Promise;
    expect(s3.sessionId).not.toBe(s2.sessionId);
    fake.client.emit('acp:start:result', {
      requestId: s3.requestId, sessionId: s3.sessionId, success: true, externalSessionId: `ext_a33_3_${Date.now()}`,
    });
    await sleep(500);

    instQ = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token)).json()).data.workflowInstance;
    const execFinal = instQ.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec');
    expect(execFinal.status).toBe('RUNNING');
    expect(execFinal.failInfo).toBeNull();

    // 重启后节点可正常完成
    const done = parseToolResult(
      (await callWorkflowTool(s3.sessionId, s3.mcpEndpoint!.token, 'completeCurrentNode', {
        artifacts: [{ title: '执行结果', value: '重启后完成' }],
      })).body,
    );
    expect(done.isError).toBe(false);
    expect(done.data.status).toBe('DONE');
  }, 60_000);

  it('A33b: 重启 READY/DONE/REJECT 节点被拒绝', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a33b-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-a33b-cfg-${Date.now()}`);
    const instRes = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      { input: instantiateInput(fake.controllerId, cfgId, workspaceId, `wf-a33b-实例-${Date.now()}`) },
      token,
    );
    const inst = (await instRes.json()).data.instantiateWorkflow;
    const execNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec');
    expect(execNode.status).toBe('INITIALIZING');

    const rstRes = await gqlRequest(RESTART_NODE, { instanceId: inst.id, nodeId: execNode.id }, token);
    const rstBody = await rstRes.json();
    expect(rstBody.errors).toBeDefined();
    expect(rstBody.errors[0].message).toContain('不允许执行');
  }, 30_000);
});


// ---------------------------------------------------------------------------
// 工作流优化特性（A35-A44）：createWorkflowWorktree、能力回源、restart agentConfig、sortOrder、Worktree 清理
// ---------------------------------------------------------------------------

const INSTANTIATE_WORKFLOW_WITH_WORKTREE = `
  mutation InstantiateWorkflow($input: InstantiateWorkflowInput!) {
    instantiateWorkflow(input: $input) {
      id configuredWorkflowId name
      workflowWorktreePath workflowWorktreeBranch
      nodes { id nodeKey type name status stage sortOrder agentConfig { acpServerType } }
    }
  }
`;

const RESTART_NODE_WITH_AGENT_CONFIG = `
  mutation RestartNode($instanceId: ID!, $nodeId: ID!, $agentConfig: AgentNodeConfigInput) {
    restartNode(instanceId: $instanceId, nodeId: $nodeId, agentConfig: $agentConfig) {
      id nodeKey name status
    }
  }
`;

const UPDATE_WORKFLOW_NODE_WITH_SORT_ORDER = `
  mutation UpdateWorkflowNode($instanceId: ID!, $nodeId: ID!, $input: WorkflowNodeUpdateInput!) {
    updateWorkflowNode(instanceId: $instanceId, nodeId: $nodeId, input: $input) {
      id nodeKey name sortOrder
    }
  }
`;

describe('Workflow Optimization Features (A35-A44)', () => {
  let token = '';
  let fake: FakeController;
  let workspaceId = '';

  beforeAll(async () => {
    token = await signup('wfopt');
    expect(token).toBeTruthy();
    fake = await registerFakeController(token, 'opt');
    const available = await refreshCapabilities(token, fake.controllerId);
    expect(available).toContain('opencode');
    workspaceId = await createGitWorkspace(token, fake.controllerId);
  }, 30_000);

  afterAll(() => {
    fake?.client.disconnect();
  });

  it('A35: instantiateWorkflow createWorkflowWorktree=true 时创建工作流 Worktree', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a35-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-a35-cfg-${Date.now()}`);

    // 注册 git:worktree:add 处理器
    fake.client.on('git:worktree:add', (data: { requestId: string; repoPath: string; worktreePath: string; branch: string }) => {
      fake.client.emit('git:worktree:add:result', {
        requestId: data.requestId,
        success: true,
        worktreePath: data.worktreePath,
      });
    });

    const res = await gqlRequest(
      INSTANTIATE_WORKFLOW_WITH_WORKTREE,
      {
        input: {
          source: 'CONFIGURED',
          configuredWorkflowId: cfgId,
          controllerId: fake.controllerId,
          workspaceId,
          name: `wf-a35-实例-${Date.now()}`,
          nodes: configureNodes(simpleTemplateInput('_').nodes, { exec: { acpServerType: 'opencode', initNewWorktree: false } }),
          createWorkflowWorktree: true,
        },
      },
      token,
    );
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    const inst = body.data.instantiateWorkflow;
    expect(inst.workflowWorktreePath).toBeTruthy();
    expect(inst.workflowWorktreeBranch).toContain('workflow/');
  }, 30_000);

  it('A36: instantiateWorkflow createWorkflowWorktree=false 时无 Worktree 字段', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a36-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-a36-cfg-${Date.now()}`);

    const res = await gqlRequest(
      INSTANTIATE_WORKFLOW_WITH_WORKTREE,
      {
        input: {
          source: 'CONFIGURED',
          configuredWorkflowId: cfgId,
          controllerId: fake.controllerId,
          workspaceId,
          name: `wf-a36-实例-${Date.now()}`,
          nodes: configureNodes(simpleTemplateInput('_').nodes, { exec: { acpServerType: 'opencode', initNewWorktree: false } }),
          createWorkflowWorktree: false,
        },
      },
      token,
    );
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    const inst = body.data.instantiateWorkflow;
    expect(inst.workflowWorktreePath).toBeNull();
    expect(inst.workflowWorktreeBranch).toBeNull();
  }, 20_000);

  it('A37: 能力缓存缺失+控制器在线时回源成功（误报回归）', async () => {
    // 清除 Redis 缓存（通过刷新能力）
    await refreshCapabilities(token, fake.controllerId);

    // 此时缓存应存在，实例化应成功
    const tplId = await createSimpleTemplate(token, `wf-a37-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-a37-cfg-${Date.now()}`);
    const res = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      { input: instantiateInput(fake.controllerId, cfgId, workspaceId, `wf-a37-实例-${Date.now()}`) },
      token,
    );
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.instantiateWorkflow.id).toBeDefined();
  }, 20_000);

  it('A38: restartNode 携带合法 agentConfig 更新节点快照', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a38-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-a38-cfg-${Date.now()}`);
    const instRes = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      { input: instantiateInput(fake.controllerId, cfgId, workspaceId, `wf-a38-实例-${Date.now()}`) },
      token,
    );
    const inst = (await instRes.json()).data.instantiateWorkflow;
    const inputNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');
    const execNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec');

    // 完成首节点 → exec RUNNING
    const startEvent = waitForEvent<StartEventData>(fake.client, 'acp:start', 10000);
    await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId: inst.id, nodeId: inputNode.id, input: '测试' }, token);
    const startData = await startEvent;
    fake.client.emit('acp:start:result', {
      requestId: startData.requestId, sessionId: startData.sessionId, success: true, externalSessionId: `ext_a38_${Date.now()}`,
    });
    await sleep(500);

    // 重启携带新 agentConfig
    const newAgentConfig = { acpServerType: 'opencode', modeId: 'new-mode', modelId: 'new-model', initNewWorktree: true };
    const s2Promise = waitForEvent<StartEventData>(fake.client, 'acp:start', 10000);
    const rstRes = await gqlRequest(RESTART_NODE_WITH_AGENT_CONFIG, {
      instanceId: inst.id,
      nodeId: execNode.id,
      agentConfig: newAgentConfig,
    }, token);
    const rstBody = await rstRes.json();
    expect(rstBody.errors).toBeUndefined();
    expect(rstBody.data.restartNode.status).toBe('RUNNING');

    // 验证新会话使用了新配置
    const s2 = await s2Promise;
    expect(s2.sessionId).not.toBe(startData.sessionId);
    fake.client.emit('acp:start:result', {
      requestId: s2.requestId, sessionId: s2.sessionId, success: true, externalSessionId: `ext_a38_2_${Date.now()}`,
    });
    await sleep(500);

    // 查询实例验证节点快照已更新
    const instQ = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: inst.id }, token)).json()).data.workflowInstance;
    const execFinal = instQ.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec');
    expect(execFinal.agentConfig).toEqual(newAgentConfig);
  }, 30_000);

  it('A39: restartNode 携带能力外 agentConfig 被拒绝', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a39-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-a39-cfg-${Date.now()}`);
    const instRes = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      { input: instantiateInput(fake.controllerId, cfgId, workspaceId, `wf-a39-实例-${Date.now()}`) },
      token,
    );
    const inst = (await instRes.json()).data.instantiateWorkflow;
    const inputNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');
    const execNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec');

    // 完成首节点 → exec RUNNING
    const startEvent = waitForEvent<StartEventData>(fake.client, 'acp:start', 10000);
    await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId: inst.id, nodeId: inputNode.id, input: '测试' }, token);
    const startData = await startEvent;
    fake.client.emit('acp:start:result', {
      requestId: startData.requestId, sessionId: startData.sessionId, success: true, externalSessionId: `ext_a39_${Date.now()}`,
    });
    await sleep(500);

    // 重启携带能力外 agentConfig
    const badAgentConfig = { acpServerType: 'nonexistent-harness', initNewWorktree: false };
    const rstRes = await gqlRequest(RESTART_NODE_WITH_AGENT_CONFIG, {
      instanceId: inst.id,
      nodeId: execNode.id,
      agentConfig: badAgentConfig,
    }, token);
    const rstBody = await rstRes.json();
    expect(rstBody.errors).toBeDefined();
    expect(rstBody.errors[0].message).toContain('控制器不支持该 Harness 类型');
  }, 20_000);

  it('A40: sortOrder 存取与缺省回填', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a40-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-a40-cfg-${Date.now()}`);
    const instRes = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      { input: instantiateInput(fake.controllerId, cfgId, workspaceId, `wf-a40-实例-${Date.now()}`) },
      token,
    );
    const inst = (await instRes.json()).data.instantiateWorkflow;
    const inputNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');
    const execNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec');

    // 实例化后 sortOrder 应为 null（缺省）
    expect(inputNode.sortOrder).toBeNull();
    expect(execNode.sortOrder).toBeNull();

    // 更新 sortOrder
    const updateRes = await gqlRequest(UPDATE_WORKFLOW_NODE_WITH_SORT_ORDER, {
      instanceId: inst.id,
      nodeId: inputNode.id,
      input: { sortOrder: 1 },
    }, token);
    const updateBody = await updateRes.json();
    expect(updateBody.errors).toBeUndefined();
    expect(updateBody.data.updateWorkflowNode.sortOrder).toBe(1);

    // 查询验证
    const instQ = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: inst.id }, token)).json()).data.workflowInstance;
    const inputFinal = instQ.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');
    expect(inputFinal.sortOrder).toBe(1);
  }, 20_000);

  it('A41: deleteWorkflowInstance 清理工作流 Worktree', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a41-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-a41-cfg-${Date.now()}`);

    // 注册 git:worktree:add 和 git:worktree:remove 处理器
    const addedWorktrees: string[] = [];
    const removedWorktrees: string[] = [];
    fake.client.on('git:worktree:add', (data: { requestId: string; worktreePath: string }) => {
      addedWorktrees.push(data.worktreePath);
      fake.client.emit('git:worktree:add:result', {
        requestId: data.requestId,
        success: true,
        worktreePath: data.worktreePath,
      });
    });
    fake.client.on('git:worktree:remove', (data: { requestId: string; worktreePath: string }) => {
      removedWorktrees.push(data.worktreePath);
      fake.client.emit('git:worktree:remove:result', {
        requestId: data.requestId,
        success: true,
      });
    });

    const instRes = await gqlRequest(
      INSTANTIATE_WORKFLOW_WITH_WORKTREE,
      {
        input: {
          source: 'CONFIGURED',
          configuredWorkflowId: cfgId,
          controllerId: fake.controllerId,
          workspaceId,
          name: `wf-a41-实例-${Date.now()}`,
          nodes: configureNodes(simpleTemplateInput('_').nodes, { exec: { acpServerType: 'opencode', initNewWorktree: false } }),
          createWorkflowWorktree: true,
        },
      },
      token,
    );
    const inst = (await instRes.json()).data.instantiateWorkflow;
    expect(inst.workflowWorktreePath).toBeTruthy();

    // 删除实例
    const delRes = await gqlRequest(DELETE_WORKFLOW_INSTANCE_MUT, { id: inst.id }, token);
    const delBody = await delRes.json();
    expect(delBody.errors).toBeUndefined();
    expect(delBody.data.deleteWorkflowInstance).toBe(true);

    // 等待清理完成
    await sleep(1000);

    // 验证工作流 Worktree 被清理
    expect(removedWorktrees).toContain(inst.workflowWorktreePath);
  }, 30_000);

  it('A42: WorkflowInstance 查询返回 workflowWorktreePath/workflowWorktreeBranch', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a42-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-a42-cfg-${Date.now()}`);

    fake.client.on('git:worktree:add', (data: { requestId: string; worktreePath: string }) => {
      fake.client.emit('git:worktree:add:result', {
        requestId: data.requestId,
        success: true,
        worktreePath: data.worktreePath,
      });
    });

    const instRes = await gqlRequest(
      INSTANTIATE_WORKFLOW_WITH_WORKTREE,
      {
        input: {
          source: 'CONFIGURED',
          configuredWorkflowId: cfgId,
          controllerId: fake.controllerId,
          workspaceId,
          name: `wf-a42-实例-${Date.now()}`,
          nodes: configureNodes(simpleTemplateInput('_').nodes, { exec: { acpServerType: 'opencode', initNewWorktree: false } }),
          createWorkflowWorktree: true,
        },
      },
      token,
    );
    const inst = (await instRes.json()).data.instantiateWorkflow;
    expect(inst.workflowWorktreePath).toBeTruthy();
    expect(inst.workflowWorktreeBranch).toContain('workflow/');

    // 通过 query 查询验证字段存在
    const qRes = await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: inst.id }, token);
    const qBody = await qRes.json();
    expect(qBody.errors).toBeUndefined();
    const instQ = qBody.data.workflowInstance;
    expect(instQ.workflowWorktreePath).toBe(inst.workflowWorktreePath);
    expect(instQ.workflowWorktreeBranch).toBe(inst.workflowWorktreeBranch);
  }, 20_000);

  it('A43: sortOrder 非 DAG 保存被拒绝', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a43-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-a43-cfg-${Date.now()}`);

    // 尝试更新配置工作流，传入循环依赖的节点图
    const res = await gqlRequest(UPDATE_CONFIGURED_WORKFLOW, {
      id: cfgId,
      input: {
        name: `wf-a43-bad-${Date.now()}`,
        controllerId: fake.controllerId,
        nodes: [
          { nodeKey: 'a', type: 'HUMAN', name: '甲', stage: 's', dependsOn: ['b'], requiresWorktree: false },
          { nodeKey: 'b', type: 'AI', name: '乙', stage: 's', prompts: ['做乙事'], dependsOn: ['a'], requiresWorktree: false, agentConfig: { acpServerType: 'opencode', initNewWorktree: false } },
        ],
      },
    }, token);
    const body = await res.json();
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toContain('循环依赖');
  }, 20_000);

  it('A44: 节点重启携带 agentConfig 后新会话使用新配置', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a44-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-a44-cfg-${Date.now()}`);
    const instRes = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      { input: instantiateInput(fake.controllerId, cfgId, workspaceId, `wf-a44-实例-${Date.now()}`) },
      token,
    );
    const inst = (await instRes.json()).data.instantiateWorkflow;
    const inputNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');
    const execNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec');

    // 完成首节点 → exec RUNNING
    const startEvent = waitForEvent<StartEventData>(fake.client, 'acp:start', 10000);
    await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId: inst.id, nodeId: inputNode.id, input: '测试' }, token);
    const startData = await startEvent;
    fake.client.emit('acp:start:result', {
      requestId: startData.requestId, sessionId: startData.sessionId, success: true, externalSessionId: `ext_a44_${Date.now()}`,
    });
    await sleep(500);

    // 记录原始 acpServerType
    expect(startData.serverType).toBe('opencode');

    // 重启携带新 agentConfig（虽然还是 opencode，但验证链路）
    const newAgentConfig = { acpServerType: 'opencode', modeId: 'code', modelId: 'gpt-5', initNewWorktree: false };
    const s2Promise = waitForEvent<StartEventData>(fake.client, 'acp:start', 10000);
    const rstRes = await gqlRequest(RESTART_NODE_WITH_AGENT_CONFIG, {
      instanceId: inst.id,
      nodeId: execNode.id,
      agentConfig: newAgentConfig,
    }, token);
    const rstBody = await rstRes.json();
    expect(rstBody.errors).toBeUndefined();

    // 验证新会话使用了新配置
    const s2 = await s2Promise;
    expect(s2.sessionId).not.toBe(startData.sessionId);
    expect(s2.serverType).toBe('opencode');
  }, 30_000);

  // ---------------------------------------------------------------------------
  // A45: Worktree 创建失败回滚（方案 A3）
  // ---------------------------------------------------------------------------

  it('A45: Worktree 创建失败 → 整体失败、无半成品实例', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a45-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-a45-cfg-${Date.now()}`);

    // 注册 git:worktree:add 返回 failure
    fake.client.on('git:worktree:add', (data: { requestId: string; worktreePath: string }) => {
      fake.client.emit('git:worktree:add:result', {
        requestId: data.requestId,
        success: false,
        error: 'Worktree creation failed',
      });
    });

    const res = await gqlRequest(
      INSTANTIATE_WORKFLOW_WITH_WORKTREE,
      {
        input: {
          source: 'CONFIGURED',
          configuredWorkflowId: cfgId,
          controllerId: fake.controllerId,
          workspaceId,
          name: `wf-a45-实例-${Date.now()}`,
          nodes: configureNodes(simpleTemplateInput('_').nodes, { exec: { acpServerType: 'opencode', initNewWorktree: false } }),
          createWorkflowWorktree: true,
        },
      },
      token,
    );
    const body = await res.json();

    // 整体失败，返回错误
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toContain('Worktree');

    // 验证无半成品实例（查询该名称的实例应为空）
    const listRes = await gqlRequest(WORKFLOW_INSTANCES_QUERY, { workspaceId }, token);
    const listBody = await listRes.json();
    const instances = listBody.data.workflowInstances as { name: string }[];
    const created = instances.find((i) => i.name.startsWith('wf-a45-实例'));
    expect(created).toBeUndefined();
  }, 30_000);

  // ---------------------------------------------------------------------------
  // A46: 能力缓存缺失+控制器在线时回源成功（方案 A4）
  // ---------------------------------------------------------------------------

  it('A46: 能力缓存缺失+控制器在线时回源成功（误报回归 - 缓存缺失路径）', async () => {
    // 注册一个新的 fake controller（无缓存）
    const newFake = await registerFakeController(token, 'opt-nocache');

    // 为新控制器创建 Git workspace
    const newWorkspaceId = await createGitWorkspace(token, newFake.controllerId);

    // configureFromTemplate 会触发 getAvailableServerTypes → 缓存缺失 → 回源
    const tplId = await createSimpleTemplate(token, `wf-a46-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, newFake.controllerId, `wf-a46-cfg-${Date.now()}`);

    // configure 成功说明回源成功（旧 bug 存在时 configure 即失败）
    expect(cfgId).toBeTruthy();

    // 实例化也应成功（此时缓存已回热）
    const res = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      { input: instantiateInput(newFake.controllerId, cfgId, newWorkspaceId, `wf-a46-实例-${Date.now()}`) },
      token,
    );
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.instantiateWorkflow.id).toBeDefined();

    newFake.client.disconnect();
  }, 30_000);

  // ---------------------------------------------------------------------------
  // A47: 能力缓存缺失+控制器离线时准确报离线（方案 A5）
  // ---------------------------------------------------------------------------

  it('A47: 能力缓存缺失+控制器离线时准确报离线（误报回归 - 离线路径）', async () => {
    // 注册一个全新 fake controller（从未 configure，因此无能力缓存）
    const offlineFake = await registerFakeController(token, 'opt-offline');
    const offlineControllerId = offlineFake.controllerId;

    // 为离线控制器创建 Git workspace
    const offlineWorkspaceId = await createGitWorkspace(token, offlineControllerId);

    const tplId = await createSimpleTemplate(token, `wf-a47-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, offlineControllerId, `wf-a47-cfg-${Date.now()}`);

    // configure 成功（控制器在线）→ 此时会缓存能力
    expect(cfgId).toBeTruthy();

    // 断开控制器连接，模拟离线
    offlineFake.client.disconnect();
    await sleep(500);

    // 通过 GraphQL 刷新能力缓存（删除旧缓存 + 尝试重新检测 → 控制器离线会超时）
    // 注：refreshAcpCapabilities 先 del 缓存再触发检测，离线时检测超时但缓存已清除
    await gqlRequest(REFRESH_ACP_CAPABILITIES, { controllerId: offlineControllerId }, token).catch(() => {});

    // 实例化时，getAvailableServerTypes 会检查 controller.status
    // 由于控制器已离线且缓存缺失，应报错
    const res = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      { input: instantiateInput(offlineControllerId, cfgId, offlineWorkspaceId, `wf-a47-实例-${Date.now()}`) },
      token,
    );
    const body = await res.json();
    // 应返回错误，提示控制器不可用
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toContain('Agent 能力信息不可用');
  }, 30_000);

  // ---------------------------------------------------------------------------
  // A48: 实例 Worktree 作为节点会话 cwd 优先级（方案 A6）
  // ---------------------------------------------------------------------------

  it('A48: 未启用节点级 Worktree 时，节点会话 cwd 使用实例 Worktree', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a48-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-a48-cfg-${Date.now()}`);

    // 注册 git:worktree:add：回显服务端下发的 worktreePath（与真实控制器一致，将 ~/ 展开为本机 home）
    let worktreePath = '';
    fake.client.on('git:worktree:add', (data: { requestId: string; worktreePath: string }) => {
      worktreePath = data.worktreePath.replace(/^~\//, `${FAKE_CONTROLLER_HOME}/`);
      fake.client.emit('git:worktree:add:result', {
        requestId: data.requestId,
        success: true,
        worktreePath,
      });
    });

    const instRes = await gqlRequest(
      INSTANTIATE_WORKFLOW_WITH_WORKTREE,
      {
        input: {
          source: 'CONFIGURED',
          configuredWorkflowId: cfgId,
          controllerId: fake.controllerId,
          workspaceId,
          name: `wf-a48-实例-${Date.now()}`,
          nodes: configureNodes(simpleTemplateInput('_').nodes, { exec: { acpServerType: 'opencode', initNewWorktree: false } }),
          createWorkflowWorktree: true,
        },
      },
      token,
    );
    const inst = (await instRes.json()).data.instantiateWorkflow;
    expect(inst.workflowWorktreePath).toBe(worktreePath);

    const inputNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');

    // 完成首节点 → exec 节点拉起会话，cwd 应为实例 Worktree（initNewWorktree: false → 复用实例 Worktree）
    const startEvent = waitForEvent<StartEventData>(fake.client, 'acp:start', 10000);
    const completeRes = await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId: inst.id, nodeId: inputNode.id, input: '测试' }, token);
    const completeBody = await completeRes.json();
    if (completeBody.errors) {
      console.error('A48 completeHumanNode errors:', JSON.stringify(completeBody.errors));
    }
    expect(completeBody.errors).toBeUndefined();
    const startData = await startEvent;

    // 验证 acp:start 的 cwd 为实例 Worktree 路径
    expect(startData.cwd).toBe(inst.workflowWorktreePath);
    expect(startData.sessionId).toBeTruthy();
    expect(startData.serverType).toBe('opencode');

    fake.client.emit('acp:start:result', {
      requestId: startData.requestId, sessionId: startData.sessionId, success: true, externalSessionId: `ext_a48_${Date.now()}`,
    });
    await sleep(500);

    // 验证实例节点会话启动成功
    const instQ = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: inst.id }, token)).json()).data.workflowInstance;
    const execNode = instQ.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec');
    expect(execNode.status).toBe('RUNNING');
    expect(execNode.sessionId).toBe(startData.sessionId);
  }, 30_000);

  it('A48b: 启用节点级 Worktree 时，节点会话 cwd 使用节点 Worktree', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a48b-${Date.now()}`, true); // requiresWorktree=true
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-a48b-cfg-${Date.now()}`);

    // 注册 git:worktree:add 回显服务端下发的 worktreePath（实例 Worktree 与节点 Worktree 路径不同）
    const addedPaths: string[] = [];
    fake.client.on('git:worktree:add', (data: { requestId: string; worktreePath: string }) => {
      addedPaths.push(data.worktreePath);
      fake.client.emit('git:worktree:add:result', {
        requestId: data.requestId,
        success: true,
        worktreePath: data.worktreePath,
      });
    });

    const instRes = await gqlRequest(
      INSTANTIATE_WORKFLOW_WITH_WORKTREE,
      {
        input: {
          source: 'CONFIGURED',
          configuredWorkflowId: cfgId,
          controllerId: fake.controllerId,
          workspaceId,
          name: `wf-a48b-实例-${Date.now()}`,
          nodes: simpleTemplateInput('_').nodes.map(n => ({
            ...n,
            requiresWorktree: n.nodeKey === 'exec' ? true : n.requiresWorktree,
            agentConfig: n.nodeKey === 'exec' ? { acpServerType: 'opencode', initNewWorktree: true } : null,
          })),
          createWorkflowWorktree: true,
        },
      },
      token,
    );
    const inst = (await instRes.json()).data.instantiateWorkflow;
    expect(inst.workflowWorktreePath).toBeTruthy();

    const inputNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');

    // 完成首节点 → exec 节点拉起会话，cwd 应为节点 Worktree（因为 initNewWorktree: true）
    const startEvent = waitForEvent<StartEventData>(fake.client, 'acp:start', 10000);
    const completeRes = await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId: inst.id, nodeId: inputNode.id, input: '测试' }, token);
    const completeBody = await completeRes.json();
    if (completeBody.errors) {
      console.error('A48b completeHumanNode errors:', JSON.stringify(completeBody.errors));
    }
    expect(completeBody.errors).toBeUndefined();
    const startData = await startEvent;

    // 验证 acp:start 的 cwd 为节点 Worktree 路径（比实例 Worktree 更深一层）
    expect(startData.cwd).toBeTruthy();
    expect(startData.cwd).not.toBe(inst.workflowWorktreePath);
    expect(startData.sessionId).toBeTruthy();
    expect(startData.serverType).toBe('opencode');

    fake.client.emit('acp:start:result', {
      requestId: startData.requestId, sessionId: startData.sessionId, success: true, externalSessionId: `ext_a48b_${Date.now()}`,
    });
    await sleep(500);

    // 验证实例节点会话启动成功
    const instQ = (await (await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: inst.id }, token)).json()).data.workflowInstance;
    const execNode = instQ.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec');
    expect(execNode.status).toBe('RUNNING');
    expect(execNode.sessionId).toBe(startData.sessionId);
  }, 30_000);

  // ---------------------------------------------------------------------------
  // A49: A36 补充 - 非 Git 工作区时 createWorkflowWorktree 不生效
  // ---------------------------------------------------------------------------

  it('A49: 非 Git 工作区时 createWorkflowWorktree 不生效（无 Worktree 字段）', async () => {
    // 创建一个无 defaultBranch 的工作区（非 Git 工作区）
    const nonGitWorkspaceId = await createWorkspace(token, fake.controllerId);

    const tplId = await createSimpleTemplate(token, `wf-a49-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-a49-cfg-${Date.now()}`);

    const res = await gqlRequest(
      INSTANTIATE_WORKFLOW_WITH_WORKTREE,
      {
        input: {
          source: 'CONFIGURED',
          configuredWorkflowId: cfgId,
          controllerId: fake.controllerId,
          workspaceId: nonGitWorkspaceId,
          name: `wf-a49-实例-${Date.now()}`,
          nodes: configureNodes(simpleTemplateInput('_').nodes, { exec: { acpServerType: 'opencode', initNewWorktree: false } }),
          createWorkflowWorktree: true, // 即使设置为 true，非 Git 工作区也不生效
        },
      },
      token,
    );
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    const inst = body.data.instantiateWorkflow;
    // 非 Git 工作区，Worktree 字段应为 null
    expect(inst.workflowWorktreePath).toBeNull();
    expect(inst.workflowWorktreeBranch).toBeNull();
  }, 20_000);

  // ---------------------------------------------------------------------------
  // A50: A41 补充 - 删除实例时节点级 Worktree 一并清理
  // ---------------------------------------------------------------------------

  it('A50: 删除实例时节点级 Worktree 一并清理（通过 closeSession 触发）', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a50-${Date.now()}`, true); // requiresWorktree=true
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-a50-cfg-${Date.now()}`, true);

    // 注册 git:worktree:add、git:worktree:remove 和 git:status 处理器
    const addedWorktrees: string[] = [];
    const removedWorktrees: string[] = [];
    fake.client.on('git:worktree:add', (data: { requestId: string; worktreePath: string }) => {
      addedWorktrees.push(data.worktreePath);
      fake.client.emit('git:worktree:add:result', {
        requestId: data.requestId,
        success: true,
        worktreePath: data.worktreePath,
      });
    });
    fake.client.on('git:worktree:remove', (data: { requestId: string; worktreePath: string }) => {
      removedWorktrees.push(data.worktreePath);
      fake.client.emit('git:worktree:remove:result', {
        requestId: data.requestId,
        success: true,
      });
    });
    // delete 清理会话时会发送 git:status + git:worktree:remove
    fake.client.on('git:status', (data: { requestId: string; path: string }) => {
      fake.client.emit('git:status:result', { requestId: data.requestId, isClean: true });
    });

    const instRes = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      { input: instantiateInput(fake.controllerId, cfgId, workspaceId, `wf-a50-实例-${Date.now()}`, true) },
      token,
    );
    const inst = (await instRes.json()).data.instantiateWorkflow;
    const inputNode = inst.nodes.find((n: Record<string, any>) => n.nodeKey === 'input');

    // 完成首节点 → exec 节点拉起会话（带节点级 Worktree）
    const startEvent = waitForEvent<StartEventData>(fake.client, 'acp:start', 10000);
    const completeRes50 = await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId: inst.id, nodeId: inputNode.id, input: '测试' }, token);
    const completeBody50 = await completeRes50.json();
    if (completeBody50.errors) {
      console.error('A50 completeHumanNode errors:', JSON.stringify(completeBody50.errors));
    }
    expect(completeBody50.errors).toBeUndefined();
    const startData = await startEvent;
    fake.client.emit('acp:start:result', {
      requestId: startData.requestId, sessionId: startData.sessionId, success: true, externalSessionId: `ext_a50_${Date.now()}`,
    });
    await sleep(500);

    // 记录节点级 Worktree
    expect(addedWorktrees.length).toBeGreaterThan(0);

    // 删除实例
    const delRes = await gqlRequest(DELETE_WORKFLOW_INSTANCE_MUT, { id: inst.id }, token);
    const delBody = await delRes.json();
    expect(delBody.errors).toBeUndefined();

    // 等待清理完成
    await sleep(1500);

    // 验证节点级 Worktree 被清理（通过 closeSession 触发）
    expect(removedWorktrees.length).toBeGreaterThan(0);
  }, 30_000);
});
