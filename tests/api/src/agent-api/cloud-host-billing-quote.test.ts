import { describe, it, expect } from 'vitest';

// 云电脑报价转发（需要 Aspire + ADMIN_API_URL/INTERNAL_API_TOKEN）。
const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const ENABLED = Boolean(process.env.ADMIN_API_URL);

function gql(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  }).then((res) => res.json() as Promise<{ data?: any; errors?: Array<{ message: string }> }>);
}

const SIGNUP = `
  mutation Signup($username: String!, $password: String!) {
    signup(username: $username, password: $password) { token }
  }
`;

const QUOTE = `
  query {
    cloudHostBillingQuote {
      createCredits
      perMinuteCredits
      availableBalance
    }
  }
`;

describe.skipIf(!ENABLED)('Cloud Host Billing Quote API', () => {
  it('T-CH-API-B4: 报价返回创建 5 credits / 运行 1 credit/分钟', async () => {
    const username = `cq${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`;
    const signup = await gql(SIGNUP, { username, password: 'password123' });
    const result = await gql(QUOTE, undefined, signup.data.signup.token);
    expect(result.errors).toBeUndefined();
    expect(result.data.cloudHostBillingQuote).toMatchObject({
      createCredits: 5,
      perMinuteCredits: 1,
    });
  });
});
