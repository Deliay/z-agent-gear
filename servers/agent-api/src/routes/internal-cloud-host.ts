import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { cloudHostService } from '../services/cloud-host-service.js';

function authorized(req: Request): boolean {
  if (!config.internalApiToken) return false;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${config.internalApiToken}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * cloud-controller → agent-api 内部回调：
 * - POST /internal/cloud-hosts/:id/ready
 * - POST /internal/cloud-hosts/:id/terminal
 *
 * Bearer INTERNAL_API_TOKEN；幂等；未知/非 harness 云电脑返回 404。
 */
export const internalCloudHostRouter = Router();

internalCloudHostRouter.use((req: Request, res: Response, next) => {
  if (!authorized(req)) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }
  next();
});

async function findHarnessHost(id: string, res: Response): Promise<Record<string, unknown> | Response> {
  const host = await cloudHostService.findRawHost(id);
  if (!host || !Array.isArray(host.harnessTypes) || host.harnessTypes.length === 0) {
    return res.status(404).json({ error: 'NOT_FOUND' });
  }
  return host;
}

internalCloudHostRouter.post('/:id/ready', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const host = await findHarnessHost(id, res);
    if (host === res) return;
    const result = await cloudHostService.handleReady(id);
    res.json(result);
  } catch (err) {
    console.error('[internal-cloud-host] ready failed', (err as Error).message);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

internalCloudHostRouter.post('/:id/terminal', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const host = await findHarnessHost(id, res);
    if (host === res) return;
    const status = req.body?.status;
    if (status !== 'stopped' && status !== 'failed') {
      res.status(400).json({ error: 'INVALID_BODY' });
      return;
    }
    const result = await cloudHostService.handleTerminal(id, {
      status,
      reason: typeof req.body?.reason === 'string' ? req.body.reason : undefined,
    });
    res.json(result);
  } catch (err) {
    console.error('[internal-cloud-host] terminal failed', (err as Error).message);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});
