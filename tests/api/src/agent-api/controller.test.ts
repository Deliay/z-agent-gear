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

const REGENERATE_CONTROLLER_KEY = `
  mutation RegenerateControllerKey($input: RegenerateControllerKeyInput!) {
    regenerateControllerKey(input: $input) {
      key { id name type keyPrefix status rawKey createdAt updatedAt }
      rawKey
    }
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
    client.emit('register', { key: rawKey, hostname: 'test-host', version: '2.0.0' });
    const regData = await registered;
    controllerId = regData.controllerId;

    await new Promise((r) => setTimeout(r, 200));

    const res = await gqlRequest(CONTROLLER_QUERY, { id: controllerId }, authToken);
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.controller).not.toBeNull();
    expect(body.data.controller.status).toBe('online');
    expect(body.data.controller.hostname).toBe('test-host');
    expect(body.data.controller.version).toBe('2.0.0');
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
    client.emit('register', { key: onlineKey, hostname: 'list-test-host', version: '2.0.0' });
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
    client.emit('register', { key: rawKey, hostname: 'test-host', version: '2.0.0' });
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
    client.emit('register', { key: testRawKey, hostname: 'unbind-host', version: '2.0.0' });
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

  describe('setControllerWorktreeDir mutation', () => {
    const SET_WORKTREE_DIR = `
      mutation SetControllerWorktreeDir($controllerId: ID!, $worktreeDir: String!) {
        setControllerWorktreeDir(controllerId: $controllerId, worktreeDir: $worktreeDir) {
          id worktreeDir
        }
      }
    `;

    const CONTROLLER_QUERY_WITH_WORKTREE = `
      query Controller($id: ID!) {
        controller(id: $id) {
          id name hostname type status keyId version worktreeDir lastHeartbeatAt createdAt updatedAt
        }
      }
    `;

    it('should reject mutation without auth', async () => {
      const res = await gqlRequest(SET_WORKTREE_DIR, {
        controllerId: '000000000000000000000000',
        worktreeDir: '/tmp/worktrees',
      });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject mutation for non-existent controller', async () => {
      const res = await gqlRequest(
        SET_WORKTREE_DIR,
        { controllerId: '000000000000000000000000', worktreeDir: '/tmp/worktrees' },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Controller not found');
    });

    it('should set worktreeDir on controller and persist', async () => {
      const createRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `wtd-key-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const createBody = await createRes.json();
      const testRawKey = createBody.data.createControllerKey.rawKey;

      const client = createWSClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: testRawKey, hostname: 'wtd-host', version: '2.0.0' });
      const regData = await registered;
      const testControllerId = regData.controllerId;

      await new Promise((r) => setTimeout(r, 200));

      const res = await gqlRequest(
        SET_WORKTREE_DIR,
        { controllerId: testControllerId, worktreeDir: '/home/user/worktrees' },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.setControllerWorktreeDir.id).toBe(testControllerId);
      expect(body.data.setControllerWorktreeDir.worktreeDir).toBe('/home/user/worktrees');

      const queryRes = await gqlRequest(
        CONTROLLER_QUERY_WITH_WORKTREE,
        { id: testControllerId },
        authToken,
      );
      const queryBody = await queryRes.json();
      expect(queryBody.data.controller.worktreeDir).toBe('/home/user/worktrees');

      client.disconnect();
    });
  });

  describe('regenerateControllerKey mutation', () => {
    it('should reject mutation without auth', async () => {
      const res = await gqlRequest(REGENERATE_CONTROLLER_KEY, {
        input: { controllerId: '000000000000000000000000' },
      });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should reject mutation for non-existent controller', async () => {
      const res = await gqlRequest(
        REGENERATE_CONTROLLER_KEY,
        { input: { controllerId: '000000000000000000000000' } },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Controller not found');
    });

    it('should regenerate controller key and return controller with unbound status', async () => {
      // Create a key and register a controller
      const createRes = await gqlRequest(
        CREATE_KEY,
        { input: { name: `regen-test-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const createBody = await createRes.json();
      const testRawKey = createBody.data.createControllerKey.rawKey;

      const client = createWSClient();
      const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
      client.emit('register', { key: testRawKey, hostname: 'regen-host', version: '2.0.0' });
      const regData = await registered;
      const testControllerId = regData.controllerId;

      await new Promise((r) => setTimeout(r, 200));

      // Verify controller is online before regeneration
      const beforeRes = await gqlRequest(CONTROLLER_QUERY, { id: testControllerId }, authToken);
      const beforeBody = await beforeRes.json();
      expect(beforeBody.data.controller.status).toBe('online');

      // Regenerate key
      const res = await gqlRequest(
        REGENERATE_CONTROLLER_KEY,
        { input: { controllerId: testControllerId } },
        authToken,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.regenerateControllerKey.key.id).toBeDefined();
      expect(body.data.regenerateControllerKey.rawKey).toMatch(/^zag_k_/);
      expect(body.data.regenerateControllerKey.rawKey).not.toBe(testRawKey);

      // Verify controller status is now unbound
      const afterRes = await gqlRequest(CONTROLLER_QUERY, { id: testControllerId }, authToken);
      const afterBody = await afterRes.json();
      expect(afterBody.data.controller).not.toBeNull();
      expect(afterBody.data.controller.status).toBe('unbound');

      // Verify controller is in the controllers list
      const listRes = await gqlRequest(CONTROLLERS_QUERY, undefined, authToken);
      const listBody = await listRes.json();
      const found = listBody.data.controllers.find((c: { id: string }) => c.id === testControllerId);
      expect(found).toBeDefined();
      expect(found.status).toBe('unbound');

      client.disconnect();
    });

    it('should allow rebinding after regeneration and regenerate again', async () => {
      // Step 1: Create a key and register a controller
      const createRes1 = await gqlRequest(
        CREATE_KEY,
        { input: { name: `rebind-test-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const createBody1 = await createRes1.json();
      const firstRawKey = createBody1.data.createControllerKey.rawKey;

      const client1 = createWSClient();
      const registered1 = waitForEvent<{ controllerId: string }>(client1, 'registered');
      client1.emit('register', { key: firstRawKey, hostname: 'rebind-host', version: '2.0.0' });
      const regData1 = await registered1;
      const controllerId = regData1.controllerId;

      await new Promise((r) => setTimeout(r, 200));

      // Step 2: Regenerate key
      const regenRes1 = await gqlRequest(
        REGENERATE_CONTROLLER_KEY,
        { input: { controllerId } },
        authToken,
      );
      const regenBody1 = await regenRes1.json();
      expect(regenBody1.errors).toBeUndefined();
      const secondRawKey = regenBody1.data.regenerateControllerKey.rawKey;

      await new Promise((r) => setTimeout(r, 200));

      // Step 3: Verify controller is unbound
      const checkRes1 = await gqlRequest(CONTROLLER_QUERY, { id: controllerId }, authToken);
      const checkBody1 = await checkRes1.json();
      expect(checkBody1.data.controller.status).toBe('unbound');

      // Step 4: Rebind with the new key
      const client2 = createWSClient();
      const registered2 = waitForEvent<{ controllerId: string }>(client2, 'registered');
      client2.emit('register', { key: secondRawKey, hostname: 'rebind-host', version: '2.0.0' });
      const regData2 = await registered2;
      expect(regData2.controllerId).toBe(controllerId);

      await new Promise((r) => setTimeout(r, 200));

      // Step 5: Verify controller is online again
      const checkRes2 = await gqlRequest(CONTROLLER_QUERY, { id: controllerId }, authToken);
      const checkBody2 = await checkRes2.json();
      expect(checkBody2.data.controller.status).toBe('online');

      // Step 6: Regenerate key again
      const regenRes2 = await gqlRequest(
        REGENERATE_CONTROLLER_KEY,
        { input: { controllerId } },
        authToken,
      );
      const regenBody2 = await regenRes2.json();
      expect(regenBody2.errors).toBeUndefined();
      expect(regenBody2.data.regenerateControllerKey.rawKey).toMatch(/^zag_k_/);
      expect(regenBody2.data.regenerateControllerKey.rawKey).not.toBe(secondRawKey);

      // Step 7: Verify controller is unbound again
      const checkRes3 = await gqlRequest(CONTROLLER_QUERY, { id: controllerId }, authToken);
      const checkBody3 = await checkRes3.json();
      expect(checkBody3.data.controller.status).toBe('unbound');

      client1.disconnect();
      client2.disconnect();
    });
  });

// Phase 9：控制器默认 MCP（schema 归一 + 保存校验）
const MCP_SERVERS_QUERY = `
  query McpServers {
    mcpServers { id name enabled transport source }
  }
`;

const CONTROLLER_DEFAULT_MCP_QUERY = `
  query ControllerDefaultMcp($id: ID!) {
    controller(id: $id) { id defaultMcp { useAllEnabled serverIds } }
  }
`;

const SET_CONTROLLER_DEFAULT_MCP = `
  mutation SetDefaultMcp($controllerId: ID!, $useAllEnabled: Boolean!, $serverIds: [ID!]) {
    setControllerDefaultMcp(
      controllerId: $controllerId
      useAllEnabled: $useAllEnabled
      serverIds: $serverIds
    ) {
      id
      defaultMcp { useAllEnabled serverIds }
    }
  }
`;

describe('Controller default MCP API (Phase 9)', () => {
  let token = '';
  let client: ClientSocket;
  let testControllerId = '';

  beforeAll(async () => {
    const uid = `ctrl_dmcp_${Date.now()}`;
    const signupRes = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
    const signupBody = await signupRes.json();
    token = signupBody.data.signup.token;

    const keyRes = await gqlRequest(
      CREATE_KEY,
      { input: { name: `dmcp-key-${Date.now()}`, type: 'local' } },
      token,
    );
    const keyBody = await keyRes.json();
    client = createWSClient();
    const registered = waitForEvent<{ controllerId: string }>(client, 'registered');
    client.emit('register', {
      key: keyBody.data.createControllerKey.rawKey,
      hostname: 'dmcp-host',
      version: '2.0.0',
    });
    const reg = await registered;
    testControllerId = reg.controllerId;
  });

  afterAll(() => {
    client?.disconnect();
  });

  it('T-API-CTRL-MCP1: 历史行缺失 defaultMcp 时归一为 useAllEnabled=true', async () => {
    const res = await gqlRequest(CONTROLLER_DEFAULT_MCP_QUERY, { id: testControllerId }, token);
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.controller.defaultMcp).toEqual({ useAllEnabled: true, serverIds: [] });
  });

  it('T-API-CTRL-MCP2: useAllEnabled=false 保存所选服务并持久化', async () => {
    const listRes = await gqlRequest(MCP_SERVERS_QUERY, undefined, token);
    const listBody = await listRes.json();
    const admin = (listBody.data.mcpServers as Array<{ id: string; name: string }>).find(
      (server) => server.name === 'agent-workflow-admin-tools',
    );
    expect(admin).toBeTruthy();

    const saveRes = await gqlRequest(
      SET_CONTROLLER_DEFAULT_MCP,
      { controllerId: testControllerId, useAllEnabled: false, serverIds: [admin!.id] },
      token,
    );
    const saveBody = await saveRes.json();
    expect(saveBody.errors).toBeUndefined();
    expect(saveBody.data.setControllerDefaultMcp.defaultMcp).toEqual({
      useAllEnabled: false,
      serverIds: [admin!.id],
    });

    const queryRes = await gqlRequest(CONTROLLER_DEFAULT_MCP_QUERY, { id: testControllerId }, token);
    const queryBody = await queryRes.json();
    expect(queryBody.data.controller.defaultMcp).toEqual({
      useAllEnabled: false,
      serverIds: [admin!.id],
    });
  });

  it('T-API-CTRL-MCP3: useAllEnabled=true 忽略入参 serverIds 并归一为空数组', async () => {
    const listRes = await gqlRequest(MCP_SERVERS_QUERY, undefined, token);
    const listBody = await listRes.json();
    const admin = (listBody.data.mcpServers as Array<{ id: string; name: string }>).find(
      (server) => server.name === 'agent-workflow-admin-tools',
    );
    expect(admin).toBeTruthy();

    const res = await gqlRequest(
      SET_CONTROLLER_DEFAULT_MCP,
      { controllerId: testControllerId, useAllEnabled: true, serverIds: [admin!.id] },
      token,
    );
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.setControllerDefaultMcp.defaultMcp).toEqual({
      useAllEnabled: true,
      serverIds: [],
    });
  });

  it('T-API-CTRL-MCP4: 不存在/已停用的服务返回 MCP_SERVER_NOT_FOUND', async () => {
    const missing = await gqlRequest(
      SET_CONTROLLER_DEFAULT_MCP,
      {
        controllerId: testControllerId,
        useAllEnabled: false,
        serverIds: ['000000000000000000000000'],
      },
      token,
    );
    expect((await missing.json()).errors?.[0]?.message).toBe('MCP_SERVER_NOT_FOUND');

    const listRes = await gqlRequest(MCP_SERVERS_QUERY, undefined, token);
    const listBody = await listRes.json();
    const admin = (listBody.data.mcpServers as Array<{ id: string; name: string }>).find(
      (server) => server.name === 'agent-workflow-admin-tools',
    );
    expect(admin).toBeTruthy();
    await gqlRequest(
      `mutation SetMcp($id: ID!, $enabled: Boolean!) { setMcpServerEnabled(id: $id, enabled: $enabled) { id } }`,
      { id: admin!.id, enabled: false },
      token,
    );
    const disabled = await gqlRequest(
      SET_CONTROLLER_DEFAULT_MCP,
      { controllerId: testControllerId, useAllEnabled: false, serverIds: [admin!.id] },
      token,
    );
    expect((await disabled.json()).errors?.[0]?.message).toBe('MCP_SERVER_NOT_FOUND');
    await gqlRequest(
      `mutation SetMcp($id: ID!, $enabled: Boolean!) { setMcpServerEnabled(id: $id, enabled: $enabled) { id } }`,
      { id: admin!.id, enabled: true },
      token,
    );
  });

  it('T-API-CTRL-MCP5: 空数组合法（表示不注入）', async () => {
    const res = await gqlRequest(
      SET_CONTROLLER_DEFAULT_MCP,
      { controllerId: testControllerId, useAllEnabled: false, serverIds: [] },
      token,
    );
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.setControllerDefaultMcp.defaultMcp).toEqual({
      useAllEnabled: false,
      serverIds: [],
    });
  });

  it('T-API-CTRL-MCP6: 未认证与不存在的控制器文案与契约一致', async () => {
    const anonymous = await gqlRequest(SET_CONTROLLER_DEFAULT_MCP, {
      controllerId: testControllerId,
      useAllEnabled: true,
    });
    expect((await anonymous.json()).errors?.[0]?.message).toBe('Not authenticated');

    const missing = await gqlRequest(
      SET_CONTROLLER_DEFAULT_MCP,
      { controllerId: '000000000000000000000000', useAllEnabled: true },
      token,
    );
    expect((await missing.json()).errors?.[0]?.message).toBe('Controller not found');
  });
});
