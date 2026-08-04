import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

let authToken: string;
let userId: string;

beforeAll(async () => {
  const username = `mcp${Date.now() % 1000000}`;
  const signupRes = await gqlRequest(SIGNUP, { username, password: 'password123' });
  const signupData = await signupRes.json() as any;
  authToken = signupData.data?.signup?.token;
  userId = signupData.data?.signup?.user?.id;
  if (!authToken || !userId) {
    console.error('Failed to get auth token or userId:', signupData);
  }
});

describe('MCP Proxy Key API (controller-api)', () => {
  let createdKeyId: string;
  let createdRawKey: string;
  const testKeyName = `Test MCP Key ${Date.now()}`;

  describe('POST /api/mcp-proxy-keys', () => {
    it('should list keys (empty initially)', async () => {
      const res = await fetch(`${CONTROLLER_API_URL}/api/mcp-proxy-keys`, {
        headers: { 'x-user-id': userId },
      });
      expect(res.ok).toBe(true);
      const keys = await res.json() as any[];
      expect(Array.isArray(keys)).toBe(true);
    });

    it('should create a new MCP proxy key', async () => {
      console.log('Creating key with userId:', userId);
      const res = await fetch(`${CONTROLLER_API_URL}/api/mcp-proxy-keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': userId,
        },
        body: JSON.stringify({ name: testKeyName }),
      });
      console.log('Create key response status:', res.status);
      const data = await res.json() as any;
      console.log('Create key response:', JSON.stringify(data, null, 2));
      expect(res.ok).toBe(true);
      expect(data.rawKey).toMatch(/^mcp_/);
      expect(data.key.name).toBe(testKeyName);
      expect(data.key.status).toBe('active');
      createdKeyId = data.key.id;
      createdRawKey = data.rawKey;
    });

    it('should reject duplicate key name', async () => {
      const res = await fetch(`${CONTROLLER_API_URL}/api/mcp-proxy-keys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': userId,
        },
        body: JSON.stringify({ name: testKeyName }),
      });
      expect(res.status).toBe(409);
    });

    it('should list keys after creation', async () => {
      console.log('Looking for key with id:', createdKeyId);
      const res = await fetch(`${CONTROLLER_API_URL}/api/mcp-proxy-keys`, {
        headers: { 'x-user-id': userId },
      });
      expect(res.ok).toBe(true);
      const keys = await res.json() as any[];
      console.log('Keys found:', keys.length, keys.map(k => k.id));
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.some((k: any) => k.id === createdKeyId)).toBe(true);
    });
  });

  describe('POST /api/mcp-proxy-keys/:id/revoke', () => {
    it('should revoke a key', async () => {
      console.log('Attempting to revoke key:', createdKeyId);
      const res = await fetch(`${CONTROLLER_API_URL}/api/mcp-proxy-keys/${createdKeyId}/revoke`, {
        method: 'POST',
        headers: { 'x-user-id': userId },
      });
      console.log('Revoke response status:', res.status);
      expect(res.ok).toBe(true);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
    });

    it('should return 404 for non-existent key', async () => {
      const res = await fetch(`${CONTROLLER_API_URL}/api/mcp-proxy-keys/000000000000000000000000/revoke`, {
        method: 'POST',
        headers: { 'x-user-id': userId },
      });
      expect(res.status).toBe(404);
    });
  });
});

describe('MCP Proxy Registration API (controller-api)', () => {
  let proxyKey: string;
  let proxyKeyId: string;

  beforeAll(async () => {
    const res = await fetch(`${CONTROLLER_API_URL}/api/mcp-proxy-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userId,
      },
      body: JSON.stringify({ name: 'Registration Test Key' }),
    });
    const data = await res.json() as any;
    proxyKey = data.rawKey;
    proxyKeyId = data.key.id;
  });

  describe('POST /api/mcp-proxy/register', () => {
    it('should reject registration without key', async () => {
      const res = await fetch(`${CONTROLLER_API_URL}/api/mcp-proxy/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hostname: 'test-machine',
          command: 'npx @modelcontextprotocol/server-github',
          serverName: 'github-mcp',
        }),
      });
      expect(res.status).toBe(400);
    });

    it('should reject registration with invalid key', async () => {
      const res = await fetch(`${CONTROLLER_API_URL}/api/mcp-proxy/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'invalid-key',
          hostname: 'test-machine',
          command: 'npx @modelcontextprotocol/server-github',
          serverName: 'github-mcp',
        }),
      });
      expect(res.ok).toBe(true);
      const data = await res.json() as any;
      expect(data.success).toBe(false);
      expect(data.error).toBe('Invalid key');
    });

    it('should register with valid key', async () => {
      const res = await fetch(`${CONTROLLER_API_URL}/api/mcp-proxy/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: proxyKey,
          hostname: 'test-machine',
          command: 'npx @modelcontextprotocol/server-github',
          serverName: 'github-mcp',
        }),
      });
      expect(res.ok).toBe(true);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.proxyId).toMatch(/^proxy_/);
      expect(data.serverId).toBeDefined();
    });
  });

  afterAll(async () => {
    await fetch(`${CONTROLLER_API_URL}/api/mcp-proxy-keys/${proxyKeyId}/revoke`, {
      method: 'POST',
      headers: { 'x-user-id': userId },
    });
  });
});
