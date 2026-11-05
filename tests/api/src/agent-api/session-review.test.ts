import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';
import { createFrontUser } from '../support/front-users.js';

/**
 * T-API-SR1~5：会话内建 Review 生命周期（#461）。
 *
 * MCP tools/call 直调 `agent-session-preview-tools.review` 创建 → `sessionReviews`
 * 可见（PENDING）→ `submitSessionReview` → 结果 JSON 含 file_reviews/comment/status；
 * 会话关闭 → PENDING 批量 CANCELLED；`homeOverview.sessionReviews` 聚合。
 */

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
    createControllerKey(input: $input) { key { id name } rawKey }
  }
`;

const CREATE_WORKSPACE = `
  mutation CreateWorkspace($input: CreateWorkspaceInput!) {
    createWorkspace(input: $input) { id controllerId path }
  }
`;

const CREATE_SESSION = `
  mutation CreateSession($input: CreateSessionInput!) {
    createSession(input: $input) { session { id status } }
  }
`;

const SESSION_REVIEWS = `
  query SessionReviews($status: SessionReviewStatus, $sessionId: ID) {
    sessionReviews(status: $status, sessionId: $sessionId) {
      id sessionId files status fileReviews comment cancelReason createdAt resolvedAt
    }
  }
`;

const SUBMIT_REVIEW = `
  mutation SubmitSessionReview($id: ID!, $input: SubmitSessionReviewInput!) {
    submitSessionReview(id: $id, input: $input) {
      id status fileReviews comment resolvedAt
    }
  }
`;

const HOME_SESSION_REVIEWS = `
  query HomeSessionReviews {
    homeOverview { sessionReviews { id status } }
  }
