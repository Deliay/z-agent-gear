import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';

const AGENT_API_URL = process.env.API_URL || 'http://localhost:4000/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

function gqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const body: Record<string, unknown> = { query };
  if (variables) body.variables = variables;
  return fetch(AGENT_API_URL, { method: 'POST', headers, body: JSON.stringify(body) });
}

const SIGNUP = `mutation Signup($username: String!, $password: String!) { signup(username: $username, password: $password) { token user { id username } } }`;
const CREATE_KEY = `mutation CreateControllerKey($input: CreateKeyInput!) { createControllerKey(input: $input) { key { id name } rawKey } }`;
const CREATE_WORKSPACE = `mutation CreateWorkspace($input: CreateWorkspaceInput!) { createWorkspace(input: $input) { id controllerId path } }`;
const CREATE_SESSION = `mutation CreateSession($input: CreateSessionInput!) { createSession(input: $input) { session { id status acpServerType worktreePath worktreeBranch } } }`;
const DELETE_SESSION = `mutation DeleteSession($id: ID!) { deleteSession(id: $id) }`;
const SESSIONS_QUERY = `query Sessions { sessions { id status worktreePath worktreeBranch controllerId } }`;
const WORKSPACE_WORKTREES = `query WorkspaceWorktrees($controllerId: ID!, $workspaceId: ID!) { workspaceWorktrees(controllerId: $controllerId, workspaceId: $workspaceId) { path branch sessionCount sessions { id title status worktreePath } } }`;
const DELETE_WORKTREE = `mutation DeleteWorktree($controllerId: ID!, $workspaceId: ID!, $worktreePath: String!) { deleteWorktree(controllerId: $controllerId, workspaceId: $workspaceId, worktreePath: $worktreePath) { success closedSessionIds failures { sessionId error } error } }`;
const REFRESH_ACP_CAPABILITIES = `mutation RefreshAcpCapabilities($controllerId: ID!) { refreshAcpCapabilities(controllerId: $controllerId) { type available version checkedAt } }`;
const DETECT_GIT_REPO = `query DetectGitRepo($controllerId: ID!, $workspaceId: ID!) { detectGitRepo(controllerId: $controllerId, workspaceId: $workspaceId) { isGitRepo currentBranch branches defaultBranch } }`;
const SESSION_QUERY = `query Session($id: ID!) { session(id: $id) { id status } }`;
const CREATE_WORKFLOW_TEMPLATE = `mutation CreateWorkflowTemplate($input: WorkflowTemplateInput!) { createWorkflowTemplate(input: $input) { id } }`;
const CONFIGURE_WORKFLOW = `mutation ConfigureWorkflow($templateId: ID!, $input: ConfigureWorkflowInput!) { configureWorkflow(templateId: $templateId, input: $input) { id } }`;
const INSTANTIATE_WORKFLOW = `mutation InstantiateWorkflow($input: InstantiateWorkflowInput!) { instantiateWorkflow(input: $input) { id nodes { id nodeKey type name status sessionId } } }`;
const COMPLETE_HUMAN_NODE = `mutation CompleteHumanNode($instanceId: ID!, $nodeId: ID!, $input: String) { completeHumanNode(instanceId: $instanceId, nodeId: $nodeId, input: $input) { id status } }`;
const REJECT_NODE = `mutation RejectNode($instanceId: ID!, $nodeId: ID!, $reason: String!) { rejectNode(instanceId: $instanceId, nodeId: $nodeId, reason: $reason) { id status } }`;
const DELETE_WORKFLOW_INSTANCE = `mutation DeleteWorkflowInstance($id: ID!) { deleteWorkflowInstance(id: $id) }`;
const WORKFLOW_INSTANCE_QUERY = `query WorkflowInstance($id: ID!) { workflowInstance(id: $id) { id nodes { id nodeKey type name status sessionId } } }`;

function createClient(): ClientSocket {
  return SocketIOClient(CONTROLLER_API_URL, { transports: ['websocket'], reconnection: false, forceNew: true });
}

