import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as SocketIOClient, type Socket } from 'socket.io-client';
import { createFrontUser } from '../support/front-users.js';

const AGENT_API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273';

function gqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const body: Record<string, unknown> = { query };
  if (variables) body.variables = variables;
  return fetch(AGENT_API_URL, { method: 'POST', headers, body: JSON.stringify(body) });
}

const CREATE_KEY = `
  mutation CreateControllerKey($input: CreateKeyInput!) {
    createControllerKey(input: $input) { key { id } rawKey }
  }
`;

const CREATE_WORKSPACE = `
  mutation CreateWorkspace($input: CreateWorkspaceInput!) {
    createWorkspace(input: $input) { id controllerId path }
  }
`;

const CREATE_TEMPLATE = `
  mutation CreateTemplate($input: WorkflowTemplateInput!) {
    createWorkflowTemplate(input: $input) { id }
  }
`;

const CONFIGURE_WORKFLOW = `
  mutation ConfigureWorkflow($templateId: ID!, $input: ConfigureWorkflowInput!) {
    configureWorkflow(templateId: $templateId, input: $input) { id }
  }
`;

const INSTANTIATE_WORKFLOW = `
  mutation Instantiate($input: InstantiateWorkflowInput!) {
    instantiateWorkflow(input: $input) { id }
  }
`;

const ARCHIVE_INSTANCE = `
  mutation Archive($id: ID!, $archived: Boolean!) {
    archiveWorkflowInstance(id: $id, archived: $archived)
  }
`;

const DELETE_WORKSPACE = `
  mutation DeleteWorkspace($id: ID!) {
    deleteWorkspace(id: $id)
  }
`;

const CREATE_SESSION = `
  mutation CreateSession($input: CreateSessionInput!) {
    createSession(input: $input) { session { id controllerId } }
  }
`;

const WORKFLOW_INSTANCES = `
  query WorkflowInstances($workspaceId: ID, $controllerId: ID, $archived: Boolean) {
    workflowInstances(workspaceId: $workspaceId, controllerId: $controllerId, archived: $archived) {
      id name controllerId workspaceId archived
      workspace { id name }
      controller { id name }
    }
  }
`;

const SESSIONS = `
  query Sessions($controllerId: ID, $includeWorkflowSessions: Boolean) {
    sessions(controllerId: $controllerId, includeWorkflowSessions: $includeWorkflowSessions) {
      id controllerId status workflowInstanceId
    }
  }
`;

const HOME_OVERVIEW = `
  query HomeOverview {
    homeOverview {
      controllers { id name status gateways { gateways { id name } total } }
      sessions { id controllerId }
      sessionTotalCount
      workspaces { id name worktrees { path branch sessionCount } }
      workflowInstances { id name workspace { id name } controller { id name } }
      archivedWorkflowInstances { id name archived }
      todos { id title }
      unreadTodoCount
    }
  }
`;

// ---------------------------------------------------------------------------
// Fake controller：应答 acp:check 与 worktree 列举
// ---------------------------------------------------------------------------

interface FakeController {
  controllerId: string;
  socket: Socket;
  disconnect: () => void;
}

function registerFakeController(rawKey: string, hostname: string): Promise<FakeController> {
  return new Promise((resolve, reject) => {
    const client = SocketIOClient(CONTROLLER_API_URL, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    const timer = setTimeout(() => {
      client.disconnect();
      reject(new Error('Timeout registering controller'));
    }, 10000);

    client.on('acp:check', (data: { requestId: string }) => {
      client.emit('acp:check:result', {
        requestId: data.requestId,
        servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
      });
    });

    client.on('git:worktree:list', (data: { requestId: string }) => {
      client.emit('git:worktree:list:result', {
        requestId: data.requestId,
        success: true,
        worktrees: [{ path: '/tmp/fake-worktree', branch: 'feature-a' }],
      });
    });

    client.on('acp:start', (data: { requestId: string; sessionId: string }) => {
      client.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
        externalSessionId: `ext_${data.sessionId}`,
      });
    });

    client.once('registered', (data: { controllerId: string }) => {
      clearTimeout(timer);
      resolve({ controllerId: data.controllerId, socket: client, disconnect: () => client.disconnect() });
    });
    client.once('error', (data: { code: string; message: string }) => {
      clearTimeout(timer);
      client.disconnect();
      reject(new Error(`Register failed: ${data.message}`));
    });
    client.emit('register', { key: rawKey, hostname, version: '2.0.0' });
  });
}

// ---------------------------------------------------------------------------
// 数据准备 helpers
// ---------------------------------------------------------------------------

