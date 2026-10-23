import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';

const h = vi.hoisted(() => ({
  config: { eventCallbackToken: 'test-event-token', githubWebhookSecret: 'test-webhook-secret' },
}));

vi.mock('../config/index.js', () => ({ config: h.config }));

vi.mock('../services/workflow/pr-event-handler.js', () => ({
  handlePullRequestEvent: vi.fn(),
}));

import { eventCallbackRouter } from './event-callback.js';
import { handlePullRequestEvent } from '../services/workflow/pr-event-handler.js';

const PATH = '/api/events/callback';
const body = {
  eventType: 'pull_request',
  eventId: 'evt-1',
  payload: { pullRequestId: 'a/b#1', reviewState: 'approved' },
};
const raw = JSON.stringify(body);

describe('POST /api/events/callback', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    h.config.eventCallbackToken = 'test-event-token';
    h.config.githubWebhookSecret = 'test-webhook-secret';
    vi.mocked(handlePullRequestEvent).mockResolvedValue({
      handled: true,
      results: [{ action: 'COMPLETE_HUMAN_NODE' }],
    } as never);

    const app = express();
    app.use('/api', eventCallbackRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function post(headers: Record<string, string> = {}, payload = raw) {
    return fetch(`${baseUrl}${PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: payload,
    });
  }

  function signature(secret = 'test-webhook-secret') {
    return 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  }

  it('无凭据 401；错误 token 401', async () => {
    expect((await post()).status).toBe(401);
    expect((await post({ 'X-Event-Token': 'wrong' })).status).toBe(401);
    expect(handlePullRequestEvent).not.toHaveBeenCalled();
  });

  it('两个密钥都未配置时一律 401', async () => {
    h.config.eventCallbackToken = '';
    h.config.githubWebhookSecret = '';
    expect((await post({ 'X-Event-Token': 'anything' })).status).toBe(401);
  });

  it('X-Event-Token 通过', async () => {
    const res = await post({ 'X-Event-Token': 'test-event-token' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ handled: true });
  });

  it('Authorization Bearer 通过', async () => {
    const res = await post({ Authorization: 'Bearer test-event-token' });
    expect(res.status).toBe(200);
  });

  it('HMAC 正确 200 / 错误 401', async () => {
    expect((await post({ 'X-Hub-Signature-256': signature() })).status).toBe(200);
    expect(
      (await post({ 'X-Hub-Signature-256': signature('other-secret') })).status,
    ).toBe(401);
  });

  it('载荷非法 400 并带 detail', async () => {
    const res = await post({ 'X-Event-Token': 'test-event-token' }, '{"eventType":"pull_request"}');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'payload.invalid', detail: 'eventId' });
    expect(handlePullRequestEvent).not.toHaveBeenCalled();
  });

  it('200 透传 results', async () => {
    const res = await post({ 'X-Event-Token': 'test-event-token' });
    expect(await res.json()).toEqual({
      handled: true,
      results: [{ action: 'COMPLETE_HUMAN_NODE' }],
    });
  });
});