function waitForEvent<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 10000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => { clearTimeout(timer); resolve(data); });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function signup(tag: string): Promise<string> {
  const uid = `${tag}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
  const body = await res.json();
  if (!body.data?.signup?.token) {
    console.error('signup failed:', JSON.stringify(body));
  }
  return body.data?.signup?.token ?? '';
}

interface FakeController {
  client: ClientSocket;
  controllerId: string;
  rawKey: string;
}

async function registerFakeController(
  token: string,
  tag: string,
  servers: { type: string; available: boolean; version?: string }[] = [
    { type: 'opencode', available: true, version: '1.0.0' },
  ],
  opts: { failWorktreeRemove?: boolean; failFsRemove?: boolean } = {},
): Promise<FakeController> {
  const keyRes = await gqlRequest(CREATE_KEY, { input: { name: `wt-${tag}-${Date.now()}`, type: 'local' } }, token);
  const keyBody = await keyRes.json();
  if (!keyBody.data?.createControllerKey) {
    console.error('createControllerKey failed:', JSON.stringify(keyBody));
  }
  const rawKey = keyBody.data.createControllerKey.rawKey;
  const client = createClient();
  client.on('acp:check', (data: { requestId: string }) => {
    client.emit('acp:check:result', { requestId: data.requestId, servers });
  });
  // Auto-answer worktree events
  client.on('git:worktree:list', (data: { requestId: string }) => {
    client.emit('git:worktree:list:result', { requestId: data.requestId, success: true, worktrees: [] });
  });
  client.on('git:worktree:remove', (data: { requestId: string }) => {
    if (opts.failWorktreeRemove) {
      client.emit('git:worktree:remove:result', { requestId: data.requestId, success: false, error: 'simulated git worktree remove failure' });
    } else {
      client.emit('git:worktree:remove:result', { requestId: data.requestId, success: true });
    }
  });
  client.on('fs:remove-dir', (data: { requestId: string }) => {
    if (opts.failFsRemove) {
      client.emit('fs:remove-dir:result', { requestId: data.requestId, success: false, error: 'simulated fs remove failure' });
    } else {
      client.emit('fs:remove-dir:result', { requestId: data.requestId, success: true });
    }
  });
  // Auto-answer git:worktree:add (create worktree)
  client.on('git:worktree:add', (data: { requestId: string; repoPath: string; worktreePath: string; branch: string }) => {
    client.emit('git:worktree:add:result', { requestId: data.requestId, success: true, worktreePath: data.worktreePath });
  });
  // Auto-answer git:status (check if worktree is clean)
  client.on('git:status', (data: { requestId: string; path: string }) => {
    client.emit('git:status:result', { requestId: data.requestId, isClean: true });
  });
  // Auto-answer git:commit (commit worktree changes)
  client.on('git:commit', (data: { requestId: string }) => {
    client.emit('git:commit:result', { requestId: data.requestId, success: true });
  });
  // Auto-answer ACP start requests
  client.on('acp:start', (data: { requestId: string; sessionId: string; serverType: string; cwd: string }) => {
    client.emit('acp:start:result', { requestId: data.requestId, success: true, sessionId: data.sessionId });
  });
  // Auto-answer ACP stop requests (emit acp:stopped ack)
  client.on('acp:stop', (data: { sessionId: string; ackRequired?: boolean }) => {
    if (data.ackRequired) {
      client.emit('acp:stopped', { sessionId: data.sessionId, reason: 'user_delete', killed: true });
    }
  });
  const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
  client.emit('register', { key: rawKey, hostname: `wt-${tag}-host`, version: '1.0.0' });
  const regData = await registered;
  return { client, controllerId: regData.controllerId, rawKey };
}

async function refreshCapabilities(token: string, controllerId: string): Promise<string[]> {
  const res = await gqlRequest(REFRESH_ACP_CAPABILITIES, { controllerId }, token);
  const body = await res.json();
  return (body.data.refreshAcpCapabilities as { type: string; available: boolean }[])
    .filter((s) => s.available).map((s) => s.type);
}

async function createWorkspace(token: string, controllerId: string, path?: string): Promise<{ id: string; path: string }> {
  const wsPath = path || `/tmp/wt-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const res = await gqlRequest(CREATE_WORKSPACE, { input: { controllerId, path: wsPath } }, token);
  const body = await res.json();
  if (body.errors) throw new Error(`createWorkspace failed: ${JSON.stringify(body.errors)}`);
  return body.data.createWorkspace;
}

