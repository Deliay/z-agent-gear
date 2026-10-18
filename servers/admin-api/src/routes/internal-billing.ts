import { Router, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { BillingInvoice } from '../models/billing-invoice.js';
import { BillingReceipt } from '../models/billing-receipt.js';
import { BillingApiCall } from '../models/billing-api-call.js';
import { accountService } from '../services/billing/account-service.js';
import { apiKeyService } from '../services/billing/api-key-service.js';
import {
  toBillingAccountWire,
  toBillingApiCall,
  toBillingInvoice,
  toBillingReceipt,
  toBillingRollup,
} from '../services/billing/mappers.js';
import { rollupService, type RollupGranularity } from '../services/billing/rollup-service.js';

function authorized(req: Request): boolean {
  if (!config.internalApiToken) return false;
  const header = req.headers.authorization;
  return header === `Bearer ${config.internalApiToken}`;
}

function toDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** `/internal/billing/*`：仅供 agent-api 调用（Bearer INTERNAL_API_TOKEN）。 */
export function createInternalBillingRouter(): Router {
  const router = Router();

  router.use((req: Request, res: Response, next) => {
    if (!authorized(req)) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }
    next();
  });

  router.get('/account', async (req: Request, res: Response) => {
    const ownerType = req.query.ownerType;
    const ownerId = req.query.ownerId;
    if (
      (ownerType !== 'front_user' && ownerType !== 'admin_user') ||
      typeof ownerId !== 'string' ||
      !ownerId
    ) {
      res.status(400).json({ error: 'INVALID_OWNER' });
      return;
    }
    try {
      const account = await accountService.getOrCreate(
        ownerType,
        ownerId,
        typeof req.query.ownerName === 'string' ? req.query.ownerName : undefined,
      );
      res.json(toBillingAccountWire(account));
    } catch (err) {
      res.status(500).json({ error: 'INTERNAL_ERROR', message: (err as Error).message });
    }
  });

  router.get('/invoices', async (req: Request, res: Response) => {
    const accountId = String(req.query.accountId ?? '');
    if (!mongoose.isValidObjectId(accountId)) {
      res.status(400).json({ error: 'INVALID_ACCOUNT' });
      return;
    }
    const page = Math.max(1, Number(req.query.page ?? 1) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize ?? 50) || 50));
    const filter: Record<string, unknown> = { accountId };
    if (typeof req.query.type === 'string') filter.type = req.query.type;
    if (typeof req.query.category === 'string') filter.category = req.query.category;
    const from = toDate(req.query.from);
    const to = toDate(req.query.to);
    if (from || to) {
      filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    }
    const docs = await BillingInvoice.find(filter)
      .sort({ seq: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean();
    res.json(docs.map((doc) => toBillingInvoice(doc as never)));
  });

  router.get('/receipts', async (req: Request, res: Response) => {
    const accountId = String(req.query.accountId ?? '');
    if (!mongoose.isValidObjectId(accountId)) {
      res.status(400).json({ error: 'INVALID_ACCOUNT' });
      return;
    }
    const page = Math.max(1, Number(req.query.page ?? 1) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize ?? 50) || 50));
    const filter: Record<string, unknown> = { accountId };
    if (typeof req.query.invoiceId === 'string' && req.query.invoiceId) {
      // 非法 ObjectId 视为「无匹配收据」而非抛 CastError（保持对外 200 + []，避免 500/堆栈泄露）
      if (!mongoose.isValidObjectId(req.query.invoiceId)) {
        res.json([]);
        return;
      }
      filter.invoiceId = req.query.invoiceId;
    }
    const docs = await BillingReceipt.find(filter)
      .sort({ issuedAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean();
    res.json(docs.map((doc) => toBillingReceipt(doc as never)));
  });

  router.get('/api-calls', async (req: Request, res: Response) => {
    const accountId = String(req.query.accountId ?? '');
    if (!mongoose.isValidObjectId(accountId)) {
      res.status(400).json({ error: 'INVALID_ACCOUNT' });
      return;
    }
    const page = Math.max(1, Number(req.query.page ?? 1) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize ?? 50) || 50));
    const filter: Record<string, unknown> = { accountId };
    if (typeof req.query.status === 'string' && req.query.status) filter.status = req.query.status;
    const docs = await BillingApiCall.find(filter)
      .sort({ startedAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean();
    res.json(docs.map((doc) => toBillingApiCall(doc as never)));
  });

  router.get('/rollups', async (req: Request, res: Response) => {
    const accountId = String(req.query.accountId ?? '');
    const granularity = String(req.query.granularity ?? '') as RollupGranularity;
    const from = toDate(req.query.from);
    const to = toDate(req.query.to);
    if (
      !mongoose.isValidObjectId(accountId) ||
      !['minute', 'hour', 'day'].includes(granularity) ||
      !from ||
      !to
    ) {
      res.status(400).json({ error: 'INVALID_QUERY' });
      return;
    }
    const buckets = await rollupService.query(accountId, granularity, from, to);
    res.json(buckets.map((bucket) => toBillingRollup(bucket as never)));
  });

  router.get('/api-keys', async (req: Request, res: Response) => {
    const ownerType = req.query.ownerType;
    const ownerId = req.query.ownerId;
    if (
      (ownerType !== 'front_user' && ownerType !== 'admin_user') ||
      typeof ownerId !== 'string'
    ) {
      res.status(400).json({ error: 'INVALID_OWNER' });
      return;
    }
    const keys = await apiKeyService.list(ownerType, ownerId);
    res.json(
      keys.map((key) => ({
        ...key,
        lastUsedAt: key.lastUsedAt ? key.lastUsedAt.toISOString() : null,
        createdAt: key.createdAt.toISOString(),
      })),
    );
  });

  router.post('/api-keys', async (req: Request, res: Response) => {    const { ownerType, ownerId, name } = req.body ?? {};
    if (
      (ownerType !== 'front_user' && ownerType !== 'admin_user') ||
      typeof ownerId !== 'string' ||
      typeof name !== 'string'
    ) {
      res.status(400).json({ error: 'INVALID_BODY' });
      return;
    }
    try {
      const account = await accountService.getOrCreate(ownerType, ownerId);
      const created = await apiKeyService.create({
        accountId: account.id,
        ownerType,
        ownerId,
        name,
      });
      res.status(201).json({
        apiKey: {
          ...created.apiKey,
          createdAt: created.apiKey.createdAt.toISOString(),
          lastUsedAt: created.apiKey.lastUsedAt?.toISOString() ?? null,
        },
        secret: created.secret,
      });
    } catch (err) {
      res.status(400).json({ error: 'CREATE_FAILED', message: (err as Error).message });
    }
  });

  router.delete('/api-keys/:id', async (req: Request, res: Response) => {
    const ownerType = req.query.ownerType;
    const ownerId = req.query.ownerId;
    if (
      (ownerType !== 'front_user' && ownerType !== 'admin_user') ||
      typeof ownerId !== 'string'
    ) {
      res.status(400).json({ error: 'INVALID_OWNER' });
      return;
    }
    try {
      const revoked = await apiKeyService.revoke(String(req.params.id), { ownerType, ownerId });
      res.json({ success: true, apiKey: revoked });
    } catch (err) {
      res.status(404).json({ error: 'NOT_FOUND', message: (err as Error).message });
    }
  });

  return router;
}
