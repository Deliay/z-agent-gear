import express, { type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config/index.js';
import { logger as rootLogger } from '../observability/logger.js';
import { parseEventCallbackPayload, EventPayloadError } from '../services/workflow/pr-event-payload.js';
import { handlePullRequestEvent } from '../services/workflow/pr-event-handler.js';

export const eventCallbackRouter = express.Router();

const logger = rootLogger.child({ component: 'event-callback' });

function timingSafeEquals(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * 鉴权（任一通过即放行）：
 * - X-Event-Token 或 Authorization: Bearer 与 EVENT_CALLBACK_TOKEN 等长比较；
 * - X-Hub-Signature-256 对原始字节做 HMAC-SHA256（GITHUB_WEBHOOK_SECRET）。
 * 两者都未配置时一律拒绝（默认拒绝，无「无鉴权放行」）。
 */
function isAuthorized(req: Request): boolean {
  // C-5：空 X-Event-Token 不得遮蔽有效的 Bearer（`??` 只跳过 null/undefined）
  const providedToken =
    req.header('x-event-token') || bearerToken(req.header('authorization'));
  if (providedToken && config.eventCallbackToken) {
    if (timingSafeEquals(providedToken, config.eventCallbackToken)) return true;
  }

  const signature = req.header('x-hub-signature-256');
  if (signature && config.githubWebhookSecret && Buffer.isBuffer(req.body)) {
    const expected =
      'sha256=' + createHmac('sha256', config.githubWebhookSecret).update(req.body).digest('hex');
    if (timingSafeEquals(signature, expected)) return true;
  }
  return false;
}

eventCallbackRouter.post(
  '/events/callback',
  express.raw({ type: 'application/json', limit: '1mb' }),
  async (req: Request, res: Response) => {
    if (!isAuthorized(req)) {
      logger.warn({ event: 'unauthorized' }, 'unauthorized event callback');
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    if (!Buffer.isBuffer(req.body)) {
      // express.raw 只对匹配的 Content-Type 生效；缺失/错误时为 {} 或 undefined
      res.status(400).json({ error: 'payload.invalid', detail: 'content-type' });
      return;
    }

    let event;
    try {
      event = parseEventCallbackPayload(req.body);
    } catch (err) {
      const detail = err instanceof EventPayloadError ? err.detail : 'body';
      res.status(400).json({ error: 'payload.invalid', detail });
      return;
    }

    try {
      const response = await handlePullRequestEvent(event);
      res.json(response);
    } catch (err) {
      logger.error({ err }, 'event handler failed');
      res.json({ handled: false, reason: 'HANDLER_FAILED', results: [] });
    }
  },
);
