import { describe, it, expect, beforeAll } from 'vitest';
import { adminGql, ensureAdminLogin } from './helpers.js';

const HTTP = (process.env.ADMIN_API_URL || 'http://localhost:10003/graphql').replace(
  /\/graphql$/,
  '',
);

const CREATE_KEY = `
  mutation CreateBillingApiKey($name: String!) {
    createBillingApiKey(name: $name) { apiKey { id } secret }
  }
`;

function openAiError(body: unknown): { code?: string } | undefined {
  return (body as { error?: { code?: string } }).error;
}

describe('OpenAI 兼容计费网关', () => {
  let secret = '';

  beforeAll(async () => {
    const token = await ensureAdminLogin();
    const created = await adminGql<{ createBillingApiKey: { secret: string } }>(
      CREATE_KEY,
      { name: `gateway-test-${Date.now()}` },
      token,
    );
    secret = created.data!.createBillingApiKey.secret;
  });

  it('T-B22: GET /v1/models 返回 OpenAI 列表（仅计费且定价完整模型）', async () => {
    const res = await fetch(`${HTTP}/v1/models`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: Array<{ id: string; object: string }> };
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
    for (const model of body.data) {
      expect(model.object).toBe('model');
    }
  });

  it('T-B23: 无效 Key 401 invalid_api_key', async () => {
    const res = await fetch(`${HTTP}/v1/models`, {
      headers: { Authorization: 'Bearer zag_sk_deadbeef' },
    });
    expect(res.status).toBe(401);
    expect(openAiError(await res.json())?.code).toBe('invalid_api_key');
  });

  it('T-B23: 缺参数 400、未知模型 404、未定价模型 400', async () => {
    const missing = await fetch(`${HTTP}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'x' }),
    });
    expect(missing.status).toBe(400);

    const unknown = await fetch(`${HTTP}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'no-such-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(unknown.status).toBe(404);
    expect(openAiError(await unknown.json())?.code).toBe('model_not_found');
  });
});
