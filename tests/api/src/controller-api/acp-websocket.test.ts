import { describe, it, expect, beforeAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';

const AGENT_API_URL = process.env.API_URL || 'http://localhost:4000/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

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

const CREATE_SESSION = `
  mutation CreateSession($input: CreateSessionInput!) {
    createSession(input: $input) {
      session { id status }
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

function waitForEvent<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

let authToken = '';
let rawKey = '';
let controllerId = '';

describe('Controller API ACP WebSocket', () => {
  beforeAll(async () => {
    const uid = `acp_${Date.now().toString(36)}`;
    const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
    const body = await res.json();
    authToken = body.data?.signup?.token ?? '';
    expect(authToken).toBeTruthy();

    const keyRes = await gqlRequest(
      CREATE_KEY,
      { input: { name: `acp-key-${Date.now()}`, type: 'local' } },
      authToken,
    );
    const keyBody = await keyRes.json();
    rawKey = keyBody.data.createControllerKey.rawKey;

    const client = createClient();
    const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
    client.emit('register', { key: rawKey, hostname: 'acp-test-host', version: '1.0.0' });
    const regData = await registered;
    controllerId = regData.controllerId;
    client.disconnect();

    await new Promise((r) => setTimeout(r, 300));
  });

  describe('acp:check', () => {
    it('should request ACP capability check', async () => {
      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: rawKey, hostname: 'acp-test-host', version: '1.0.0' });
      await registered;

      const checkResult = waitForEvent<{
        requestId: string;
        servers: Array<{ type: string; available: boolean; version?: string }>;
      }>(client, 'acp:check');

      client.emit('acp:check', { requestId: 'check-req-1' });

      const result = await checkResult;
      expect(result.requestId).toBe('check-req-1');
      expect(Array.isArray(result.servers)).toBe(true);

      client.disconnect();
    });
  });

  describe('acp:start', () => {
    it('should handle ACP start request', async () => {
      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: rawKey, hostname: 'acp-test-host', version: '1.0.0' });
      await registered;

      const sessionRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode' } },
        authToken,
      );
      const sessionBody = await sessionRes.json();
      const sessionId = sessionBody.data.createSession.session.id;

      const startEvent = waitForEvent<{
        requestId: string;
        sessionId: string;
        serverType: string;
        cwd: string;
      }>(client, 'acp:start');

      // The createSession mutation triggers acp:start on the controller
      // But since we can't control the timing, we test the event directly

      // Respond to the start event
      const result = await startEvent;
      expect(result.sessionId).toBe(sessionId);
      expect(result.serverType).toBe('opencode');
      expect(result.requestId).toBeDefined();

      // Simulate successful start response (mock - do NOT actually spawn opencode)
      client.emit('acp:start:result', {
        requestId: result.requestId,
        sessionId,
        success: true,
        externalSessionId: `ext_${Date.now()}`,
      });

      await new Promise((r) => setTimeout(r, 300));

      client.disconnect();
    });
  });

  describe('acp:message', () => {
    it('should handle message forwarding', async () => {
      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: rawKey, hostname: 'acp-test-host', version: '1.0.0' });
      await registered;

      const startEvent = waitForEvent<{ requestId: string; sessionId: string }>(client, 'acp:start');

      const sessionRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode' } },
        authToken,
      );
      const sessionBody = await sessionRes.json();
      const sessionId = sessionBody.data.createSession.session.id;

      const startData = await startEvent;

      // Simulate successful start
      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
      });

      await new Promise((r) => setTimeout(r, 300));

      // Simulate controller sending output message
      const msgEvent = waitForEvent<{ sessionId: string; message: { type: string; content: string } }>(client, 'acp:message');
      client.emit('acp:message', {
        sessionId,
        message: { type: 'text', content: 'Hello from controller' },
      });

      const msg = await msgEvent;
      expect(msg.sessionId).toBe(sessionId);
      expect(msg.message.type).toBe('text');
      expect(msg.message.content).toBe('Hello from controller');

      client.disconnect();
    });
  });

  describe('acp:stop', () => {
    it('should handle stop request', async () => {
      const client = createClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: rawKey, hostname: 'acp-test-host', version: '1.0.0' });
      await registered;

      const sessionRes = await gqlRequest(
        CREATE_SESSION,
        { input: { controllerId, acpServerType: 'opencode' } },
        authToken,
      );
      const sessionBody = await sessionRes.json();
      const sessionId = sessionBody.data.createSession.session.id;

      const startEvent = waitForEvent<{ requestId: string; sessionId: string }>(client, 'acp:start');
      const startData = await startEvent;

      client.emit('acp:start:result', {
        requestId: startData.requestId,
        sessionId,
        success: true,
      });

      await new Promise((r) => setTimeout(r, 300));

      // Simulate controller sending stopped event
      const stoppedEvent = waitForEvent<{ sessionId: string; reason: string }>(client, 'acp:stopped');
      client.emit('acp:stopped', {
        sessionId,
        reason: 'agent_exit',
      });

      const stopped = await stoppedEvent;
      expect(stopped.sessionId).toBe(sessionId);
      expect(stopped.reason).toBe('agent_exit');

      client.disconnect();
    });
  });
});
