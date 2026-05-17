import { describe, it, expect, beforeAll } from 'vitest';

const API_URL = process.env.API_URL || 'http://localhost:4000/graphql';

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

const REVOKE_KEY = `
  mutation RevokeControllerKey($id: ID!) {
    revokeControllerKey(id: $id)
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

  describe('revokeControllerKey', () => {
    let keyId = '';

    beforeAll(async () => {
      const res = await gqlRequest(
        CREATE_KEY,
        { input: { name: `revoke-test-${Date.now()}`, type: 'local' } },
        authToken,
      );
      const body = await res.json();
      keyId = body.data.createControllerKey.key.id;
    });

    it('should reject mutation without auth', async () => {
      const res = await gqlRequest(REVOKE_KEY, { id: keyId });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should revoke controller key', async () => {
      const res = await gqlRequest(REVOKE_KEY, { id: keyId }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.revokeControllerKey).toBe(true);

      const keysRes = await gqlRequest(CONTROLLER_KEYS_QUERY, undefined, authToken);
      const keysBody = await keysRes.json();
      const revokedKey = keysBody.data.controllerKeys.find(
        (k: { id: string }) => k.id === keyId,
      );
      expect(revokedKey.status).toBe('revoked');
    });

    it('should return false for non-existent key', async () => {
      const res = await gqlRequest(REVOKE_KEY, { id: '000000000000000000000000' }, authToken);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.revokeControllerKey).toBe(false);
    });
  });
});

describe('Controller Management API', () => {
  beforeAll(async () => {
    const uid = `ctrl_mgmt_${Date.now()}`;
    const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
    const body = await res.json();
    authToken = body.data?.signup?.token ?? '';
    expect(authToken).toBeDefined();
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
