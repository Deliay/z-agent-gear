import { describe, it, expect } from 'vitest';

const API_URL = process.env.API_URL || 'http://localhost:4000/graphql';

function gqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
}

// 前台费用转发依赖 admin-api（ADMIN_API_URL + INTERNAL_API_TOKEN）；未配置时跳过（保持 CI 绿灯）
const hasBillingBackend = !!process.env.ADMIN_API_URL;

const SIGNUP = `
  mutation Signup($username: String!, $password: String!) {
    signup(username: $username, password: $password) { token user { id username } }
  }
`;

const MY_ACCOUNT = `
  query {
    myBillingAccount {
      id ownerType ownerName cashBalance giftBalance creditLimit frozenAmount availableBalance status ledgerCount
    }
  }
`;

const MY_KEYS = `
  query {
    myBillingApiKeys { id name keyPrefix status lastUsedAt createdAt }
  }
`;

const MY_CALLS = `
  query { myBillingApiCalls(page: 1, pageSize: 5) { id requestId status estimated cost } }
`;

const MY_RECEIPT = `
  query Receipt($invoiceId: ID!) { myBillingReceipt(invoiceId: $invoiceId) { id receiptNo invoiceId } }
`;

const CREATE_KEY = `
  mutation CreateMyBillingApiKey($name: String!) {
    createMyBillingApiKey(name: $name) { apiKey { id keyPrefix status } secret }
  }
`;

const REVOKE_KEY = `
  mutation RevokeMyBillingApiKey($id: ID!) {
    revokeMyBillingApiKey(id: $id) { id status }
  }
`;

(hasBillingBackend ? describe : describe.skip)('Agent Billing API', () => {
  it('T-A1/A3/A4/A5: 前台账户 get-or-create、Key 一次性 secret、无自助充值', async () => {
    const signup = await gqlRequest(SIGNUP, {
      username: `b${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`,
      password: 'password123',
    }).then((res) => res.json() as Promise<{ data: { signup: { token: string } } }>);
    const token = signup.data.signup.token;

    const account = await gqlRequest(MY_ACCOUNT, undefined, token).then((res) => res.json());
    expect(account.errors).toBeUndefined();
    expect(account.data.myBillingAccount.ownerType).toBe('front_user');
    expect(typeof account.data.myBillingAccount.availableBalance).toBe('number');

    const created = await gqlRequest(CREATE_KEY, { name: 'my-key' }, token).then((res) => res.json());
    expect(created.errors).toBeUndefined();
    expect(created.data.createMyBillingApiKey.secret).toMatch(/^zag_sk_[0-9a-f]+$/);
    const keyId = created.data.createMyBillingApiKey.apiKey.id;

    const calls = await gqlRequest(MY_CALLS, undefined, token).then((res) => res.json());
    expect(calls.errors).toBeUndefined();

    // 收据按 invoiceId 直查（弹窗不再依赖列表分页）：无对应收据时返回 null 而非报错
    const receipt = await gqlRequest(MY_RECEIPT, { invoiceId: '000000000000000000000000' }, token).then(
      (res) => res.json(),
    );
    expect(receipt.errors).toBeUndefined();
    expect(receipt.data.myBillingReceipt).toBeNull();

    const keys = await gqlRequest(MY_KEYS, undefined, token).then((res) => res.json());
    expect(keys.data.myBillingApiKeys.some((key: { id: string }) => key.id === keyId)).toBe(true);

    const revoked = await gqlRequest(REVOKE_KEY, { id: keyId }, token).then((res) => res.json());
    expect(revoked.data.revokeMyBillingApiKey.status).toBe('revoked');

    // 前台无自助充值入口：schema 中不存在充值 mutation
    const introspect = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: '{ __schema { mutationType { fields { name } } } }',
      }),
    }).then((res) => res.json());
    const names: string[] = introspect.data.__schema.mutationType.fields.map(
      (field: { name: string }) => field.name,
    );
    expect(names.some((name) => /recharge/i.test(name))).toBe(false);
  });

  it('T-A5: 未认证访问返回 UNAUTHENTICATED', async () => {
    const res = await gqlRequest(MY_ACCOUNT).then((r) => r.json());
    expect(res.errors?.[0]?.message).toContain('Not authenticated');
  });
});
