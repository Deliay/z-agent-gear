import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';

const h = vi.hoisted(() => ({
  config: { githubWebhookSecret: 'test-webhook-secret' },
}));

vi.mock('../config/index.js', () => ({ config: h.config }));

vi.mock('../services/workflow/pr-event-handler.js', () => ({
  handlePullRequestEvent: vi.fn(),
}));

import { githubWebhookRouter } from './github-webhook.js';
import { handlePullRequestEvent } from '../services/workflow/pr-event-handler.js';

const PATH = '/api/events/github/webhook';
const body = {
  action: 'submitted',
  review: {
    id: 987654321,
    state: 'approved',
    body: 'LGTM',
    user: { login: 'z-agent-bot' },
    submitted_at: '2026-10-25T06:00:00Z',
  },
  repository: { full_name: 'Deliay/z-agent-gear' },
  pull_request: { number: 264, html_url: 'https://github.com/Deliay/z-agent-gear/pull/264' },
};
const raw = JSON.stringify(body);

describe('POST /api/events/github/webhook', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    h.config.githubWebhookSecret = 'test-webhook-secret';
    vi.mocked(handlePullRequestEvent).mockResolvedValue({
      handled: true,
      results: [{ action: 'COMPLETE_HUMAN_NODE' }],
    } as never);

    const app = express();
    app.use('/api', githubWebhookRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function post(headers: Record<string, string> = {}, payload: string = raw) {
    return fetch(`${baseUrl}${PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request_review',
        ...headers,
      },
      body: payload,
    });
  }

  function signature(payload: string = raw, secret = 'test-webhook-secret') {
    return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
  }

  function signed(headers: Record<string, string> = {}, payload: string = raw) {
    return post({ 'X-Hub-Signature-256': signature(payload), ...headers }, payload);
  }

  it('无签名 / 错误签名 / 非 sha256 前缀 401', async () => {
    expect((await post()).status).toBe(401);
    expect((await post({ 'X-Hub-Signature-256': signature(raw, 'other-secret') })).status).toBe(401);
    expect((await post({ 'X-Hub-Signature-256': 'md5=abc' })).status).toBe(401);
    expect(handlePullRequestEvent).not.toHaveBeenCalled();
  });

  it('平台回调凭据在该路径不生效（仅 GitHub 验签）', async () => {
    expect((await post({ 'X-Event-Token': 'whatever' })).status).toBe(401);
  });

  it('GITHUB_WEBHOOK_SECRET 未配置时一律 401', async () => {
    h.config.githubWebhookSecret = '';
    expect((await signed()).status).toBe(401);
  });

  it('非 JSON Content-Type 400', async () => {
    const res = await post(
      { 'Content-Type': 'text/plain', 'X-Hub-Signature-256': signature() },
      raw,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'payload.invalid', detail: 'content-type' });
  });

  it('ping / 其他事件类型 200 UNSUPPORTED_EVENT 且不调用处理器', async () => {
    for (const eventName of ['ping', 'push', 'pull_request']) {
      const res = await signed({ 'X-GitHub-Event': eventName });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        handled: false,
        reason: 'UNSUPPORTED_EVENT',
        results: [],
      });
    }
    expect(handlePullRequestEvent).not.toHaveBeenCalled();
  });

  it('非 submitted action 200 UNSUPPORTED_EVENT 且不调用处理器', async () => {
    const edited = JSON.stringify({ ...body, action: 'edited' });
    const res = await signed({}, edited);
    expect(await res.json()).toEqual({
      handled: false,
      reason: 'UNSUPPORTED_EVENT',
      results: [],
    });
    expect(handlePullRequestEvent).not.toHaveBeenCalled();
  });

  it('载荷非法 400 并带 detail', async () => {
    const invalid = JSON.stringify({ ...body, review: { ...body.review, state: '' } });
    const res = await signed({}, invalid);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'payload.invalid', detail: 'review.state' });
    expect(handlePullRequestEvent).not.toHaveBeenCalled();
  });

  it('归一化后调用处理器：eventId 为 review.id，字段逐项映射', async () => {
    const res = await signed();
    expect(res.status).toBe(200);
    expect(handlePullRequestEvent).toHaveBeenCalledWith({
      eventType: 'pull_request',
      eventId: 'gh:pull_request_review:987654321',
      occurredAt: '2026-10-25T06:00:00Z',
      payload: {
        pullRequestId: 'Deliay/z-agent-gear#264',
        reviewState: 'approved',
        action: 'reviewed',
        prUrl: 'https://github.com/Deliay/z-agent-gear/pull/264',
        comment: 'LGTM',
        reviewer: 'z-agent-bot',
        submittedAt: '2026-10-25T06:00:00Z',
      },
    });
  });

  it('200 透传处理器结果', async () => {
    const res = await signed();
    expect(await res.json()).toEqual({
      handled: true,
      results: [{ action: 'COMPLETE_HUMAN_NODE' }],
    });
  });

  it('处理器抛错返回 200 HANDLER_FAILED（避免 GitHub 重投风暴）', async () => {
    vi.mocked(handlePullRequestEvent).mockRejectedValue(new Error('db down'));
    const res = await signed();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      handled: false,
      reason: 'HANDLER_FAILED',
      results: [],
    });
  });
});