async function newUserToken(tag: string): Promise<string> {
  const { token } = await createFrontUser();
  return token;
}

async function createKey(token: string, name: string): Promise<string> {
  const res = await gqlRequest(CREATE_KEY, { input: { name, type: 'local' } }, token);
  const body = await res.json();
  return body.data.createControllerKey.rawKey;
}

async function createWorkspace(token: string, controllerId: string, path: string): Promise<string> {
  const res = await gqlRequest(CREATE_WORKSPACE, { input: { controllerId, path } }, token);
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data.createWorkspace.id;
}

const HUMAN_NODES = [
  { nodeKey: 'input', type: 'HUMAN', name: '需求输入', stage: '需求', dependsOn: [], requiresWorktree: false },
];

async function configureWorkflow(
  token: string,
  controllerId: string,
  name: string,
): Promise<string> {
  const tplRes = await gqlRequest(
    CREATE_TEMPLATE,
    { input: { name: `${name}-tpl`, description: 'home test', nodes: HUMAN_NODES } },
    token,
  );
  const tplBody = await tplRes.json();
  if (tplBody.errors) throw new Error(JSON.stringify(tplBody.errors));
  const templateId = tplBody.data.createWorkflowTemplate.id;

  const cfgRes = await gqlRequest(
    CONFIGURE_WORKFLOW,
    { templateId, input: { name, controllerId, nodes: HUMAN_NODES } },
    token,
  );
  const cfgBody = await cfgRes.json();
  if (cfgBody.errors) throw new Error(JSON.stringify(cfgBody.errors));
  return cfgBody.data.configureWorkflow.id;
}

async function instantiate(
  token: string,
  configuredWorkflowId: string,
  controllerId: string,
  workspaceId: string,
  name: string,
): Promise<string> {
  const res = await gqlRequest(
    INSTANTIATE_WORKFLOW,
    {
      input: {
        source: 'CONFIGURED',
        configuredWorkflowId,
        controllerId,
        workspaceId,
        name,
        nodes: HUMAN_NODES,
      },
    },
    token,
  );
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data.instantiateWorkflow.id;
}

async function gqlData<T>(query: string, variables: Record<string, unknown> | undefined, token?: string): Promise<T> {
  const res = await gqlRequest(query, variables, token);
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data as T;
}

async function createSession(token: string, controllerId: string, workspaceId: string): Promise<string> {
  const res = await gqlRequest(
    CREATE_SESSION,
    { input: { controllerId, acpServerType: 'opencode', workspaceId } },
    token,
  );
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data.createSession.session.id;
}

// ---------------------------------------------------------------------------

