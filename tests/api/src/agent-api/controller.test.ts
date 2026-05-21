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

let authToken = '';

const SIGNUP = `
  mutation Signup($username: String!, $password: String!) {
    signup(username: $username, password: $password) {
      token
      user { id username }
    }
  }
`;

const CONTROLLER_KEYS_QUERY = `
  query ControllerKeys {
    controllerKeys {
      id name type keyPrefix status lastUsedAt createdAt updatedAt
    }
  }
`;

const CONTROLLERS_QUERY = `
  query Controllers {
    controllers {
      id name hostname type status keyId version lastHeartbeatAt createdAt updatedAt
    }
  }
`;

const CONTROLLER_QUERY = `
  query Controller($id: ID!) {
    controller(id: $id) {
      id name hostname type status keyId version lastHeartbeatAt createdAt updatedAt
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

const RENAME_KEY = `
  mutation RenameControllerKey($input: RenameInput!) {
    renameControllerKey(input: $input) {
      id name updatedAt
    }
  }
`;

const RENAME_CONTROLLER = `
  mutation RenameController($input: RenameInput!) {
    renameController(input: $input) {
      id name updatedAt
    }
  }
`;

const UNBIND_CONTROLLER = `
  mutation UnbindController($id: ID!) {
    unbindController(id: $id)
  }
