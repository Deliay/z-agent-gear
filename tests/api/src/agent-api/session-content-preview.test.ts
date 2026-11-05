import { describe, it, expect, beforeAll } from 'vitest';
import { createFrontUser } from '../support/front-users.js';

/**
 * T-API-PARTS1~3（sendSessionMessage parts 全链）与 T-API-FC1~3（sessionFileContent 契约）。
 */

const AGENT_API_URL = process.env.API_URL || 'http://localhost:10001/graphql';

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

const SEND_MESSAGE = `
  mutation SendSessionMessage($sessionId: ID!, $content: String!, $type: AcpMessageType, $parts: [PromptPartInput!]) {
    sendSessionMessage(sessionId: $sessionId, content: $content, type: $type, parts: $parts) {
      id content metadata
    }
  }
`;

const SESSION_MESSAGES = `
  query SessionMessages($sessionId: ID!) {
    sessionMessages(sessionId: $sessionId) { id content metadata }
  }
`;

const FILE_CONTENT = `
  query SessionFileContent($sessionId: ID!, $path: String!) {
    sessionFileContent(sessionId: $sessionId, path: $path) { path content truncated sizeBytes }
  }
`;

describe('Session content preview API (T-API-PARTS1~3, T-API-FC1~3)', () => {
  let token = '';
  let sessionId = '';

  beforeAll(async () => {
    token = await createFrontUser(`parts-${Date.now()}`);
    const keyRes = await gqlRequest(CREATE_KEY, { input: { name: `parts-key-${Date.now()}`, type: 'local' } }, token);
    const keyJson = await keyRes.json();
    const controllerId = keyJson.data.createControllerKey.key.id;
    const wsRes = await gqlRequest(
      CREATE_WORKSPACE,
      { input: { controllerId, name: `parts-ws-${Date.now()}`, path: `/tmp/parts-ws-${Date.now()}` } },
      token,
    );
    const wsJson = await wsRes.json();
    const sessionRes = await gqlRequest(
      CREATE_SESSION,
      { input: { controllerId, workspaceId: wsJson.data.createWorkspace.id, acpServerType: 'opencode', mcpServerIds: [] } },
      token,
    );
    const sessionJson = await sessionRes.json();
    sessionId = sessionJson.data.createSession.session.id;
  }, 60000);

  it('T-API-PARTS1 parts 过滤：trim 空文本被滤；全空拒绝 empty prompt', async () => {
    const emptyRes = await gqlRequest(
      SEND_MESSAGE,
      { sessionId, content: '', type: 'text', parts: [{ type: 'text', text: '   ' }] },
      token,
    );
    const emptyJson = await emptyRes.json();
    expect(emptyJson.errors?.[0]?.message).toContain('empty prompt');

    const okRes = await gqlRequest(
      SEND_MESSAGE,
      {
        sessionId,
        content: '',
        type: 'text',
        parts: [
          { type: 'text', text: '  a  ' },
          { type: 'text', text: '' },
          { type: 'text', text: 'b' },
        ],
      },
      token,
    );
    const okJson = await okRes.json();
    expect(okJson.errors).toBeUndefined();
  });

  it('T-API-PARTS2 持久化：content=合并文本(\\n\\n)；metadata.parts 全量含图片', async () => {
    const res = await gqlRequest(
      SEND_MESSAGE,
      {
        sessionId,
        content: 'ignored',
        type: 'text',
        parts: [
          { type: 'text', text: 'hello' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png', name: 'shot.png' },
          { type: 'text', text: 'world' },
        ],
      },
      token,
    );
    const json = await res.json();
    expect(json.errors).toBeUndefined();
    const message = json.data.sendSessionMessage;
    expect(message.content).toEqual({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'hello\n\nworld' },
    });
    const metadata = JSON.parse(message.metadata);
    expect(metadata.parts).toHaveLength(3);
    expect(metadata.parts[1]).toMatchObject({ type: 'image', mimeType: 'image/png', name: 'shot.png' });
  });

  it('T-API-PARTS3 历史可回看：sessionMessages 携带 metadata.parts', async () => {
    const res = await gqlRequest(SESSION_MESSAGES, { sessionId }, token);
    const json = await res.json();
    const messages = json.data.sessionMessages as Array<Record<string, any>>;
    const withParts = messages.find((message) => message.metadata && JSON.parse(message.metadata).parts);
    expect(withParts).toBeTruthy();
    expect(JSON.parse(withParts!.metadata).parts.length).toBeGreaterThan(0);
  });

  it('T-API-FC1 sessionFileContent 越界路径 400（BAD_USER_INPUT）', async () => {
    const res = await gqlRequest(FILE_CONTENT, { sessionId, path: '../../etc/passwd' }, token);
    const json = await res.json();
    expect(json.errors?.[0]?.message).toBeTruthy();
  });

  it('T-API-FC2 非归属会话 Session not found', async () => {
    const otherToken = await createFrontUser(`parts-other-${Date.now()}`);
    const res = await gqlRequest(FILE_CONTENT, { sessionId, path: 'src/a.ts' }, otherToken);
    const json = await res.json();
    expect(json.errors?.[0]?.message).toContain('Session not found');
  });

  it('T-API-FC3 控制器离线超时文案', async () => {
    // 无在线 controller：轮询超时后返回统一文案
    const res = await gqlRequest(FILE_CONTENT, { sessionId, path: 'src/a.ts' }, token);
    const json = await res.json();
    expect(json.errors?.[0]?.message).toBe('Controller offline or file read timeout');
  }, 30000);
});
