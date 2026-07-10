import { describe, it, expect, beforeAll, vi } from 'vitest';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';

const API_URL = process.env.API_URL || 'http://localhost:4000/graphql';
const API_BASE = process.env.API_URL ? process.env.API_URL.replace('/graphql', '') : 'http://localhost:4000';
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

const GATEWAYS_QUERY = `
  query Gateways($controllerId: ID!) {
    gateways(controllerId: $controllerId) {
      gateways {
        id
        controllerId
        name
        port
        status
        createdAt
      }
      total
      limit
    }
  }
`;

const CREATE_GATEWAY = `
  mutation CreateGateway($controllerId: ID!, $name: String!, $port: Int!) {
    createGateway(controllerId: $controllerId, name: $name, port: $port) {
      id
      controllerId
      name
      port
      status
      createdAt
    }
  }
`;

const DELETE_GATEWAY = `
  mutation DeleteGateway($controllerId: ID!, $name: String!) {
    deleteGateway(controllerId: $controllerId, name: $name)
  }
`;

async function waitForControllerOnline(controllerId: string, token: string, timeoutMs = 5000): Promise<void> {
  const CONTROLLER_QUERY = `query Controller($id: ID!) { controller(id: $id) { status } }`;
  await vi.waitFor(async () => {
    const res = await gqlRequest(CONTROLLER_QUERY, { id: controllerId }, token);
    const body = await res.json();
    expect(body.data?.controller?.status).toBe('online');
  }, { timeout: timeoutMs, interval: 200 });
}

async function registerController(nameSuffix: string): Promise<{ client: ClientSocket; controllerId: string }> {
  const keyRes = await gqlRequest(
    CREATE_KEY,
    { input: { name: `gw-${nameSuffix}-${Date.now()}`, type: 'local' } },
    authToken,
  );
  const keyBody = await keyRes.json();
  const rawKey = keyBody.data.createControllerKey.rawKey;

  const client = createWSClient();
  const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
  client.emit('register', { key: rawKey, hostname: `gw-host-${nameSuffix}`, version: '1.0.0' });
  const regData = await registered;

  await waitForControllerOnline(regData.controllerId, authToken);

  return { client, controllerId: regData.controllerId };
}

