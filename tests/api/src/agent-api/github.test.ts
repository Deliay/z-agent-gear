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

const SIGNUP = `
  mutation Signup($username: String!, $password: String!) {
    signup(username: $username, password: $password) {
      token
      user { id }
    }
  }
`;

const GITHUB_APP_URL = `
  query GetGithubAppUrl {
    githubAppUrl { url state }
  }
`;

const GITHUB_ACCOUNTS = `
  query GetGithubAccounts {
    githubAccounts { id githubLogin githubUserId }
  }
`;

const UNBIND = `
  mutation Unbind($accountId: ID!) {
    unbindGitHubAccount(accountId: $accountId)
  }
`;

describe('GitHub Binding API', () => {
  let token = '';
  const testUsername = `gt_${Date.now()}`;

  beforeAll(async () => {
    const res = await gqlRequest(SIGNUP, { username: testUsername, password: 'password123' });
    const body = await res.json();
    token = body.data.signup.token;
  });

  describe('githubAppUrl', () => {
    it('should reject unauthenticated request', async () => {
      const res = await gqlRequest(GITHUB_APP_URL);
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should return URL with state for authenticated user', async () => {
      const res = await gqlRequest(GITHUB_APP_URL, undefined, token);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.githubAppUrl).toBeDefined();
      expect(body.data.githubAppUrl.url).toContain('github.com/apps/');
      expect(body.data.githubAppUrl.state).toBeDefined();
      expect(typeof body.data.githubAppUrl.state).toBe('string');
    });
  });

  describe('githubAccounts', () => {
    it('should reject unauthenticated request', async () => {
      const res = await gqlRequest(GITHUB_ACCOUNTS);
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should return empty list for new user', async () => {
      const res = await gqlRequest(GITHUB_ACCOUNTS, undefined, token);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.githubAccounts).toEqual([]);
    });
  });

  describe('unbindGitHubAccount', () => {
    it('should reject unauthenticated request', async () => {
      const res = await gqlRequest(UNBIND, { accountId: '000000000000000000000000' });
      const body = await res.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toBe('Not authenticated');
    });

    it('should return false for non-existent account', async () => {
      const res = await gqlRequest(UNBIND, { accountId: '000000000000000000000000' }, token);
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.unbindGitHubAccount).toBe(false);
    });
  });
});