`;

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

describe('Controller Key API', () => {
  beforeAll(async () => {
    const uid = `ctrl_${Date.now()}`;
    const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
    const body = await res.json();
    authToken = body.data?.signup?.token ?? '';
    expect(authToken).toBeDefined();
  });

  describe('queries without auth', () => {
    it('should reject controllerKeys query without token', async () => {
      const res = await gqlRequest(CONTROLLER_KEYS_QUERY);
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject controllers query without token', async () => {
      const res = await gqlRequest(CONTROLLERS_QUERY);
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject controller query without token', async () => {
      const res = await gqlRequest(CONTROLLER_QUERY, { id: '000000000000000000000000' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });
  });

  describe('createControllerKey', () => {
    it('should reject mutation without auth', async () => {
      const res = await gqlRequest(CREATE_KEY, {
        input: { name: 'test-key', type: 'local' },
      });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should create a new controller key', async () => {
      const res = await gqlRequest(
        CREATE_KEY,
        { input: { name: `key-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.createControllerKey.key.id).toBeDefined();
      expect(body.data.createControllerKey.key.name).toContain('key-');
      expect(body.data.createControllerKey.key.status).toBe('active');
      expect(body.data.createControllerKey.rawKey).toMatch(/^zag_k_/);
    });

    it('should reject empty name', async () => {
      const res = await gqlRequest(
        CREATE_KEY,
        { input: { name: '', type: 'local' } },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
    });

    it('should replace existing unbound key when generating new one', async () => {
      // Create first key
      const res1 = await gqlRequest(
        CREATE_KEY,
        { input: { name: `first-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const body1 = await res1.json();
      const firstKeyId = body1.data.createControllerKey.key.id;

      // Create second key — should replace the first
      const res2 = await gqlRequest(
        CREATE_KEY,
        { input: { name: `second-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const body2 = await res2.json();
      const secondKeyId = body2.data.createControllerKey.key.id;
      expect(secondKeyId).not.toBe(firstKeyId);

      // Query keys — should only have the second one (plus any from other tests)
      const keysRes = await gqlRequest(CONTROLLER_KEYS_QUERY, undefined, authToken);
      const keysBody = await keysRes.json();
      const firstKey = keysBody.data.controllerKeys.find((k: { id: string }) => k.id === firstKeyId);
      expect(firstKey).toBeUndefined();
    });
  });

  describe('controllerKeys query with auth', () => {
    it('should return controller keys list', async () => {
      const res = await gqlRequest(CONTROLLER_KEYS_QUERY, undefined, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(Array.isArray(body.data.controllerKeys)).toBe(true);
    });
  });

  describe('renameControllerKey', () => {
    let keyId = '';

    beforeAll(async () => {
      const res = await gqlRequest(
        CREATE_KEY,
        { input: { name: `rename-test-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const body = await res.json();
      keyId = body.data.createControllerKey.key.id;
    });

    it('should reject mutation without auth', async () => {
      const res = await gqlRequest(RENAME_KEY, {
        input: { id: keyId, name: 'new-name' },
      });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should rename controller key', async () => {
      const newName = `renamed-${Date.now()}`;
      const res = await gqlRequest(
        RENAME_KEY,
        { input: { id: keyId, name: newName } },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.renameControllerKey.name).toBe(newName);
    });

    it('should reject renaming non-existent key', async () => {
      const res = await gqlRequest(
        RENAME_KEY,
        { input: { id: '000000000000000000000000', name: 'nope' } },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
    });
  });
});

describe('Controller Management API', () => {
  beforeAll(async () => {
    if (!authToken) {
      const uid = `ctrl_mgmt_${Date.now()}`;
      const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
      const body = await res.json();
      authToken = body.data?.signup?.token ?? '';
      expect(authToken).toBeTruthy();
    }
  });

  describe('controllers query', () => {
    it('should return empty controllers list', async () => {
      const res = await gqlRequest(CONTROLLERS_QUERY, undefined, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.controllers).toEqual([]);
    });
  });

  describe('controller query', () => {
    it('should return null for non-existent controller', async () => {
      const res = await gqlRequest(CONTROLLER_QUERY, { id: '000000000000000000000000' }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.controller).toBeNull();
    });
  });

  describe('renameController', () => {
    it('should reject mutation without auth', async () => {
      const res = await gqlRequest(RENAME_CONTROLLER, {
        input: { id: 'fake-id', name: 'new-name' },
      });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject renaming non-existent controller', async () => {
      const res = await gqlRequest(
        RENAME_CONTROLLER,
        { input: { id: '000000000000000000000000', name: 'nope' } },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Controller not found');
    });
  });

  describe('unbindController', () => {
    it('should reject mutation without auth', async () => {
      const res = await gqlRequest(UNBIND_CONTROLLER, { id: 'fake-id' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should return false for non-existent controller', async () => {
      const res = await gqlRequest(UNBIND_CONTROLLER, { id: '000000000000000000000000' }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.unbindController).toBe(false);
    });
  });
});

describe('Controller Online Status', () => {
  let keyId = '';
  let rawKey = '';
  let controllerId = '';

  beforeAll(async () => {
    if (!authToken) {
      const uid = `ctrl_online_${Date.now()}`;
      const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
      const body = await res.json();
      authToken = body.data?.signup?.token ?? '';
      expect(authToken).toBeTruthy();
    }

    const res = await gqlRequest(
      CREATE_KEY,
      { input: { name: `online-test-${Date.now()}`, type: 'local' } },
      authToken,
    );
    const body = await res.json();
    keyId = body.data.createControllerKey.key.id;
    rawKey = body.data.createControllerKey.rawKey;
  });

  it('should show controller as online after WebSocket register', async () => {
    const client = createWSClient();
    const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
    client.emit('register', { key: rawKey, hostname: 'test-host', version: '1.0.0' });
    const regData = await registered;
    controllerId = regData.controllerId;

    await new Promise((r) => setTimeout(r, 200));

    const res = await gqlRequest(CONTROLLER_QUERY, { id: controllerId }, authToken);
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.controller).not.toBeNull();
    expect(body.data.controller.status).toBe('online');
    expect(body.data.controller.hostname).toBe('test-host');
    expect(body.data.controller.version).toBe('1.0.0');
    expect(body.data.controller.keyId).toBe(keyId);

    client.disconnect();
  });

  it('should include online controller in controllers list', async () => {
    const client = createWSClient();
    const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
    const onlineKeyRes = await gqlRequest(
      CREATE_KEY,
      { input: { name: `online-list-${Date.now()}`, type: 'local' } },
      authToken,
    );
    const onlineKeyBody = await onlineKeyRes.json();
    const onlineKey = onlineKeyBody.data.createControllerKey.rawKey;
    client.emit('register', { key: onlineKey, hostname: 'list-test-host', version: '1.0.0' });
    await registered;

    const res = await gqlRequest(CONTROLLERS_QUERY, undefined, authToken);
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    const online = body.data.controllers.find(
      (c: { keyId: string }) => c.keyId === onlineKeyBody.data.createControllerKey.key.id,
    );
    expect(online).toBeDefined();
    expect(online.status).toBe('online');
    expect(online.hostname).toBe('list-test-host');

    client.disconnect();
  });

  it('should delete controller and key after WebSocket unregister', async () => {
    const client = createWSClient();
    const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
    client.emit('register', { key: rawKey, hostname: 'test-host', version: '1.0.0' });
    await registered;

    const unregistered = waitForEvent(client, 'unregistered');
    client.emit('unregister', { reason: 'user_detach' });
    await unregistered;

    await new Promise((r) => setTimeout(r, 300));

    const res = await gqlRequest(CONTROLLER_QUERY, { id: controllerId }, authToken);
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.controller).toBeNull();
  });

  it('should delete key on unbind via GraphQL', async () => {
    // Create a fresh key for this test
    const createRes = await gqlRequest(
      CREATE_KEY,
      { input: { name: `unbind-test-${Date.now()}`, type: 'local' } },
      authToken,
    );
    const createBody = await createRes.json();
    const testKeyId = createBody.data.createControllerKey.key.id;
    const testRawKey = createBody.data.createControllerKey.rawKey;

    // Register a controller with this key
    const client = createWSClient();
    const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
    client.emit('register', { key: testRawKey, hostname: 'unbind-host', version: '1.0.0' });
    const regData = await registered;
    const testControllerId = regData.controllerId;
    client.disconnect();

    await new Promise((r) => setTimeout(r, 300));

    // Unbind via GraphQL
    const unbindRes = await gqlRequest(UNBIND_CONTROLLER, { id: testControllerId }, authToken);
    const unbindBody = await unbindRes.json();
    expect(unbindBody.errors).toBeUndefined();
    expect(unbindBody.data.unbindController).toBe(true);

    await new Promise((r) => setTimeout(r, 300));

    // Key should be deleted
    const keysRes = await gqlRequest(CONTROLLER_KEYS_QUERY, undefined, authToken);
    const keysBody = await keysRes.json();
    const deletedKey = keysBody.data.controllerKeys.find((k: { id: string }) => k.id === testKeyId);
    expect(deletedKey).toBeUndefined();

    // Controller should be deleted
    const ctrlRes = await gqlRequest(CONTROLLER_QUERY, { id: testControllerId }, authToken);
    const ctrlBody = await ctrlRes.json();
    expect(ctrlBody.data.controller).toBeNull();
  });
});