describe('Gateway API', () => {
  beforeAll(async () => {
    const uid = `gw_${Date.now()}`;
    const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
    const body = await res.json();
    authToken = body.data?.signup?.token ?? '';
    expect(authToken).toBeTruthy();
  });

  describe('queries without auth', () => {
    it('should reject gateways query without token', async () => {
      const res = await gqlRequest(GATEWAYS_QUERY, { controllerId: '000000000000000000000000' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });
  });

  describe('mutations without auth', () => {
    it('should reject createGateway without auth', async () => {
      const res = await gqlRequest(CREATE_GATEWAY, { controllerId: '000000000000000000000000', name: 'test', port: 3000 });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject deleteGateway without auth', async () => {
      const res = await gqlRequest(DELETE_GATEWAY, { controllerId: '000000000000000000000000', name: 'test' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });
  });

  describe('createGateway', () => {
    it('should reject for non-existent controller', async () => {
      const res = await gqlRequest(
        CREATE_GATEWAY,
        { controllerId: '000000000000000000000000', name: 'my-svc', port: 3000 },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Controller not found');
    });

    it('should reject for offline controller', async () => {
      const { client, controllerId } = await registerController('offline');
      client.disconnect();

      // Poll until controller status becomes offline
      const CONTROLLER_QUERY = `query Controller($id: ID!) { controller(id: $id) { status } }`;
      await vi.waitFor(async () => {
        const pollRes = await gqlRequest(CONTROLLER_QUERY, { id: controllerId }, authToken);
        const pollBody = await pollRes.json();
        expect(pollBody.data?.controller?.status).toBe('offline');
      }, { timeout: 5000, interval: 200 });

      const res = await gqlRequest(
        CREATE_GATEWAY,
        { controllerId, name: 'my-svc', port: 3001 },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Controller is not online');
    });

    it('should create a gateway successfully', async () => {
      const { client, controllerId } = await registerController('create');

      const res = await gqlRequest(
        CREATE_GATEWAY,
        { controllerId, name: 'my-api', port: 3002 },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.createGateway).toBeDefined();
      expect(body.data.createGateway.name).toBe('my-api');
      expect(body.data.createGateway.port).toBe(3002);
      expect(body.data.createGateway.status).toBe('active');
      expect(body.data.createGateway.controllerId).toBe(controllerId);
      expect(body.data.createGateway.id).toBeDefined();
      expect(body.data.createGateway.createdAt).toBeDefined();

      client.disconnect();
    });

    it('should reject duplicate gateway name', async () => {
      const { client, controllerId } = await registerController('dup');

      const res1 = await gqlRequest(
        CREATE_GATEWAY,
        { controllerId, name: 'dup-svc', port: 3003 },
        authToken,
      );
      const body1 = await res1.json();
      expect(body1.errors).toBeUndefined();

      const res2 = await gqlRequest(
        CREATE_GATEWAY,
        { controllerId, name: 'dup-svc', port: 3004 },
        authToken,
      );
      const body2 = await res2.json();
      expect(body2.errors).toBeDefined();
      expect(body2.errors[0].message).toBe('Gateway name already exists');

      client.disconnect();
    });

    it('should reject invalid name format', async () => {
      const { client, controllerId } = await registerController('invalid');

      const res = await gqlRequest(
        CREATE_GATEWAY,
        { controllerId, name: 'bad name!', port: 3005 },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toContain('Name can only contain');

      client.disconnect();
    });
  });

  describe('gateways query with auth', () => {
    it('should return gateways list', async () => {
      const { client, controllerId } = await registerController('list');

      await gqlRequest(CREATE_GATEWAY, { controllerId, name: 'list-svc', port: 3004 }, authToken);

      const res = await gqlRequest(GATEWAYS_QUERY, { controllerId }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.gateways.gateways).toBeDefined();
      expect(body.data.gateways.gateways.length).toBeGreaterThan(0);
      expect(body.data.gateways.total).toBeGreaterThan(0);
      expect(body.data.gateways.limit).toBeDefined();

      const gw = body.data.gateways.gateways.find((g: { name: string }) => g.name === 'list-svc');
      expect(gw).toBeDefined();
      expect(gw.controllerId).toBe(controllerId);
      expect(gw.status).toBe('active');

      client.disconnect();
    });
  });

  describe('deleteGateway', () => {
    it('should delete a gateway by name successfully', async () => {
      const { client, controllerId } = await registerController('delete');

      await gqlRequest(CREATE_GATEWAY, { controllerId, name: 'del-svc', port: 4000 }, authToken);

      const res = await gqlRequest(DELETE_GATEWAY, { controllerId, name: 'del-svc' }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.deleteGateway).toBe(true);

      const listRes = await gqlRequest(GATEWAYS_QUERY, { controllerId }, authToken);
      const listBody = await listRes.json();
      const deleted = listBody.data.gateways.gateways.find((g: { name: string }) => g.name === 'del-svc');
      expect(deleted).toBeUndefined();

      client.disconnect();
    });

    it('should return false when deleting non-existent gateway', async () => {
      const { client, controllerId } = await registerController('delete-miss');

      const res = await gqlRequest(DELETE_GATEWAY, { controllerId, name: 'nonexistent' }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.deleteGateway).toBe(false);

      client.disconnect();
    });
  });

  describe('gateway tunnel end-to-end', () => {
    it('should create gateway and proxy request through tunnel successfully', async () => {
      const port = 19999;

      const { client, controllerId } = await registerController('e2e-tunnel');

      const gqlRes = await gqlRequest(
        CREATE_GATEWAY,
        { controllerId, name: 'my-test-service', port },
        authToken,
      );
      const gqlBody = await gqlRes.json();
      expect(gqlBody.errors).toBeUndefined();
      expect(gqlBody.data.createGateway.name).toBe('my-test-service');

      const tunnelEvent = await waitForEvent<{ tunnelId: string; port: number }>(
        client, 'port-forward:create',
      );
      expect(tunnelEvent.port).toBe(port);

      client.emit('port-forward:created', { tunnelId: tunnelEvent.tunnelId, success: true });

      const proxyUrl = `${API_BASE}/api/gateway/${controllerId}/my-test-service/hello`;

      const onProxyData = (data: { tunnelId: string; data: string }) => {
        const parsedRequest = JSON.parse(Buffer.from(data.data, 'base64').toString());
        const responseData = JSON.stringify({
          type: 'http-response',
          requestId: parsedRequest.requestId,
          statusCode: 200,
          headers: { 'content-type': 'text/plain' },
          body: Buffer.from('Hello from local service!').toString('base64'),
        });
        client.emit('port-forward:data', {
          tunnelId: data.tunnelId,
          data: Buffer.from(responseData).toString('base64'),
        });
      };

      client.on('port-forward:data', onProxyData);

      // Retry proxy request until tunnel is established (avoids fragile setTimeout)
      let proxyRes: Response | undefined;
      await vi.waitFor(async () => {
        const res = await fetch(proxyUrl, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (res.status !== 502) {
          proxyRes = res;
        }
        expect(res.status).not.toBe(502);
      }, { timeout: 10000, interval: 500 });

      client.removeListener('port-forward:data', onProxyData);
      client.emit('port-forward:close', { tunnelId: tunnelEvent.tunnelId });
      client.disconnect();

      expect(proxyRes!.status).toBe(200);
      const text = await proxyRes!.text();
      expect(text).toBe('Hello from local service!');
    });
  });
});
