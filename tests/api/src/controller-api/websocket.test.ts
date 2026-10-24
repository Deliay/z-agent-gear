import { describe, it, expect, beforeAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';

const AGENT_API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273';

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
      key { id name type keyPrefix status createdAt updatedAt }
      rawKey
    }
  }
`;

const REVOKE_KEY = `
  mutation RevokeControllerKey($id: ID!) {
    revokeControllerKey(id: $id)
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

async function createKey(name: string): Promise<{ rawKey: string; keyId: string }> {
  const res = await gqlRequest(
    CREATE_KEY,
    { input: { name, type: 'local' } },
    authToken,
  );
  const body = await res.json();
  return {
    rawKey: body.data.createControllerKey.rawKey,
    keyId: body.data.createControllerKey.key.id,
  };
}

async function revokeKey(keyId: string): Promise<void> {
  await gqlRequest(REVOKE_KEY, { id: keyId }, authToken);
}

describe('Controller API WebSocket', () => {
  beforeAll(async () => {
    const uid = `wt${Date.now().toString(36)}`;
    const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
    const body = await res.json();
    authToken = body.data?.signup?.token ?? '';
    expect(authToken).toBeTruthy();
  });

  describe('register', () => {
    it('should register with valid key and return controllerId', async () => {
      const { rawKey } = await createKey(`ws_v_${Date.now()}`);
      const client = createClient();

      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: rawKey, hostname: 'test-host', version: '2.0.0' });

      const data = await registered;
      expect(data.controllerId).toBeDefined();
      expect(typeof data.controllerId).toBe('string');

      client.disconnect();
    });

    it('should reject register with invalid key', async () => {
      const client = createClient();

      const error = waitForEvent<{ code: string; message: string }>(client, 'error');
      client.emit('register', { key: 'zag_k_1_nonexistent', hostname: 'test-host', version: '2.0.0' });

      const err = await error;
      expect(err.code).toBe('INVALID_KEY');
    });

    it('should reject register with version mismatch', async () => {
      const { rawKey } = await createKey(`ws_ver_${Date.now()}`);
      const client = createClient();

      const error = waitForEvent<{ code: string; message: string }>(client, 'error');
      client.emit('register', { key: rawKey, hostname: 'test-host', version: '99.0.0' });

      const err = await error;
      expect(err.code).toBe('VERSION_MISMATCH');

      client.disconnect();
    });
  });

  describe('heartbeat', () => {
    it('should accept heartbeat from authenticated client', async () => {
      const { rawKey } = await createKey(`ws_hb_${Date.now()}`);
      const client = createClient();

      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: rawKey, hostname: 'test-host', version: '2.0.0' });
      await registered;

      client.emit('heartbeat');

      await new Promise((r) => setTimeout(r, 200));
      expect(client.connected).toBe(true);

      client.disconnect();
    });
  });

  describe('unregister', () => {
    it('should unregister and disconnect', async () => {
      const { rawKey } = await createKey(`ws_unreg_${Date.now()}`);
      const client = createClient();

      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: rawKey, hostname: 'test-host', version: '2.0.0' });
      await registered;

      const unregistered = waitForEvent(client, 'unregistered');
      client.emit('unregister', { reason: 'user_detach' });
      await unregistered;

      await new Promise((r) => setTimeout(r, 300));
      expect(client.connected).toBe(false);
    });
  });

  describe('session exclusivity', () => {
    it('should reject second connection with same key', async () => {
      const { rawKey } = await createKey(`ws_excl_${Date.now()}`);

      const client1 = createClient();
      const registered1 = waitForEvent<{ controllerId: string }>(client1, 'registered');
      client1.emit('register', { key: rawKey, hostname: 'host-1', version: '2.0.0' });
      await registered1;

      const client2 = createClient();
      const error2 = waitForEvent<{ code: string }>(client2, 'error');
      client2.emit('register', { key: rawKey, hostname: 'host-2', version: '2.0.0' });

      const err = await error2;
      expect(err.code).toBe('KEY_ALREADY_ONLINE');

      client1.disconnect();
      client2.disconnect();
    });
  });
});
