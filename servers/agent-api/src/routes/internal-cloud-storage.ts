import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { logger as rootLogger } from '../observability/logger.js';
import { cloudStorageService } from '../services/cloud-storage-service.js';

const logger = rootLogger.child({ component: 'internal-cloud-storage' });

function authorized(req: Request): boolean {
  if (!config.internalApiToken) return false;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${config.internalApiToken}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * cloud-controller → agent-api 云存储回调：
 * - POST /internal/cloud-storages/:storageId/archives
 * - POST /internal/cloud-storages/:storageId/usage
 *
 * Bearer INTERNAL_API_TOKEN；按 archiveId 幂等、终态单调（SUCCEEDED 后迟到事件忽略）。
 */
export const internalCloudStorageRouter = Router();

internalCloudStorageRouter.use((req: Request, res: Response, next) => {
  if (!authorized(req)) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }
  next();
});

function parseArchiveBody(body: unknown): {
  archiveId: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  extra: Record<string, unknown>;
} | null {
  if (!body || typeof body !== 'object') return null;
  const value = body as Record<string, unknown>;
  const archiveId = typeof value.archiveId === 'string' ? value.archiveId.trim() : '';
  const status = value.status;
  if (!archiveId) return null;
  if (status !== 'RUNNING' && status !== 'SUCCEEDED' && status !== 'FAILED') return null;
  return {
    archiveId,
    status,
    extra: {
      storageId: typeof value.storageId === 'string' ? value.storageId : undefined,
      cloudHostId: typeof value.cloudHostId === 'string' ? value.cloudHostId : null,
      containerId: typeof value.containerId === 'string' ? value.containerId : null,
      cloudHostName: typeof value.cloudHostName === 'string' ? value.cloudHostName : null,
      fileName: typeof value.fileName === 'string' ? value.fileName : null,
      path: typeof value.path === 'string' ? value.path : null,
      usageBytes: typeof value.usageBytes === 'number' ? value.usageBytes : null,
      startedAt: typeof value.startedAt === 'string' ? value.startedAt : null,
      finishedAt: typeof value.finishedAt === 'string' ? value.finishedAt : null,
      failureReason: typeof value.failureReason === 'string' ? value.failureReason : null,
    },
  };
}

internalCloudStorageRouter.post(
  '/:storageId/archives',
  async (req: Request, res: Response) => {
    const storageId = String(req.params.storageId);
    if (!mongoose.isValidObjectId(storageId)) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    const parsed = parseArchiveBody(req.body);
    if (!parsed) {
      res.status(400).json({ error: 'INVALID_BODY' });
      return;
    }
    try {
      const result = await cloudStorageService.handleArchiveCallback(storageId, {
        archiveId: parsed.archiveId,
        status: parsed.status,
        ...(parsed.extra as object),
      });
      if (!result) {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error(
        { event: 'archive-callback-failed', storageId, err },
        'cloud storage archive callback failed',
      );
      res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  },
);

internalCloudStorageRouter.post('/:storageId/usage', async (req: Request, res: Response) => {
  const storageId = String(req.params.storageId);
  if (!mongoose.isValidObjectId(storageId)) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }
  const usageBytes = req.body?.usageBytes;
  if (typeof usageBytes !== 'number' || !Number.isFinite(usageBytes) || usageBytes < 0) {
    res.status(400).json({ error: 'INVALID_BODY' });
    return;
  }
  try {
    const result = await cloudStorageService.handleUsageCallback(storageId, {
      usageBytes,
      measuredAt: typeof req.body?.measuredAt === 'string' ? req.body.measuredAt : null,
    });
    if (!result) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error(
      { event: 'usage-callback-failed', storageId, err },
      'cloud storage usage callback failed',
    );
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});
