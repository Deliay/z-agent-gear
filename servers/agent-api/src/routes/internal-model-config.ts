import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { logger as rootLogger } from '../observability/logger.js';
import { applyGlobalModelRefresh } from '../services/cloud-host-model-push.js';

const logger = rootLogger.child({ component: 'internal-model-config' });

function authorized(req: Request): boolean {
  if (!config.internalApiToken) return false;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${config.internalApiToken}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * admin-api → agent-api 内部端点：全局模型/供应商变更后触发全量下发。
 *
 * - `POST /internal/model-config/refresh`：Bearer `INTERNAL_API_TOKEN`；
 * - body `{ scope: 'global' }`（其它/非法 → 400 `INVALID_SCOPE`）；
 * - 立即 202 `{accepted:true}`，`setImmediate` 后执行全量推送 + ACP 全量失效（fire-and-forget）。
 *   推送异常不影响响应（内部 catch + warn）。
 */
export const internalModelConfigRouter = Router();

internalModelConfigRouter.post('/refresh', (req: Request, res: Response) => {
  if (!authorized(req)) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }
  if (req.body?.scope !== 'global') {
    res.status(400).json({ error: 'INVALID_SCOPE' });
    return;
  }
  res.status(202).json({ accepted: true });
  setImmediate(() => {
    applyGlobalModelRefresh().catch((err) => {
      logger.warn({ err }, 'global model refresh failed');
    });
  });
});
