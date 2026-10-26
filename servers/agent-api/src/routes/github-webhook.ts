import express, { type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config/index.js';
import {
  parseGithubReviewEvent,
  GithubWebhookPayloadError,
} from '../services/workflow/github-webhook-payload.js';
import { handlePullRequestEvent } from '../services/workflow/pr-event-handler.js';
import { parseGithubIssuesEvent } from '../services/workflow/github-issues-webhook-payload.js';
import { handleIssuesEvent } from '../services/workflow/issues-event-handler.js';

export const githubWebhookRouter = express.Router();

function timingSafeEquals(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const UNSUPPORTED_EVENT = { handled: false, reason: 'UNSUPPORTED_EVENT', results: [] };

/**
 * GitHub 原生 webhook 验签：仅接受 X-Hub-Signature-256（HMAC-SHA256，
 * GITHUB_WEBHOOK_SECRET）。GitHub webhook 无法携带平台回调凭据，
 * 该路径不接受 X-Event-Token；密钥未配置时一律拒绝（默认拒绝）。
 */
function isAuthorized(req: Request): boolean {
  const signature = req.header('x-hub-signature-256');
  if (!signature || !signature.startsWith('sha256=')) return false;
  if (!config.githubWebhookSecret || !Buffer.isBuffer(req.body)) return false;
  const expected =
    'sha256=' +
    createHmac('sha256', config.githubWebhookSecret).update(req.body).digest('hex');
  return timingSafeEquals(signature, expected);
}

githubWebhookRouter.post(
  '/events/github/webhook',
  express.raw({ type: 'application/json', limit: '1mb' }),
  async (req: Request, res: Response) => {
    if (!Buffer.isBuffer(req.body)) {
      // express.raw 只对匹配的 Content-Type 生效；缺失/错误时为 {} 或 undefined
      res.status(400).json({ error: 'payload.invalid', detail: 'content-type' });
      return;
    }

    if (!isAuthorized(req)) {
      console.warn('[github-webhook] unauthorized');
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    // issues 事件：独立分支，与 pull_request_review 判定链互不干扰
    if (req.header('x-github-event') === 'issues') {
      let issuesEvent;
      try {
        issuesEvent = parseGithubIssuesEvent(req.body);
      } catch (err) {
        const detail = err instanceof GithubWebhookPayloadError ? err.detail : 'body';
        res.status(400).json({ error: 'payload.invalid', detail });
        return;
      }
      if (issuesEvent === null) {
        res.json(UNSUPPORTED_EVENT);
        return;
      }
      try {
        res.json(await handleIssuesEvent(issuesEvent));
      } catch (err) {
        console.error('[github-webhook] issues handler failed:', (err as Error).message);
        res.json({ handled: false, reason: 'HANDLER_FAILED', results: [] });
      }
      return;
    }

    // ping / 非 pull_request_review 事件：安全忽略
    if (req.header('x-github-event') !== 'pull_request_review') {
      res.json(UNSUPPORTED_EVENT);
      return;
    }

    let event;
    try {
      event = parseGithubReviewEvent(req.body);
    } catch (err) {
      const detail = err instanceof GithubWebhookPayloadError ? err.detail : 'body';
      res.status(400).json({ error: 'payload.invalid', detail });
      return;
    }
    // 非 submitted action（edited / dismissed 由 review.state 承载等）：安全忽略
    if (event === null) {
      res.json(UNSUPPORTED_EVENT);
      return;
    }

    try {
      const response = await handlePullRequestEvent(event);
      res.json(response);
    } catch (err) {
      // 保持 200：5xx 会触发 GitHub 指数退避重投风暴，幂等位可安全消化重投
      console.error('[github-webhook] handler failed:', (err as Error).message);
      res.json({ handled: false, reason: 'HANDLER_FAILED', results: [] });
    }
  },
);
