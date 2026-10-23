import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';

/**
 * 工作流 GitHub Pull Request 联动 —— 事件回调黑盒用例（T-PR1 ~ T-PR3）。
 *
 * 需要 agent-api 与 EVENT_CALLBACK_TOKEN 就绪；缺失时整套跳过。
 * 回调 URL 为 agent-api REST 端点（非 GraphQL）。
 */
const API_BASE = (process.env.API_URL || 'http://localhost:4000/graphql').replace(/\/graphql$/, '');
const EVENT_TOKEN = process.env.EVENT_CALLBACK_TOKEN ?? '';
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? '';

const callbackUrl = `${API_BASE}/api/events/callback`;

function payload(overrides: Record<string, unknown> = {}) {
  return {
    eventType: 'pull_request',
    eventId: `gh:test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    payload: {
      pullRequestId: 'Deliay/z-agent-gear#264',
      prUrl: 'https://github.com/Deliay/z-agent-gear/pull/264',
      reviewState: 'approved',
      comment: 'LGTM',
      reviewer: 'z-agent-bot',
      submittedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return fetch(callbackUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe.skipIf(!EVENT_TOKEN)('工作流 PR 事件回调（T-PR1~T-PR3）', () => {
  it('T-PR1 鉴权：无凭据/错误 token 401，正确 token 200', async () => {
    expect((await post(payload())).status).toBe(401);
    expect((await post(payload(), { 'X-Event-Token': 'wrong-token' })).status).toBe(401);

    const ok = await post(payload(), { 'X-Event-Token': EVENT_TOKEN });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body).toHaveProperty('handled');
    expect(body).toHaveProperty('results');
  });

  it('T-PR1 Authorization Bearer 与 HMAC 验签', async () => {
    const bearer = await post(payload(), { Authorization: `Bearer ${EVENT_TOKEN}` });
    expect(bearer.status).toBe(200);

    if (WEBHOOK_SECRET) {
      const raw = JSON.stringify(payload());
      const signature =
        'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
      expect((await post(raw, { 'X-Hub-Signature-256': signature })).status).toBe(200);
      expect(
        (await post(raw, { 'X-Hub-Signature-256': 'sha256=deadbeef' })).status,
      ).toBe(401);
    }
  });

  it('T-PR2 载荷非法 400 且带 detail', async () => {
    const res = await post('{"eventType":"pull_request"}', { 'X-Event-Token': EVENT_TOKEN });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'payload.invalid', detail: 'eventId' });

    const unsupported = await post(
      payload({ eventType: 'push' }),
      { 'X-Event-Token': EVENT_TOKEN },
    );
    expect(unsupported.status).toBe(400);
  });

  it('T-PR3 未登记 PR 返回 NO_HANDLER', async () => {
    const res = await post(
      payload({
        payload: {
          pullRequestId: 'unknown-owner/unknown-repo#999999',
          reviewState: 'approved',
        },
      }),
      { 'X-Event-Token': EVENT_TOKEN },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handled: false, reason: 'NO_HANDLER', results: [] });
  });
});
