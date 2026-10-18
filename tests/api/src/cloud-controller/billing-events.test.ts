import { describe, it, expect } from 'vitest';

const CLOUD_URL = process.env.CLOUD_CONTROLLER_URL || 'http://localhost:10004';
const TOKEN = process.env.INTERNAL_API_TOKEN || '';

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
}

(TOKEN ? describe : describe.skip)('cloud-controller 计费字段与强拆原因', () => {
  it('T-CC-B4/B8: 创建容器携带 billingAccountId，A.3 透出计费字段', async () => {
    const created = await fetch(`${CLOUD_URL}/internal/containers`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ purpose: 'idle', billingAccountId: 'acct-e2e' }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      id: string;
      billingAccountId: string | null;
      billingStartedAt: string | null;
    };
    expect(body.billingAccountId).toBe('acct-e2e');
    expect(body.billingStartedAt).toBeNull();

    const list = await fetch(`${CLOUD_URL}/internal/containers`, { headers: authHeaders() });
    const items = (await list.json()) as Array<{ id: string; billingAccountId: string | null }>;
    expect(items.find((item) => item.id === body.id)?.billingAccountId).toBe('acct-e2e');
  });

  it('T-CC-B7: DELETE 带 reason 写入 exitReason', async () => {
    const created = await fetch(`${CLOUD_URL}/internal/containers`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ purpose: 'idle' }),
    });
    const body = (await created.json()) as { id: string };
    const reason = '余额不足超过 10 分钟，强制销毁';
    const res = await fetch(
      `${CLOUD_URL}/internal/containers/${body.id}?reason=${encodeURIComponent(reason)}`,
      { method: 'DELETE', headers: authHeaders() },
    );
    expect(res.status).toBe(200);

    const list = await fetch(`${CLOUD_URL}/internal/containers`, { headers: authHeaders() });
    const items = (await list.json()) as Array<{ id: string; exitReason: string | null }>;
    expect(items.find((item) => item.id === body.id)?.exitReason).toBe(reason);
  });
});
