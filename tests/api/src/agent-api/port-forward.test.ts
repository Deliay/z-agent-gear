import { describe, it, expect, beforeAll } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';

const API_URL = process.env.API_URL || 'http://localhost:4000/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

function gqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
}

function createWSClient(): ClientSocket {
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

const PORT_FORWARDS_QUERY = `
  query PortForwards($controllerId: ID!) {
    portForwards(controllerId: $controllerId) {
      portForwards {
        id
        controllerId
        port
        status
        createdAt
      }
      total
      limit
    }
  }
`;

const CREATE_PORT_FORWARD = `
  mutation CreatePortForward($controllerId: ID!, $port: Int!) {
    createPortForward(controllerId: $controllerId, port: $port) {
      id
      controllerId
      port
      status
      createdAt
    }
  }
`;

const DELETE_PORT_FORWARD = `
  mutation DeletePortForward($controllerId: ID!, $port: Int!) {
    deletePortForward(controllerId: $controllerId, port: $port)
  }
`;

async function registerController(nameSuffix: string): Promise<{ client: ClientSocket; controllerId: string }> {
  const keyRes = await gqlRequest(
    CREATE_KEY,
    { input: { name: `pf-${nameSuffix}-${Date.now()}`, type: 'local' } },
    authToken,
  );
  const keyBody = await keyRes.json();
  const rawKey = keyBody.data.createControllerKey.rawKey;

  const client = createWSClient();
  const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
  client.emit('register', { key: rawKey, hostname: `pf-host-${nameSuffix}`, version: '1.0.0' });
  const regData = await registered;

  await new Promise((r) => setTimeout(r, 200));

  return { client, controllerId: regData.controllerId };
}

describe('Port Forward API', () => {
  beforeAll(async () => {
    const uid = `pf_${Date.now()}`;
    const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
    const body = await res.json();
    authToken = body.data?.signup?.token ?? '';
    expect(authToken).toBeTruthy();
  });

  describe('queries without auth', () => {
    it('should reject portForwards query without token', async () => {
      const res = await gqlRequest(PORT_FORWARDS_QUERY, { controllerId: '000000000000000000000000' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });
  });

  describe('mutations without auth', () => {
    it('should reject createPortForward without auth', async () => {
      const res = await gqlRequest(CREATE_PORT_FORWARD, { controllerId: '000000000000000000000000', port: 3000 });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject deletePortForward without auth', async () => {
      const res = await gqlRequest(DELETE_PORT_FORWARD, { controllerId: '000000000000000000000000', port: 3000 });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });
  });

  describe('createPortForward', () => {
    it('should reject for non-existent controller', async () => {
      const res = await gqlRequest(
        CREATE_PORT_FORWARD,
        { controllerId: '000000000000000000000000', port: 3000 },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Controller not found');
    });

    it('should reject for offline controller', async () => {
      const { client, controllerId } = await registerController('offline');
      client.disconnect();
      await new Promise((r) => setTimeout(r, 500));

      const res = await gqlRequest(
        CREATE_PORT_FORWARD,
        { controllerId, port: 3001 },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Controller is not online');
    });

    it('should create a port forward successfully', async () => {
      const { client, controllerId } = await registerController('create');

      const res = await gqlRequest(
        CREATE_PORT_FORWARD,
        { controllerId, port: 3002 },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.createPortForward).toBeDefined();
      expect(body.data.createPortForward.port).toBe(3002);
      expect(body.data.createPortForward.status).toBe('active');
      expect(body.data.createPortForward.controllerId).toBe(controllerId);
      expect(body.data.createPortForward.id).toBeDefined();
      expect(body.data.createPortForward.createdAt).toBeDefined();

      client.disconnect();
    });

    it('should reject duplicate port forwarding', async () => {
      const { client, controllerId } = await registerController('dup');

      const res1 = await gqlRequest(
        CREATE_PORT_FORWARD,
        { controllerId, port: 3003 },
        authToken,
      );
      const body1 = await res1.json();
      expect(body1.errors).toBeUndefined();

      const res2 = await gqlRequest(
        CREATE_PORT_FORWARD,
        { controllerId, port: 3003 },
        authToken,
      );
      const body2 = await res2.json();
      expect(body2.errors).toBeDefined();
      expect(body2.errors[0].message).toBe('Port already forwarded');

      client.disconnect();
    });
  });

  describe('portForwards query with auth', () => {
    it('should return port forwards list', async () => {
      const { client, controllerId } = await registerController('list');

      await gqlRequest(CREATE_PORT_FORWARD, { controllerId, port: 3004 }, authToken);

      const res = await gqlRequest(PORT_FORWARDS_QUERY, { controllerId }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.portForwards.portForwards).toBeDefined();
      expect(body.data.portForwards.portForwards.length).toBeGreaterThan(0);
      expect(body.data.portForwards.total).toBeGreaterThan(0);
      expect(body.data.portForwards.limit).toBeDefined();

      const pf = body.data.portForwards.portForwards.find((p: { port: number }) => p.port === 3004);
      expect(pf).toBeDefined();
      expect(pf.controllerId).toBe(controllerId);
      expect(pf.status).toBe('active');

      client.disconnect();
    });
  });

  describe('deletePortForward', () => {
    it('should delete a port forward successfully', async () => {
      const { client, controllerId } = await registerController('delete');

      await gqlRequest(CREATE_PORT_FORWARD, { controllerId, port: 4000 }, authToken);

      const res = await gqlRequest(DELETE_PORT_FORWARD, { controllerId, port: 4000 }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.deletePortForward).toBe(true);

      const listRes = await gqlRequest(PORT_FORWARDS_QUERY, { controllerId }, authToken);
      const listBody = await listRes.json();
      const deleted = listBody.data.portForwards.portForwards.find((pf: { port: number }) => pf.port === 4000);
      expect(deleted).toBeUndefined();

      client.disconnect();
    });

    it('should return false when deleting non-existent port forward', async () => {
      const { client, controllerId } = await registerController('delete-miss');

      const res = await gqlRequest(DELETE_PORT_FORWARD, { controllerId, port: 9999 }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.deletePortForward).toBe(false);

      client.disconnect();
    });
  });
});
