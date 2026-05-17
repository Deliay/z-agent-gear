import { describe, it, expect } from 'vitest';

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

describe('Auth API', () => {
  let testToken = '';
  let testUserId = '';

  describe('signup', () => {
    const SIGNUP = `
      mutation Signup($username: String!, $password: String!) {
        signup(username: $username, password: $password) {
          token
          user { id username createdAt }
        }
      }
    `;

    it('should create a new user and return token', async () => {
      const res = await gqlRequest(SIGNUP, { username: `test_${Date.now()}`, password: 'password123' });
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.signup.token).toBeDefined();
      expect(body.data.signup.user.username).toContain('test_');
      expect(body.data.signup.user.id).toBeDefined();
      testToken = body.data.signup.token;
      testUserId = body.data.signup.user.id;
    });

    it('should reject duplicate username', async () => {
      const username = `dup_${Date.now()}`;
      await gqlRequest(SIGNUP, { username, password: 'password123' });
      const res = await gqlRequest(SIGNUP, { username, password: 'password123' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Username already taken');
    });

    it('should reject short username (under 2 chars)', async () => {
      const res = await gqlRequest(SIGNUP, { username: 'a', password: 'password123' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message.toLowerCase()).toContain('username');
    });

    it('should reject short password (under 6 chars)', async () => {
      const res = await gqlRequest(SIGNUP, { username: `valid_${Date.now()}`, password: '12345' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message.toLowerCase()).toContain('password');
    });
  });

  describe('login', () => {
    const LOGIN_USERNAME = `login_${Date.now()}`;
    const LOGIN_PASSWORD = 'password123';

    const SIGNUP = `
      mutation Signup($username: String!, $password: String!) {
        signup(username: $username, password: $password) {
          token
          user { id username }
        }
      }
    `;
    const LOGIN = `
      mutation Login($username: String!, $password: String!) {
        login(username: $username, password: $password) {
          token
          user { id username }
        }
      }
    `;

    it('should login with correct credentials', async () => {
      await gqlRequest(SIGNUP, { username: LOGIN_USERNAME, password: LOGIN_PASSWORD });
      const res = await gqlRequest(LOGIN, { username: LOGIN_USERNAME, password: LOGIN_PASSWORD });
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.login.token).toBeDefined();
      expect(body.data.login.user.username).toBe(LOGIN_USERNAME);
    });

    it('should reject wrong password', async () => {
      const res = await gqlRequest(LOGIN, { username: LOGIN_USERNAME, password: 'wrongpass' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Invalid username or password');
    });

    it('should reject non-existent username', async () => {
      const res = await gqlRequest(LOGIN, { username: 'nonexistent_user', password: 'password123' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Invalid username or password');
    });
  });

  describe('me', () => {
    const ME_USERNAME = `me_${Date.now()}`;
    const ME = `
      query Me {
        me { id username }
      }
    `;

    it('should return null when not authenticated', async () => {
      const res = await gqlRequest(ME);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.me).toBeNull();
    });

    it('should return current user when authenticated', async () => {
      const signupRes = await gqlRequest(
        `mutation { signup(username: "${ME_USERNAME}", password: "password123") { token user { id username } } }`,
      );
      const signupBody = await signupRes.json();
      const token = signupBody.data.signup.token;

      const res = await gqlRequest(ME, undefined, token);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.me.username).toBe(ME_USERNAME);
    });
  });
});
