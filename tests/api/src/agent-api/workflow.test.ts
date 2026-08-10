import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';

const AGENT_API_URL = process.env.API_URL || 'http://localhost:4000/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';
const MCP_BASE_URL = `${(process.env.API_URL || 'http://localhost:4000').replace(/\/graphql\/?$/, '')}/mcp`;

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

const INSTANTIATE_WORKFLOW = `
  mutation InstantiateWorkflow($configuredWorkflowId: ID!, $workspaceId: ID!, $name: String!) {
    instantiateWorkflow(configuredWorkflowId: $configuredWorkflowId, workspaceId: $workspaceId, name: $name) {
      id configuredWorkflowId controllerId workspaceId name currentNodeNames
      nodes { id nodeKey type name status stage sessionId reworkCount }
    }
  }
`;

const WORKFLOW_INSTANCE_QUERY = `
  query WorkflowInstance($id: ID!) {
    workflowInstance(id: $id) {
      id name currentNodeNames
      nodes { id nodeKey type name status stage sessionId startedAt reworkedAt reworkCount rejectInfo { reason fromNodeId at } failInfo { reason source at } }
      blackboard { key value updatedAt }
      blackboardTrash { key value updatedAt }
    }
  }
`;

const WORKFLOW_INSTANCES_QUERY = `
  query WorkflowInstances($workspaceId: ID!) {
    workflowInstances(workspaceId: $workspaceId) { id name }
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
  const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
  client.emit('register', { key: rawKey, hostname: `wf-${tag}-host`, version: '1.0.0' });
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

function configureInput(name: string, controllerId: string, initNewWorktree = false) {
  return {
    name,
    controllerId,
    nodes: [
      { nodeKey: 'input' },
      { nodeKey: 'exec', agentConfig: { acpServerType: 'opencode', initNewWorktree } },
    ],
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
          nodes: [{ nodeKey: 'input' }, { nodeKey: 'exec' }],
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
            { nodeKey: 'input' },
            { nodeKey: 'exec', agentConfig: { acpServerType: 'claude_code', initNewWorktree: false } },
          ],
        },
      },
      token,
    );
    const body = await res.json();
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toContain('不在该控制器可用列表内');
  });

  it('A8: updateConfiguredWorkflow 禁止增删节点', async () => {
    const tplId = await createSimpleTemplate(token, `wf-a8-${Date.now()}`);
    const cfgId = await configureFromTemplate(token, tplId, fake.controllerId, `wf-a8-cfg-${Date.now()}`);

    // 新增节点
    const addRes = await gqlRequest(
      UPDATE_CONFIGURED_WORKFLOW,
      {
        id: cfgId,
        input: {
          name: `wf-a8-add-${Date.now()}`,
          controllerId: fake.controllerId,
          nodes: [
            { nodeKey: 'input' },
            { nodeKey: 'exec', agentConfig: { acpServerType: 'opencode', initNewWorktree: false } },
            { nodeKey: 'extra', agentConfig: { acpServerType: 'opencode', initNewWorktree: false } },
          ],
        },
      },
      token,
    );
    const addBody = await addRes.json();
    expect(addBody.errors).toBeDefined();
    expect(addBody.errors[0].message).toContain('不允许增删节点');

    // 删除节点
    const delRes = await gqlRequest(
      UPDATE_CONFIGURED_WORKFLOW,
      {
        id: cfgId,
        input: {
          name: `wf-a8-del-${Date.now()}`,
          controllerId: fake.controllerId,
          nodes: [{ nodeKey: 'input' }],
        },
      },
      token,
    );
    const delBody = await delRes.json();
    expect(delBody.errors).toBeDefined();
    expect(delBody.errors[0].message).toContain('不允许增删节点');
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
      { configuredWorkflowId: configuredId, workspaceId, name: `wf-it-实例-${Date.now()}` },
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
      { configuredWorkflowId: cfgId, workspaceId: wsId, name: `wf-a11-实例-${Date.now()}` },
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

  it('A9: 存在活跃实例时 deleteConfiguredWorkflow 拒绝，无引用时可删除', async () => {
    const res = await gqlRequest(DELETE_CONFIGURED_WORKFLOW, { id: configuredId }, token);
    const body = await res.json();
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toContain('未终结');

    // 无实例引用的配置可正常删除
    const freeCfgId = await configureFromTemplate(token, templateId, fake.controllerId, `wf-a9-cfg-${Date.now()}`);
    const delRes = await gqlRequest(DELETE_CONFIGURED_WORKFLOW, { id: freeCfgId }, token);
    const delBody = await delRes.json();
    expect(delBody.errors).toBeUndefined();
    expect(delBody.data.deleteConfiguredWorkflow).toBe(true);
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
          nodes: [
            { nodeKey: 'input' },
            { nodeKey: 'exec', agentConfig: { acpServerType: 'opencode', initNewWorktree: false } },
            { nodeKey: 'review' },
          ],
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
      { configuredWorkflowId: cfgId, workspaceId, name: `wf-a19-实例-${Date.now()}` },
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
  mcpEndpoint?: { url: string; token: string; serverNames: string[] };
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
          nodes: [
            { nodeKey: 'input' },
            { nodeKey: 'exec', agentConfig: { acpServerType: 'opencode', initNewWorktree: false } },
            { nodeKey: 'review' },
          ],
        },
      },
      token,
    );
    const cfgId = (await cfgRes.json()).data.configureWorkflow.id;
    const instRes = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      { configuredWorkflowId: cfgId, workspaceId, name: `wf-${tag}-实例-${Date.now()}` },
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
          nodes: [
            { nodeKey: 'input' },
            { nodeKey: 'exec', agentConfig: { acpServerType: 'opencode', initNewWorktree: false } },
            { nodeKey: 'review' },
          ],
        },
      },
      token,
    );
    const cfgId = (await cfgRes.json()).data.configureWorkflow.id;
    const instRes = await gqlRequest(
      INSTANTIATE_WORKFLOW,
      { configuredWorkflowId: cfgId, workspaceId, name: `wf-a24-实例-${Date.now()}` },
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
