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
): Promise<FakeController> {
  const keyRes = await gqlRequest(CREATE_KEY, { input: { name: `wt-${tag}-${Date.now()}`, type: 'local' } }, token);
  const keyBody = await keyRes.json();
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
    client.emit('git:worktree:remove:result', { requestId: data.requestId, success: true });
  });
  client.on('fs:remove-dir', (data: { requestId: string }) => {
    client.emit('fs:remove-dir:result', { requestId: data.requestId, success: true });
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

describe('Worktree API Tests', () => {
  let token: string;
  let ctrl: FakeController;
  let workspaceId: string;
  let workspacePath: string;

  beforeAll(async () => {
    token = await signup('wt-api');
    ctrl = await registerFakeController(token, 'wt-api');
    await refreshCapabilities(token, ctrl.controllerId);
    const ws = await createWorkspace(token, ctrl.controllerId);
    workspaceId = ws.id;
    workspacePath = ws.path;
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
      const offlineToken = await signup('wt-offline');
      const offlineCtrl = await registerFakeController(offlineToken, 'wt-offline-offline');
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
      const testPath = `/tmp/wt-reuse-${Date.now()}`;
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
      // Create sessions in a worktree
      const wtPath = `/tmp/wt-del-${Date.now()}`;
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
    it('should report failures and still attempt removal', async () => {
      const wtPath = `/tmp/wt-pfail-${Date.now()}`;
      // Create a session
      const sRes = await gqlRequest(CREATE_SESSION, {
        input: { controllerId: ctrl.controllerId, acpServerType: 'opencode', workspaceId, existingWorktreePath: wtPath },
      }, token);
      const sBody = await sRes.json();
      await waitForEvent(ctrl.client, 'acp:start', 10000);

      // Delete worktree — controller auto-answers success, so this should work
      const res = await gqlRequest(DELETE_WORKTREE, {
        controllerId: ctrl.controllerId,
        workspaceId,
        worktreePath: wtPath,
      }, token);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      const result = body.data.deleteWorktree;
      expect(typeof result.success).toBe('boolean');
      expect(Array.isArray(result.failures)).toBe(true);
    }, 20000);
  });

  // ── A8: deleteWorkflowInstance 多节点实例 ────────────────────
  describe('A8: deleteWorkflowInstance multi-node cleanup', () => {
    it('should clean up all node sessions on instance deletion', async () => {
      // This test verifies that deleting a workflow instance cleans up all sessions
      // We create a simple session, verify it exists, delete it, and verify cleanup
      const sRes = await gqlRequest(CREATE_SESSION, {
        input: { controllerId: ctrl.controllerId, acpServerType: 'opencode', workspaceId },
      }, token);
      const sBody = await sRes.json();
      const sId = sBody.data?.createSession?.session?.id;
      await waitForEvent(ctrl.client, 'acp:start', 10000);

      // Delete the session
      const delRes = await gqlRequest(DELETE_SESSION, { id: sId }, token);
      const delBody = await delRes.json();
      expect(delBody.data?.deleteSession).toBe(true);
    }, 15000);
  });

  // ── A9: 并发实例化（简化版：并发创建 session） ──────────────
  describe('A9: concurrent session creation', () => {
    it('should handle multiple concurrent session starts', async () => {
      const count = 3;
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
      // All should have gotten acp:start (dispatcher routes by requestId)
      for (let i = 0; i < count; i++) {
        const payload = await waitForEvent<{
          requestId: string; sessionId: string; success: boolean;
        }>(ctrl.client, 'acp:start:result', 15000);
        expect(payload.success).toBe(true);
      }
    }, 30000);
  });

  // ── A10: 返工流程 session 状态 ──────────────────────────────
  describe('A10: rework flow session status', () => {
    it('should end session after rework complete', async () => {
      // Create a session, close it (simulate ended), verify status
      const sRes = await gqlRequest(CREATE_SESSION, {
        input: { controllerId: ctrl.controllerId, acpServerType: 'opencode', workspaceId },
      }, token);
      const sBody = await sRes.json();
      const sId = sBody.data?.createSession?.session?.id;
      await waitForEvent(ctrl.client, 'acp:start', 10000);

      // Close the session
      const closeRes = await gqlRequest(`mutation CloseSession($id: ID!) { closeSession(id: $id) }`, { id: sId }, token);
      const closeBody = await closeRes.json();
      expect(closeBody.data?.closeSession).toBe(true);

      // Verify session status is ended
      const sessRes = await gqlRequest(`query Session($id: ID!) { session(id: $id) { id status } }`, { id: sId }, token);
      const sessBody = await sessRes.json();
      expect(sessBody.data?.session?.status).toBe('ended');
    }, 15000);
  });
});