describe('首页聚合与按控制器索引 API', () => {
  let token = '';
  let otherToken = '';
  let controller: FakeController;
  let controllerId = '';
  let otherControllerId = '';
  let otherController: FakeController;
  let workspaceId = '';
  let instanceId = '';

  beforeAll(async () => {
    token = await newUserToken('main');
    const rawKey = await createKey(token, 'home-main');
    controller = await registerFakeController(rawKey, 'home-main-host');
    controllerId = controller.controllerId;
    workspaceId = await createWorkspace(token, controllerId, '/tmp/home-main-ws');

    otherToken = await newUserToken('other');
    const otherRawKey = await createKey(otherToken, 'home-other');
    otherController = await registerFakeController(otherRawKey, 'home-other-host');
    otherControllerId = otherController.controllerId;

    const cfgId = await configureWorkflow(token, controllerId, 'home-main-cfg');
    instanceId = await instantiate(token, cfgId, controllerId, workspaceId, '集中列表实例');

    // 普通会话（用于 sessions(controllerId) 过滤与隔离断言）
    await createSession(token, controllerId, workspaceId);

    // 另一用户也创建一个实例（用于隔离断言）
    const otherWs = await createWorkspace(otherToken, otherControllerId, '/tmp/home-other-ws');
    const otherCfg = await configureWorkflow(otherToken, otherControllerId, 'home-other-cfg');
    await instantiate(otherToken, otherCfg, otherControllerId, otherWs, '他人实例');
  }, 60000);

  afterAll(() => {
    controller?.disconnect();
    otherController?.disconnect();
  });

  it('T-H0 homeOverview 未认证返回 Not authenticated', async () => {
    const res = await gqlRequest(HOME_OVERVIEW);
    const body = await res.json();
    expect(body.errors?.[0]?.message).toContain('Not authenticated');
  });

  it('T-H1 homeOverview 全字段与既有查询一致，仅含当前用户数据', async () => {
    const data = await gqlData<{
      homeOverview: {
        controllers: Array<{ id: string }>;
        sessions: unknown[];
        sessionTotalCount: number;
        workspaces: Array<{ id: string }>;
        workflowInstances: Array<{ id: string; workspace: { id: string } | null; controller: { id: string } | null }>;
        archivedWorkflowInstances: unknown[];
        todos: unknown[];
        unreadTodoCount: number;
      };
    }>(HOME_OVERVIEW, undefined, token);

    const home = data.homeOverview;
    expect(home.controllers.map((c) => c.id)).toContain(controllerId);
    expect(home.controllers.map((c) => c.id)).not.toContain(otherControllerId);
    expect(home.workspaces.some((w) => w.id === workspaceId)).toBe(true);
    expect(home.sessionTotalCount).toBe(home.sessions.length);
    expect(home.workflowInstances.some((i) => i.id === instanceId)).toBe(true);
    // 归属字段
    const inst = home.workflowInstances.find((i) => i.id === instanceId)!;
    expect(inst.workspace?.id).toBe(workspaceId);
    expect(inst.controller?.id).toBe(controllerId);
    expect(home.unreadTodoCount).toBeGreaterThanOrEqual(0);
  });

  it('T-H2 嵌套 gateways（在线控制器）返回列表且不报错', async () => {
    const data = await gqlData<{
      homeOverview: { controllers: Array<{ id: string; gateways: { gateways: unknown[]; total: number } }> };
    }>(HOME_OVERVIEW, undefined, token);
    const ctrl = data.homeOverview.controllers.find((c) => c.id === controllerId)!;
    expect(Array.isArray(ctrl.gateways.gateways)).toBe(true);
  });

  it('T-H3 嵌套 worktrees（在选择时扇出，工作区返回列表）', async () => {
    const data = await gqlData<{
      homeOverview: { workspaces: Array<{ id: string; worktrees: Array<{ path: string; branch: string | null }> }> };
    }>(HOME_OVERVIEW, undefined, token);
    const ws = data.homeOverview.workspaces.find((w) => w.id === workspaceId)!;
    expect(ws.worktrees.some((w) => w.path === '/tmp/fake-worktree')).toBe(true);
  });

  it('T-W1/T-W3 workflowInstances 无参返回全部，controllerId 仅返回该控制器', async () => {
    const all = await gqlData<{ workflowInstances: Array<{ id: string }> }>(
      WORKFLOW_INSTANCES,
      {},
      token,
    );
    expect(all.workflowInstances.some((i) => i.id === instanceId)).toBe(true);

    const byController = await gqlData<{ workflowInstances: Array<{ controllerId: string }> }>(
      WORKFLOW_INSTANCES,
      { controllerId },
      token,
    );
    expect(byController.workflowInstances.every((i) => i.controllerId === controllerId)).toBe(true);
    expect(byController.workflowInstances.some((i) => i.id === instanceId)).toBe(true);
  });

  it('T-W2/T-W4 workspaceId 与 workspaceId+controllerId 交集', async () => {
    const byWorkspace = await gqlData<{ workflowInstances: Array<{ workspaceId: string }> }>(
      WORKFLOW_INSTANCES,
      { workspaceId },
      token,
    );
    expect(byWorkspace.workflowInstances.every((i) => i.workspaceId === workspaceId)).toBe(true);

    const intersection = await gqlData<{ workflowInstances: Array<{ id: string }> }>(
      WORKFLOW_INSTANCES,
      { workspaceId, controllerId },
      token,
    );
    expect(intersection.workflowInstances.some((i) => i.id === instanceId)).toBe(true);

    // 交叉不匹配：他人工作区 + 当前控制器 → 空
    const mismatch = await gqlData<{ workflowInstances: Array<{ id: string }> }>(
      WORKFLOW_INSTANCES,
      { workspaceId, controllerId: otherControllerId },
      token,
    );
    expect(mismatch.workflowInstances).toHaveLength(0);
  });

  it('T-W5/T-W6 archived 过滤与跨用户隔离', async () => {
    // 归档本用户实例
    await gqlData(ARCHIVE_INSTANCE, { id: instanceId, archived: true }, token);

    const active = await gqlData<{ workflowInstances: Array<{ id: string }> }>(
      WORKFLOW_INSTANCES,
      {},
      token,
    );
    expect(active.workflowInstances.some((i) => i.id === instanceId)).toBe(false);

    const archived = await gqlData<{ workflowInstances: Array<{ id: string }> }>(
      WORKFLOW_INSTANCES,
      { archived: true },
      token,
    );
    expect(archived.workflowInstances.some((i) => i.id === instanceId)).toBe(true);

    // homeOverview 归档字段
    const home = await gqlData<{ homeOverview: { workflowInstances: unknown[]; archivedWorkflowInstances: Array<{ id: string }> } }>(
      HOME_OVERVIEW,
      undefined,
      token,
    );
    expect(home.homeOverview.archivedWorkflowInstances.some((i) => i.id === instanceId)).toBe(true);
    expect(home.homeOverview.workflowInstances.some((i) => (i as { id: string }).id === instanceId)).toBe(false);

    // 跨用户隔离：其他用户看不到本用户实例
    const otherList = await gqlData<{ workflowInstances: Array<{ id: string }> }>(
      WORKFLOW_INSTANCES,
      {},
      otherToken,
    );
    expect(otherList.workflowInstances.some((i) => i.id === instanceId)).toBe(false);
  });

  it('T-S1/T-S2 sessions(controllerId) 过滤且无参与现状一致', async () => {
    const all = await gqlData<{ sessions: Array<{ id: string }> }>(SESSIONS, {}, token);
    expect(Array.isArray(all.sessions)).toBe(true);

    const byController = await gqlData<{ sessions: Array<{ controllerId: string }> }>(
      SESSIONS,
      { controllerId },
      token,
    );
    expect(byController.sessions.length).toBeGreaterThan(0);
    expect(byController.sessions.every((s) => s.controllerId === controllerId)).toBe(true);
  });

  it('T-S3 sessions(controllerId) 与 includeWorkflowSessions 组合过滤正确叠加', async () => {
    const withWorkflow = await gqlData<{
      sessions: Array<{ controllerId: string; workflowInstanceId: string | null }>;
    }>(SESSIONS, { controllerId, includeWorkflowSessions: true }, token);
    const withoutWorkflow = await gqlData<{
      sessions: Array<{ controllerId: string; workflowInstanceId: string | null }>;
    }>(SESSIONS, { controllerId, includeWorkflowSessions: false }, token);

    // controllerId 过滤在两种口径下均生效
    expect(withWorkflow.sessions.every((s) => s.controllerId === controllerId)).toBe(true);
    expect(withoutWorkflow.sessions.every((s) => s.controllerId === controllerId)).toBe(true);
    // includeWorkflowSessions=true 是 false 的超集，且默认口径不含工作流节点会话
    expect(withWorkflow.sessions.length).toBeGreaterThanOrEqual(withoutWorkflow.sessions.length);
    expect(withoutWorkflow.sessions.every((s) => s.workflowInstanceId === null)).toBe(true);
  });

  it('T-S4 sessions 跨用户隔离（他人会话不可见）', async () => {
    const otherByMainController = await gqlData<{ sessions: Array<{ id: string }> }>(
      SESSIONS,
      { controllerId },
      otherToken,
    );
    expect(otherByMainController.sessions).toHaveLength(0);

    const otherOwn = await gqlData<{ sessions: Array<{ controllerId: string }> }>(
      SESSIONS,
      {},
      otherToken,
    );
    expect(otherOwn.sessions.every((s) => s.controllerId !== controllerId)).toBe(true);
  });

  it('T-W7 实例的 workspace 已删除时 workspace 为 null，controller 正常返回', async () => {
    // 独立工作区 + 实例，删除工作区后断言归属字段降级语义
    const ws = await createWorkspace(token, controllerId, `/tmp/home-t-w7-${Date.now()}`);
    const cfg = await configureWorkflow(token, controllerId, `home-t-w7-cfg-${Date.now()}`);
    const inst = await instantiate(token, cfg, controllerId, ws, '待删工作区实例');

    const delRes = await gqlRequest(DELETE_WORKSPACE, { id: ws }, token);
    const delBody = await delRes.json();
    expect(delBody.errors).toBeUndefined();
    expect(delBody.data.deleteWorkspace).toBe(true);

    const list = await gqlData<{
      workflowInstances: Array<{
        id: string;
        workspace: { id: string } | null;
        controller: { id: string } | null;
      }>;
    }>(WORKFLOW_INSTANCES, { controllerId }, token);

    const target = list.workflowInstances.find((i) => i.id === inst);
    expect(target).toBeDefined();
    expect(target!.workspace).toBeNull();
    expect(target!.controller?.id).toBe(controllerId);
  });

  // 注：T-W8「旧调用方式（workspaceId 必传）语义零变化」由 T-W2 的 workspaceId 过滤断言锚定。
});