`;

async function newUserToken(prefix: string): Promise<string> {
  return createFrontUser(`${prefix}-${Date.now()}`);
}

/** 模拟 agent-controller 经 relay 调用平台 preview MCP 工具（review 会同步长等待，独立超时） */
async function callPreviewTool(
  socket: ClientSocket,
  sessionId: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
  timeoutMs = 8000,
): Promise<{ httpStatus: number; body: Record<string, any> }> {
  const requestId = `mcpreq_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP relay timeout for ${name}`)), timeoutMs);
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
      serverName: 'agent-session-preview-tools',
      token,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    });
  });
}

function parseToolResult(body: Record<string, any>): { isError: boolean; data: Record<string, any> } {
  const result = body.result;
  expect(result?.content?.[0]?.text).toBeDefined();
  return { isError: Boolean(result.isError), data: JSON.parse(result.content[0].text) };
}

describe('Session Review API (T-API-SR1~5)', () => {
  let token = '';
  let keyId = '';
  let sessionId = '';
  let socket: ClientSocket;

  beforeAll(async () => {
    token = await newUserToken('review');
    const keyRes = await gqlRequest(
      CREATE_KEY,
      { input: { name: `review-key-${Date.now()}`, type: 'local' } },
      token,
    );
    const keyJson = await keyRes.json();
    keyId = keyJson.data.createControllerKey.key.id;

    // 工作区与会话（cwd 落 /tmp 便于文件路径解析）
    const wsRes = await gqlRequest(
      CREATE_WORKSPACE,
      { input: { controllerId: keyId, name: `review-ws-${Date.now()}`, path: `/tmp/review-ws-${Date.now()}` } },
      token,
    );
    const wsJson = await wsRes.json();
    const sessionRes = await gqlRequest(
      CREATE_SESSION,
      {
        input: {
          controllerId: keyId,
          workspaceId: wsJson.data.createWorkspace.id,
          acpServerType: 'opencode',
          mcpServerIds: [],
        },
      },
      token,
    );
    const sessionJson = await sessionRes.json();
    sessionId = sessionJson.data.createSession.session.id;

    // 假 controller WebSocket（mcp relay 通道）
    socket = SocketIOClient(CONTROLLER_API_URL, {
      transports: ['websocket'],
      auth: { token: `test-controller-key-${Date.now()}` },
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket connect timeout')), 8000);
      socket.on('connect', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      socket.on('connect_error', reject);
    });
  }, 60000);

  afterAll(() => {
    socket?.close();
  });

  it('T-API-SR1 review 创建（MCP tools/call）→ sessionReviews 可见 PENDING', async () => {
    const pending = callPreviewTool(
      socket,
      sessionId,
      token,
      'review',
      { files: ['src/a.ts', 'README.md'], summary: '请评审' },
      2000,
    ).catch(() => null); // review 同步长等待：本用例只验证创建，不等结果

    // 等待 PENDING 文档出现
    let list: Array<Record<string, any>> = [];
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const res = await gqlRequest(SESSION_REVIEWS, { status: 'PENDING', sessionId }, token);
      const json = await res.json();
      list = json.data.sessionReviews;
      if (list.length > 0) break;
    }
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].status).toBe('PENDING');
    expect(list[0].files).toEqual(['src/a.ts', 'README.md']);
    await pending;
  }, 30000);

  it('T-API-SR2 submitSessionReview：PENDING→APPROVED，写 fileReviews/comment', async () => {
    const res = await gqlRequest(SESSION_REVIEWS, { status: 'PENDING', sessionId }, token);
    const list = (await res.json()).data.sessionReviews as Array<Record<string, any>>;
    expect(list.length).toBeGreaterThan(0);

    const submitRes = await gqlRequest(
      SUBMIT_REVIEW,
      {
        id: list[0].id,
        input: {
          fileReviews: { 'src/a.ts': [{ id: 'c1', anchor: { kind: 'code', filePath: 'src/a.ts', startLine: 1, endLine: 1 }, body: 'fix', createdAt: '2026-11-05T00:00:00Z' }] },
          comment: '整体 OK',
          status: 'approve',
        },
      },
      token,
    );
    const submitJson = await submitRes.json();
    expect(submitJson.data.submitSessionReview.status).toBe('APPROVED');
    expect(submitJson.data.submitSessionReview.comment).toBe('整体 OK');
    expect(submitJson.data.submitSessionReview.resolvedAt).toBeTruthy();
  });

  it('T-API-SR3 重复提交抛 Review not found or already resolved', async () => {
    const res = await gqlRequest(SESSION_REVIEWS, { status: 'APPROVED', sessionId }, token);
    const list = (await res.json()).data.sessionReviews as Array<Record<string, any>>;
    const submitRes = await gqlRequest(
      SUBMIT_REVIEW,
      { id: list[0].id, input: { fileReviews: {}, status: 'comment' } },
      token,
    );
    const submitJson = await submitRes.json();
    expect(submitJson.errors?.[0]?.message).toContain('Review not found or already resolved');
  });

  it('T-API-SR4 review 回包结构：{file_reviews, comment, status}', async () => {
    // 创建新 review 并在 submit 后校验 tools/call 终态回包
    const callPromise = callPreviewTool(
      socket,
      sessionId,
      token,
      'review',
      { files: ['src/b.ts'] },
      8000,
    );
    let reviewId = '';
    for (let i = 0; i < 20 && !reviewId; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const res = await gqlRequest(SESSION_REVIEWS, { status: 'PENDING', sessionId }, token);
      const list = (await res.json()).data.sessionReviews as Array<Record<string, any>>;
      if (list.length > 0) reviewId = list[0].id;
    }
    expect(reviewId).toBeTruthy();

    await gqlRequest(
      SUBMIT_REVIEW,
      { id: reviewId, input: { fileReviews: { 'src/b.ts': [] }, comment: 'lgtm', status: 'reject' } },
      token,
    );

    const { body } = await callPromise;
    const { data } = parseToolResult(body);
    expect(data.status).toBe('Reject');
    expect(data.comment).toBe('lgtm');
    expect(data.file_reviews).toEqual({ 'src/b.ts': [] });
  }, 30000);

  it('T-API-SR6 close 会话 → PENDING 批量 CANCELLED(session_closed)', async () => {
    // 新建一个 review 后关闭会话
    const callPromise = callPreviewTool(socket, sessionId, token, 'review', { files: ['src/c.ts'] }, 8000).catch(() => null);
    let reviewId = '';
    for (let i = 0; i < 20 && !reviewId; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const res = await gqlRequest(SESSION_REVIEWS, { status: 'PENDING', sessionId }, token);
      const list = (await res.json()).data.sessionReviews as Array<Record<string, any>>;
      if (list.length > 0) reviewId = list[0].id;
    }
    expect(reviewId).toBeTruthy();

    const closeRes = await gqlRequest(
      'mutation Close($id: ID!) { closeSession(id: $id) }',
      { id: sessionId },
      token,
    );
    expect((await closeRes.json()).errors).toBeUndefined();

    // PENDING → CANCELLED(session_closed)
    let cancelled: Record<string, any> | null = null;
    for (let i = 0; i < 20 && !cancelled; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const res = await gqlRequest(
        'query R($id: ID!) { sessionReview(id: $id) { id status cancelReason } }',
        { id: reviewId },
        token,
      );
      const row = (await res.json()).data.sessionReview;
      if (row && row.status !== 'PENDING') cancelled = row;
    }
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'session_closed' });
    await callPromise;
  }, 40000);

  it('T-API-SR5 homeOverview.sessionReviews 聚合（PENDING 在前）', async () => {
    const res = await gqlRequest(HOME_SESSION_REVIEWS, undefined, token);
    const json = await res.json();
    const reviews = json.data.homeOverview.sessionReviews as Array<Record<string, any>>;
    expect(Array.isArray(reviews)).toBe(true);
    if (reviews.length >= 2) {
      const firstPendingIndex = reviews.findIndex((review) => review.status === 'PENDING');
      const firstResolvedIndex = reviews.findIndex((review) => review.status !== 'PENDING');
      if (firstPendingIndex >= 0 && firstResolvedIndex >= 0) {
        expect(firstPendingIndex).toBeLessThan(firstResolvedIndex);
      }
    }
  });
});