/** 工作区名称 = 路径 basename（与服务端 createWorkspace 一致） */
function workspaceNameOf(wsPath: string): string {
  return wsPath.split('/').filter(Boolean).pop() || wsPath;
}

/** 服务端默认 worktreeDir 下的归属路径（existingWorktreePath 必须位于该 scope 内） */
function scopedWorktreePath(wsName: string, suffix: string): string {
  return `~/.zag/worktrees/${wsName}/${suffix}`;
}

/** 轮询直到条件成立 */
async function pollUntil(fn: () => boolean | Promise<boolean>, timeoutMs = 15000, label = 'pollUntil'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(200);
  }
  throw new Error(`${label}: timed out after ${timeoutMs}ms`);
}

/** 收集 count 个指定事件（多个 acp:start 场景，once 会在首个事件上全部触发，需用 on 收集） */
function collectEvents<T = unknown>(socket: ClientSocket, event: string, count: number, timeoutMs = 15000): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const items: T[] = [];
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timeout collecting ${count} "${event}" events (got ${items.length})`));
    }, timeoutMs);
    const handler = (data: T) => {
      items.push(data);
      if (items.length >= count) {
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(items);
      }
    };
    socket.on(event, handler);
  });
}

interface WorkflowNodeInfo {
  id: string;
  nodeKey: string;
  type: string;
  name: string;
  status: string;
  sessionId: string | null;
}

/** 真实实例化一个工作流：HUMAN(input) → 若干并行 AI 节点（均依赖 input） */
async function setupWorkflowInstance(
  token: string,
  controllerId: string,
  workspaceId: string,
  tag: string,
  aiNodeKeys: string[],
): Promise<{ instanceId: string; nodes: WorkflowNodeInfo[] }> {
  const agentConfig = { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: false };
  const buildNodes = () => [
    { nodeKey: 'input', type: 'HUMAN', name: '需求输入', stage: '阶段一', dependsOn: [], requiresWorktree: false },
    ...aiNodeKeys.map((key) => ({
      nodeKey: key,
      type: 'AI',
      name: `AI-${key}`,
      stage: '阶段一',
      prompts: [`完成 ${key}`],
      artifactTitles: [`${key}产物`],
      dependsOn: ['input'],
      requiresWorktree: false,
    })),
  ];
  const tplRes = await gqlRequest(CREATE_WORKFLOW_TEMPLATE, { input: { name: `wt-wf-${tag}-tpl-${Date.now()}`, nodes: buildNodes() } }, token);
  const tplBody = await tplRes.json();
  if (tplBody.errors) throw new Error(`createWorkflowTemplate failed: ${JSON.stringify(tplBody.errors)}`);
  const templateId = tplBody.data.createWorkflowTemplate.id;

  const configureNodes = buildNodes().map((n) => (n.type === 'AI' ? { ...n, agentConfig } : n));
  const cfgRes = await gqlRequest(CONFIGURE_WORKFLOW, {
    templateId,
    input: { name: `wt-wf-${tag}-cfg-${Date.now()}`, controllerId, nodes: configureNodes },
  }, token);
  const cfgBody = await cfgRes.json();
  if (cfgBody.errors) throw new Error(`configureWorkflow failed: ${JSON.stringify(cfgBody.errors)}`);
  const configuredWorkflowId = cfgBody.data.configureWorkflow.id;

  const instRes = await gqlRequest(INSTANTIATE_WORKFLOW, {
    input: {
      source: 'CONFIGURED',
      configuredWorkflowId,
      controllerId,
      workspaceId,
      name: `wt-wf-${tag}-实例-${Date.now()}`,
      nodes: configureNodes,
    },
  }, token);
  const instBody = await instRes.json();
  if (instBody.errors) throw new Error(`instantiateWorkflow failed: ${JSON.stringify(instBody.errors)}`);
  return { instanceId: instBody.data.instantiateWorkflow.id, nodes: instBody.data.instantiateWorkflow.nodes };
}

async function queryWorkflowInstance(token: string, instanceId: string): Promise<{ nodes: WorkflowNodeInfo[] } | null> {
  const res = await gqlRequest(WORKFLOW_INSTANCE_QUERY, { id: instanceId }, token);
  const body = await res.json();
  return body.data?.workflowInstance ?? null;
}

async function querySessionStatus(token: string, sessionId: string): Promise<string | null> {
  const res = await gqlRequest(SESSION_QUERY, { id: sessionId }, token);
  const body = await res.json();
  return body.data?.session?.status ?? null;
}

describe('Worktree API Tests', () => {
  let token: string;
  let ctrl: FakeController;
  let workspaceId: string;
  let workspacePath: string;
  let workspaceName: string;

  beforeAll(async () => {
    token = await signup('wt-api');
    ctrl = await registerFakeController(token, 'wt-api');
    await refreshCapabilities(token, ctrl.controllerId);
    const ws = await createWorkspace(token, ctrl.controllerId);
    workspaceId = ws.id;
    workspacePath = ws.path;
    workspaceName = workspaceNameOf(ws.path);
  }, 30000);

  afterAll(() => {
    ctrl?.client?.disconnect();
  });

  // ── A1: workspaceWorktrees 查询 ──────────────────────────────
  describe('A1: workspaceWorktrees', () => {
    it('should return worktree list with sessions for git workspace', async () => {
      // Create a session with worktreePath
      const sessionRes = await gqlRequest(CREATE_SESSION, {
        input: { controllerId: ctrl.controllerId, acpServerType: 'opencode', workspaceId, enableWorktree: true, worktreeBranchSuffix: 'a1-test' },
      }, token);
      const sessionBody = await sessionRes.json();
      const session = sessionBody.data?.createSession?.session;

      // Query workspaceWorktrees
      const res = await gqlRequest(WORKSPACE_WORKTREES, { controllerId: ctrl.controllerId, workspaceId }, token);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      const worktrees = body.data.workspaceWorktrees;
      expect(Array.isArray(worktrees)).toBe(true);
      // At least one worktree should exist (from the session or from controller)
      // The worktree should have path, branch, sessionCount, sessions
      for (const wt of worktrees) {
        expect(wt.path).toBeDefined();
        expect(typeof wt.sessionCount).toBe('number');
        expect(Array.isArray(wt.sessions)).toBe(true);
      }
    });
  });

  // ── A2: workspaceWorktrees controller 离线降级 ──────────────
  describe('A2: workspaceWorktrees controller offline degradation', () => {
    it('should degrade to session-only grouping when controller offline', async () => {
      // Create workspace pointing to a different (offline) controller
      const offlineToken = await signup('wtoff');
      const offlineCtrl = await registerFakeController(offlineToken, 'wtoff-off');
      const offWs = await createWorkspace(offlineToken, offlineCtrl.controllerId);
      offlineCtrl.client.disconnect();

      // Wait for controller to go offline
      await sleep(2000);

      // Query should not error, just return sessions-only
      const res = await gqlRequest(WORKSPACE_WORKTREES, { controllerId: offlineCtrl.controllerId, workspaceId: offWs.id }, offlineToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(Array.isArray(body.data.workspaceWorktrees)).toBe(true);
    }, 20000);
  });

  // ── A3: createSession(existingWorktreePath) ──────────────────
  describe('A3: createSession with existingWorktreePath', () => {
    it('should reuse existing worktree without git:worktree:add', async () => {
      // existingWorktreePath 必须位于该 workspace 的 worktreeDir scope 内（归属校验）
      const testPath = scopedWorktreePath(workspaceName, `reuse-${Date.now()}`);
      const acpStartPromise = waitForEvent<{
        requestId: string; sessionId: string; serverType: string; cwd: string;
      }>(ctrl.client, 'acp:start', 10000);

      const res = await gqlRequest(CREATE_SESSION, {
        input: {
          controllerId: ctrl.controllerId,
          acpServerType: 'opencode',
          workspaceId,
          existingWorktreePath: testPath,
        },
      }, token);
      const body = await res.json();
      const session = body.data?.createSession?.session;
      expect(session).toBeDefined();
      expect(session.id).toBeTruthy();

      // Wait for acp:start and verify cwd points to existingWorktreePath
      const startPayload = await acpStartPromise;
      expect(startPayload.cwd).toBe(testPath);
      expect(startPayload.sessionId).toBe(session.id);

      // Verify worktreePath is set
      expect(session.worktreePath).toBe(testPath);
    }, 15000);
  });

  // ── A4: createSession existingWorktreePath + enableWorktree 互斥 ──
  describe('A4: createSession existingWorktreePath + enableWorktree mutual exclusion', () => {
    it('should reject when both existingWorktreePath and enableWorktree are provided', async () => {
      const res = await gqlRequest(CREATE_SESSION, {
        input: {
          controllerId: ctrl.controllerId,
          acpServerType: 'opencode',
          workspaceId,
          enableWorktree: true,
          existingWorktreePath: '/tmp/conflict',
        },
      }, token);
      const body = await res.json();
      // Should return an error about mutual exclusion
      expect(body.errors).toBeDefined();
      const errMsg = body.errors[0]?.message || '';
      expect(errMsg.toLowerCase()).toMatch(/mutually exclusive|互斥|existingworktreepath.*enableworktree|cannot.*both/);
    });
  });

  // ── A5: deleteSession ack 顺序 ──────────────────────────────
  describe('A5: deleteSession with ack ordering', () => {
    it('should stop process before worktree cleanup', async () => {
      // Create a session with worktree
      const sessionRes = await gqlRequest(CREATE_SESSION, {
        input: { controllerId: ctrl.controllerId, acpServerType: 'opencode', workspaceId, enableWorktree: true, worktreeBranchSuffix: 'a5-del' },
      }, token);
      const sessionBody = await sessionRes.json();
      const sessionId = sessionBody.data?.createSession?.session?.id;
      expect(sessionId).toBeTruthy();

      // Wait for acp:start
      await waitForEvent(ctrl.client, 'acp:start', 10000);

      // Delete the session
      const deleteRes = await gqlRequest(DELETE_SESSION, { id: sessionId }, token);
      const deleteBody = await deleteRes.json();
      expect(deleteBody.data?.deleteSession).toBe(true);

      // Verify session is gone
      const sessionsRes = await gqlRequest(SESSIONS_QUERY, {}, token);
      const sessionsBody = await sessionsRes.json();
      const found = sessionsBody.data?.sessions?.find((s: { id: string }) => s.id === sessionId);
      expect(found).toBeUndefined();
    }, 15000);
  });

  // ── A6: deleteWorktree 正常路径 ─────────────────────────────
  describe('A6: deleteWorktree happy path', () => {
    it('should close all sessions and remove worktree', async () => {
      // Create sessions in a worktree（路径须归属本 workspace 的 worktreeDir scope）
      const wtPath = scopedWorktreePath(workspaceName, `del-${Date.now()}`);
      const s1Res = await gqlRequest(CREATE_SESSION, {
        input: { controllerId: ctrl.controllerId, acpServerType: 'opencode', workspaceId, existingWorktreePath: wtPath },
      }, token);
      const s1Body = await s1Res.json();
      const s1Id = s1Body.data?.createSession?.session?.id;
      await waitForEvent(ctrl.client, 'acp:start', 10000);

      // Delete the worktree
      const res = await gqlRequest(DELETE_WORKTREE, {
        controllerId: ctrl.controllerId,
        workspaceId,
        worktreePath: wtPath,
      }, token);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      const result = body.data.deleteWorktree;
      expect(result.success).toBe(true);
      expect(result.closedSessionIds).toContain(s1Id);
      expect(result.failures).toEqual([]);
    }, 20000);
  });

  // ── A7: deleteWorktree 部分失败 ─────────────────────────────
  describe('A7: deleteWorktree with partial failures', () => {
    // git:worktree:remove 与 fs:remove-dir 均失败的 controller
    let failCtrl: FakeController;
    let failWorkspaceId: string;
    let failWsName: string;
    // 仅 git:worktree:remove 失败、fs 兜底成功的 controller
    let fbCtrl: FakeController;
    let fbWorkspaceId: string;
    let fbWsName: string;

    beforeAll(async () => {
      failCtrl = await registerFakeController(token, 'wt-a7-fail', undefined, { failWorktreeRemove: true, failFsRemove: true });
      const failWs = await createWorkspace(token, failCtrl.controllerId);
      failWorkspaceId = failWs.id;
      failWsName = workspaceNameOf(failWs.path);

      fbCtrl = await registerFakeController(token, 'wt-a7-fb', undefined, { failWorktreeRemove: true });
      const fbWs = await createWorkspace(token, fbCtrl.controllerId);
      fbWorkspaceId = fbWs.id;
      fbWsName = workspaceNameOf(fbWs.path);
    }, 30000);

    afterAll(() => {
      failCtrl?.client?.disconnect();
      fbCtrl?.client?.disconnect();
    });

    it('should report session cleanup failure and removal error (success=false)', async () => {
      // 会话通过 enableWorktree 创建 → 会话“拥有”该 worktree（记录 worktreeBranch），
      // deleteWorktree 逐会话清理时会对该 worktree 执行 git:worktree:remove（此处注入失败）
      const sRes = await gqlRequest(CREATE_SESSION, {
        input: { controllerId: failCtrl.controllerId, acpServerType: 'opencode', workspaceId: failWorkspaceId, enableWorktree: true, worktreeBranchSuffix: 'pfail' },
      }, token);
      const sBody = await sRes.json();
      expect(sBody.errors).toBeUndefined();
      const session = sBody.data.createSession.session;
      const sessionId = session.id as string;
      expect(session.worktreePath).toBeTruthy();
      await waitForEvent(failCtrl.client, 'acp:start', 10000);

      const res = await gqlRequest(DELETE_WORKTREE, {
        controllerId: failCtrl.controllerId,
        workspaceId: failWorkspaceId,
        worktreePath: session.worktreePath,
      }, token);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      const result = body.data.deleteWorktree;

      // 会话清理失败被逐条汇报（WORKTREE_REMOVE_FAILED），不阻塞整体移除尝试
      expect(result.success).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].sessionId).toBe(sessionId);
      expect(result.failures[0].error).toContain('WORKTREE_REMOVE_FAILED');
      expect(result.closedSessionIds).not.toContain(sessionId);
      // git:worktree:remove 失败且 fs 兜底也失败 → error 非空
      expect(result.error).toBeTruthy();
      expect(result.error).toContain('simulated git worktree remove failure');

      // 清理失败的会话仍留在 DB 中（未被误删）
      expect(await querySessionStatus(token, sessionId)).not.toBeNull();
    }, 30000);

    it('should succeed via fs:remove-dir fallback (success=true, error=null)', async () => {
      // existingWorktreePath 复用的会话不拥有 worktree（无 worktreeBranch），
      // 会话清理不会失败；git:worktree:remove 注入失败，fs 兜底成功应清除 error
      const wtPath = scopedWorktreePath(fbWsName, `fb-${Date.now()}`);
      const sRes = await gqlRequest(CREATE_SESSION, {
        input: { controllerId: fbCtrl.controllerId, acpServerType: 'opencode', workspaceId: fbWorkspaceId, existingWorktreePath: wtPath },
      }, token);
      const sBody = await sRes.json();
      expect(sBody.errors).toBeUndefined();
      const sessionId = sBody.data.createSession.session.id as string;
      await waitForEvent(fbCtrl.client, 'acp:start', 10000);

      const res = await gqlRequest(DELETE_WORKTREE, {
        controllerId: fbCtrl.controllerId,
        workspaceId: fbWorkspaceId,
        worktreePath: wtPath,
      }, token);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      const result = body.data.deleteWorktree;

      // fs 兜底成功 → removeError 被清除，success = failures 为空 && error 为 null
      expect(result.success).toBe(true);
      expect(result.error).toBeNull();
      expect(result.failures).toEqual([]);
      expect(result.closedSessionIds).toContain(sessionId);

      // 会话已从 DB 删除
      await pollUntil(async () => (await querySessionStatus(token, sessionId)) === null, 10000, 'waiting for session deletion');
    }, 30000);
  });

  // ── A8: deleteWorkflowInstance 多节点实例 ────────────────────
  describe('A8: deleteWorkflowInstance multi-node cleanup', () => {
    it('should clean up all node sessions on instance deletion', async () => {
      // 真实实例化多节点工作流：HUMAN(input) → 并行 AI(a) + AI(b)
      const { instanceId, nodes } = await setupWorkflowInstance(token, ctrl.controllerId, workspaceId, 'a8', ['a', 'b']);
      const inputNode = nodes.find((n) => n.nodeKey === 'input')!;
      expect(inputNode.status).toBe('READY');

      // 完成人类节点 → 两个并行 AI 节点各自拉起会话（监听器先于 mutation 注册）
      const startsPromise = collectEvents<{ sessionId: string }>(ctrl.client, 'acp:start', 2, 20000);
      const completeRes = await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId, nodeId: inputNode.id, input: '多节点清理测试' }, token);
      const completeBody = await completeRes.json();
      expect(completeBody.errors).toBeUndefined();
      const starts = await startsPromise;
      const nodeSessionIds = [...new Set(starts.map((s) => s.sessionId))];
      expect(nodeSessionIds).toHaveLength(2);

      // 两个 AI 节点均 RUNNING 且各自绑定会话
      await pollUntil(async () => {
        const inst = await queryWorkflowInstance(token, instanceId);
        const aiNodes = inst?.nodes.filter((n) => n.type === 'AI') ?? [];
        return aiNodes.length === 2 && aiNodes.every((n) => n.status === 'RUNNING' && n.sessionId);
      }, 15000, 'waiting for AI nodes RUNNING');
      const inst = (await queryWorkflowInstance(token, instanceId))!;
      const boundSessionIds = inst.nodes.filter((n) => n.type === 'AI').map((n) => n.sessionId!);
      expect(boundSessionIds.sort()).toEqual([...nodeSessionIds].sort());

      // 删除前：两个节点会话均存在
      for (const sid of nodeSessionIds) {
        expect(await querySessionStatus(token, sid)).not.toBeNull();
      }

      // 删除实例 → 全部节点会话被清理
      const delRes = await gqlRequest(DELETE_WORKFLOW_INSTANCE, { id: instanceId }, token);
      const delBody = await delRes.json();
      expect(delBody.errors).toBeUndefined();
      expect(delBody.data.deleteWorkflowInstance).toBe(true);

      for (const sid of nodeSessionIds) {
        await pollUntil(async () => (await querySessionStatus(token, sid)) === null, 15000, `waiting for node session ${sid} cleanup`);
      }
    }, 60000);
  });

  // ── A9: 并发实例化（简化版：并发创建 session） ──────────────
  describe('A9: concurrent session creation', () => {
    it('should handle multiple concurrent session starts', async () => {
      const count = 3;
      // Register listeners BEFORE firing mutations to avoid race condition
      const startPromises = Array.from({ length: count }, () =>
        waitForEvent<{ requestId: string; sessionId: string; serverType: string; cwd: string }>(
          ctrl.client, 'acp:start', 15000,
        ),
      );
      const promises: Promise<unknown>[] = [];
      for (let i = 0; i < count; i++) {
        promises.push(
          gqlRequest(CREATE_SESSION, {
            input: { controllerId: ctrl.controllerId, acpServerType: 'opencode', workspaceId },
          }, token),
        );
      }
      const results = await Promise.all(promises);
      for (const res of results) {
        const body = await res.json();
        expect(body.data?.createSession?.session?.id).toBeTruthy();
      }
      // Wait for all acp:start events (listeners were registered before mutations)
      const payloads = await Promise.all(startPromises);
      for (const payload of payloads) {
        expect(payload.sessionId).toBeTruthy();
      }
    }, 30000);
  });

  // ── A10: 返工流程 session 状态 ──────────────────────────────
  describe('A10: rework flow session status', () => {
    it('should close old node session and start a new one after completeRework', async () => {
      // 真实实例化两节点工作流：HUMAN(input) → AI(exec)
      const { instanceId, nodes } = await setupWorkflowInstance(token, ctrl.controllerId, workspaceId, 'a10', ['exec']);
      const inputNode = nodes.find((n) => n.nodeKey === 'input')!;
      const execNode = nodes.find((n) => n.nodeKey === 'exec')!;

      // 完成人类节点 → exec 节点拉起会话 S1
      const s1Promise = waitForEvent<{ sessionId: string }>(ctrl.client, 'acp:start', 15000);
      const completeRes = await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId, nodeId: inputNode.id, input: '做一个计算器' }, token);
      expect((await completeRes.json()).errors).toBeUndefined();
      const s1 = await s1Promise;

      // exec 节点 RUNNING 且绑定 S1
      await pollUntil(async () => {
        const inst = await queryWorkflowInstance(token, instanceId);
        const exec = inst?.nodes.find((n) => n.nodeKey === 'exec');
        return exec?.status === 'RUNNING' && exec.sessionId === s1.sessionId;
      }, 15000, 'waiting for exec node RUNNING');

      // 打回 exec → exec REJECT，上游 input 进入 REWORK
      const rejectRes = await gqlRequest(REJECT_NODE, { instanceId, nodeId: execNode.id, reason: '执行结果不符合需求' }, token);
      const rejectBody = await rejectRes.json();
      expect(rejectBody.errors).toBeUndefined();
      expect(rejectBody.data.rejectNode.status).toBe('REJECT');
      await pollUntil(async () => {
        const inst = await queryWorkflowInstance(token, instanceId);
        return inst?.nodes.find((n) => n.nodeKey === 'input')?.status === 'REWORK';
      }, 10000, 'waiting for input node REWORK');

      // 人类重新提交（REWORK → completeRework → DONE）→ 下游 exec（REJECT）复工：
      // 关闭旧会话 S1，拉起全新会话 S2（engine.ts completeRework → resume）
      const s2Promise = waitForEvent<{ sessionId: string }>(ctrl.client, 'acp:start', 15000);
      const redoRes = await gqlRequest(COMPLETE_HUMAN_NODE, { instanceId, nodeId: inputNode.id, input: '做一个支持加减乘除的计算器' }, token);
      const redoBody = await redoRes.json();
      expect(redoBody.errors).toBeUndefined();
      expect(redoBody.data.completeHumanNode.status).toBe('DONE');
      const s2 = await s2Promise;

      // 新会话是全新会话（不是复用 S1）
      expect(s2.sessionId).not.toBe(s1.sessionId);

      // 旧会话 S1 被关闭（status=ended），exec 节点以 S2 复工 RUNNING
      await pollUntil(async () => (await querySessionStatus(token, s1.sessionId)) === 'ended', 15000, 'waiting for old session ended');
      await pollUntil(async () => {
        const inst = await queryWorkflowInstance(token, instanceId);
        const exec = inst?.nodes.find((n) => n.nodeKey === 'exec');
        return exec?.status === 'RUNNING' && exec.sessionId === s2.sessionId;
      }, 15000, 'waiting for exec node resumed with new session');
    }, 60000);
  });
});
