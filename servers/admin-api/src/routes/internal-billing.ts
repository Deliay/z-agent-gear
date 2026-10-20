import { Router, type NextFunction, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { BillingInvoice } from '../models/billing-invoice.js';
import { BillingLedger } from '../models/billing-ledger.js';
import { BillingReceipt } from '../models/billing-receipt.js';
import { BillingApiCall } from '../models/billing-api-call.js';
import { accountService } from '../services/billing/account-service.js';
import { apiKeyService, ApiKeyNotFoundError } from '../services/billing/api-key-service.js';
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
  if (typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${config.internalApiToken}`);
  const actual = Buffer.from(header);
  // C5：内部 token 比较使用恒定时间，避免时序侧信道。
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** C4：分页参数必须是整数并限定上界，阻止 `page=Infinity`/超大 skip 慢查询 DoS。 */
function parsePage(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(1, n));
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
      // C3：内部 REST `/account` 返回真实 ledger 计数（此前被 mappers 硬编码为 0）。
      const ledgerCount = await BillingLedger.countDocuments({ accountId: account.id });
      res.json({ ...toBillingAccountWire(account), ledgerCount });
    } catch (err) {
      // C2：内部错误详情只记服务端日志，绝不把 Mongo/驱动信息原样吐给调用方/终端用户。
      console.error('[internal-billing] GET /account failed', (err as Error).message);
      res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  });

  router.get('/invoices', async (req: Request, res: Response) => {
    const accountId = String(req.query.accountId ?? '');
    if (!mongoose.isValidObjectId(accountId)) {
      res.status(400).json({ error: 'INVALID_ACCOUNT' });
      return;
    }
    const page = parsePage(req.query.page, 1, 100_000);
    const pageSize = parsePage(req.query.pageSize, 50, 200);
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
    const page = parsePage(req.query.page, 1, 100_000);
    const pageSize = parsePage(req.query.pageSize, 50, 200);
    const filter: Record<string, unknown> = { accountId };
    const rawInvoiceId = req.query.invoiceId;
    if (rawInvoiceId !== undefined) {
      // 一旦传入 invoiceId 就必须是合法 ObjectId（空串/数组/非法串均按「无匹配收据」处理，
      // 保持对外 200 + []，避免 mongoose CastError 500/堆栈泄露，也避免退化为「未过滤」而错配归属）
      if (typeof rawInvoiceId !== 'string' || !mongoose.isValidObjectId(rawInvoiceId)) {
        res.json([]);
        return;
      }
      filter.invoiceId = rawInvoiceId;
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
    const page = parsePage(req.query.page, 1, 100_000);
    const pageSize = parsePage(req.query.pageSize, 50, 200);
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
    // C4：rollup 必须 from < to 且限制查询跨度，避免无界聚合。
    if (from.getTime() >= to.getTime() || to.getTime() - from.getTime() > 366 * 24 * 60 * 60 * 1000) {
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

  router.post('/api-keys', async (req: Request, res: Response) => {
    const { ownerType, ownerId, name } = req.body ?? {};
    if (
      (ownerType !== 'front_user' && ownerType !== 'admin_user') ||
      typeof ownerId !== 'string' ||
      typeof name !== 'string' ||
      !name.trim()
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
      // P3：校验类失败 400，其余（Mongo/驱动等）500——基建故障不误报为请求错误。
      const message = (err as Error).message;
      if (message === 'API Key 名称不能为空') {
        res.status(400).json({ error: 'INVALID_BODY' });
        return;
      }
      console.error('[internal-billing] POST /api-keys failed', message);
      res.status(500).json({ error: 'INTERNAL_ERROR' });
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
    // C6：非 ObjectId 按参数错误 400（而非 404）；仅「不存在/无权」映射 404，其余内部错误 500。
    if (!mongoose.isValidObjectId(String(req.params.id))) {
      res.status(400).json({ error: 'INVALID_ID' });
      return;
    }
    try {
      const revoked = await apiKeyService.revoke(String(req.params.id), { ownerType, ownerId });
      res.json({ success: true, apiKey: revoked });
    } catch (err) {
      if (err instanceof ApiKeyNotFoundError) {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }
      console.error('[internal-billing] DELETE /api-keys failed', (err as Error).message);
      res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  });

  // C2：兜底错误处理——任何端点未捕获异常（Express 5 自动转发 rejected promise）统一返回
  // 通用 INTERNAL_ERROR，绝不把 err.message/堆栈回给调用方。
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    console.error('[internal-billing] unhandled error', (err as Error)?.message);
    // P3：响应头已发出时不能再写 body，转交 Express 默认处理器关闭连接，避免悬挂 socket。
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });

  return router;
}
