import { describe, it, expect, beforeAll } from 'vitest';
import { createFrontUser, uniqueFrontUsername } from '../support/front-users.js';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';

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

interface LoginPayload {
  token: string;
  user: {
    id: string;
    name: string;
    createdAt: string;
    tenant: { id: string; name: string; type: string; memberCount: number };
  };
}

const LOGIN = `
  mutation Login($username: String!, $password: String!) {
    login(username: $username, password: $password) {
      token
      user {
        id
        name
        createdAt
        tenant { id name type memberCount }
      }
    }
  }
`;

const ME = `
  query Me {
    me {
      id
      name
      createdAt
      tenant { id name type memberCount }
    }
  }
`;

async function login(username: string, password: string) {
  const res = await gqlRequest(LOGIN, { username, password });
  return (await res.json()) as {
    data?: { login?: LoginPayload };
    errors?: Array<{ message: string }>;
  };
}

describe('Auth API', () => {
  // 多租户一期：前台注册已硬关闭，测试用户统一经 agent-api `POST /internal/users` 开户。
  const password = 'password123';
  let username = '';
  let userId = '';
  let tenantId = '';

  beforeAll(async () => {
    const user = await createFrontUser(uniqueFrontUsername('auth'), password);
    username = user.username;
    userId = user.userId;
    tenantId = user.tenantId;
  });

  describe('contract: 前台无自助注册', () => {
    it('introspection 中不存在 signup/register mutation，仅保留 login', async () => {
      const res = await gqlRequest(`
        query Introspect {
          __schema { mutationType { fields { name } } }
        }
      `);
      const body = (await res.json()) as {
        data?: { __schema: { mutationType: { fields: Array<{ name: string }> } } };
        errors?: Array<{ message: string }>;
      };
      expect(body.errors).toBeUndefined();
      const names = body.data!.__schema.mutationType.fields.map((f) => f.name.toLowerCase());
      expect(names.some((n) => n.includes('signup') || n.includes('register'))).toBe(false);
      expect(names).toContain('login');
    });

    it('User 契约暴露 name + tenant，不再暴露登录字段 username', async () => {
      const res = await gqlRequest(`
        query UserFields {
          __type(name: "User") { fields { name } }
        }
      `);
      const body = (await res.json()) as {
        data?: { __type: { fields: Array<{ name: string }> } };
        errors?: Array<{ message: string }>;
      };
      expect(body.errors).toBeUndefined();
      const fields = body.data!.__type.fields.map((f) => f.name);
      expect(fields).toContain('name');
      expect(fields).toContain('tenant');
      expect(fields).not.toContain('username');
    });
  });

  describe('login', () => {
    it('should login with correct credentials and expose name + personal tenant', async () => {
      const body = await login(username, password);
      expect(body.errors).toBeUndefined();
      const payload = body.data!.login!;
      expect(payload.token).toBeDefined();
      expect(payload.user.id).toBe(userId);
      expect(payload.user.name).toBe(username);
      expect(payload.user.createdAt).toBeTruthy();
      expect(payload.user.tenant).toMatchObject({
        name: username,
        type: 'personal',
        memberCount: 1,
      });
      // personal 期：租户 _id 复用 userId
      expect(payload.user.tenant.id).toBe(tenantId);
      expect(payload.user.tenant.id).toBe(payload.user.id);
    });

    it('should reject wrong password', async () => {
      const body = await login(username, 'wrongpass');
      expect(body.errors).toBeDefined();
      expect(body.errors![0].message).toBe('Invalid username or password');
    });

    it('should reject non-existent username', async () => {
      const body = await login('nonexistent_user', 'password123');
      expect(body.errors).toBeDefined();
      expect(body.errors![0].message).toBe('Invalid username or password');
    });
  });

  describe('me', () => {
    it('should return null when not authenticated', async () => {
      const res = await gqlRequest(ME);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.me).toBeNull();
    });

    it('should return current user (name + tenant) when authenticated', async () => {
      const { token } = await login(username, password).then((body) => body.data!.login!);

      const res = await gqlRequest(ME, undefined, token);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.me).toMatchObject({
        id: userId,
        name: username,
        tenant: { id: tenantId, name: username, type: 'personal', memberCount: 1 },
      });
      expect(body.data.me.createdAt).toBeTruthy();
    });
  });
});
