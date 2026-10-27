import { Router, type NextFunction, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { BillingInvoice } from '../models/billing-invoice.js';
import { BillingLedger } from '../models/billing-ledger.js';
import { BillingReceipt } from '../models/billing-receipt.js';
import { BillingApiCall } from '../models/billing-api-call.js';
import { CloudHost } from '../models/cloud-host.js';
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
import {
  AccountFrozenError,
  AccountNotFoundError,
  InsufficientBalanceError,
  InvalidChargeInputError,
  oneTimeChargeService,
} from '../services/billing/one-time-charge.js';

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

/** API Key DTO → 内部 REST wire（时间 ISO；含 scope/cloudHostId/expiresAt；expiresAt 仅历史数据可能非空）。 */
function apiKeyToWire(key: {
  scope: string;
  cloudHostId: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}) {
  return {
    ...key,
    expiresAt: key.expiresAt ? key.expiresAt.toISOString() : null,
    lastUsedAt: key.lastUsedAt ? key.lastUsedAt.toISOString() : null,
    createdAt: key.createdAt.toISOString(),
  };
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

  router.post('/charges', async (req: Request, res: Response) => {
    const {
      accountId,
      productId,
      quantity,
      idempotentKey,
      refType,
      refId,
      description,
    } = req.body ?? {};
    if (
      typeof accountId !== 'string' ||
      !mongoose.isValidObjectId(accountId) ||
      typeof productId !== 'string' ||
      productId !== 'cloud_host.create' ||
      !Number.isInteger(quantity) ||
      quantity <= 0 ||
      typeof idempotentKey !== 'string' ||
      !idempotentKey ||
      typeof refType !== 'string' ||
      !refType ||
      typeof refId !== 'string' ||
      !refId ||
      typeof description !== 'string'
    ) {
      res.status(400).json({ error: 'INVALID_BODY' });
      return;
    }
    try {
      const result = await oneTimeChargeService.createOneTimeCharge({
        accountId,
        productId,
        quantity,
        idempotentKey,
        refType,
        refId,
        description,
      });
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof InvalidChargeInputError) {
        res.status(400).json({ error: 'INVALID_BODY' });
        return;
      }
      if (err instanceof AccountNotFoundError) {
        res.status(404).json({ error: 'ACCOUNT_NOT_FOUND' });
        return;
      }
      if (err instanceof AccountFrozenError) {
        res.status(403).json({ error: 'ACCOUNT_FROZEN' });
        return;
      }
      if (err instanceof InsufficientBalanceError) {
        res.status(409).json({ error: 'INSUFFICIENT_BALANCE', available: err.available });
        return;
      }
      console.error('[internal-billing] POST /charges failed', (err as Error).message);
      res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  });

  router.post('/refunds', async (req: Request, res: Response) => {
    const { idempotentKey, refundKey, reason } = req.body ?? {};
    if (
      typeof idempotentKey !== 'string' ||
      !idempotentKey ||
      typeof refundKey !== 'string' ||
      !refundKey ||
      typeof reason !== 'string'
    ) {
      res.status(400).json({ error: 'INVALID_BODY' });
      return;
    }
    try {
      const result = await oneTimeChargeService.refundCharge({
        idempotentKey,
        refundKey,
        reason,
      });
      res.json(result);
    } catch (err) {
      console.error('[internal-billing] POST /refunds failed', (err as Error).message);
      res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  });

  router.get('/price-quote', async (req: Request, res: Response) => {
    const raw = req.query.productIds;
    const productIds = (typeof raw === 'string' ? raw : '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (productIds.length === 0) {
      res.status(400).json({ error: 'INVALID_BODY' });
      return;
    }
    try {
      res.json(await oneTimeChargeService.getPriceQuote(productIds));
    } catch (err) {
      console.error('[internal-billing] GET /price-quote failed', (err as Error).message);
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
    res.json(keys.map(apiKeyToWire));
  });

  router.post('/api-keys', async (req: Request, res: Response) => {
    const { ownerType, ownerId, name, scope: rawScope, cloudHostId, expiresAt } = req.body ?? {};
    if (
      (ownerType !== 'front_user' && ownerType !== 'admin_user') ||
      typeof ownerId !== 'string' ||
      typeof name !== 'string' ||
      !name.trim()
    ) {
      res.status(400).json({ error: 'INVALID_BODY' });
      return;
    }
    // 缺省 scope=account（既有 agent-api 调用零改动）；cloud_host 必须绑定云电脑与合法有效期。
    const scope = rawScope === undefined || rawScope === null ? 'account' : rawScope;
    if (scope !== 'account' && scope !== 'cloud_host') {
      res.status(400).json({ error: 'INVALID_BODY' });
      return;
    }
    let hostId: string | null = null;
    if (scope === 'cloud_host') {
      if (typeof cloudHostId !== 'string' || !mongoose.isValidObjectId(cloudHostId)) {
        res.status(400).json({ error: 'INVALID_BODY' });
        return;
      }
      // `expiresAt` 已废弃：云电脑 Key 随容器回收，不再按时间失效。仍接受旧版 agent-api
      // 传入的合法 ISO 时间（滚动发布兼容）但忽略其值；不可解析时按脏输入拒绝。
      if (expiresAt !== undefined && expiresAt !== null && !toDate(expiresAt)) {
        res.status(400).json({ error: 'INVALID_BODY' });
        return;
      }
      hostId = cloudHostId;
    }
    try {
      // B-5/R2-14：front_user 的 cloud_host Key 必须绑定本人且未软删除的云电脑，避免越权；
      // admin_user 与网关鉴权口径一致保留管理豁免（可代任意宿主铸造）。
      if (hostId && ownerType === 'front_user') {
        const host = await CloudHost.findById(hostId)
          .select({ userId: 1, deletedAt: 1 })
          .lean<{ userId?: unknown; deletedAt?: Date | null } | null>();
        if (!host || host.deletedAt || !host.userId || String(host.userId) !== ownerId) {
          res.status(404).json({ error: 'CLOUD_HOST_NOT_FOUND' });
          return;
        }
      }
      const account = await accountService.getOrCreate(ownerType, ownerId);
      const created =
        scope === 'cloud_host'
          ? await apiKeyService.createCloudHostScopedKey({
              accountId: account.id,
              ownerType,
              ownerId,
              name,
              cloudHostId: hostId!,
            })
          : await apiKeyService.create({
              accountId: account.id,
              ownerType,
              ownerId,
              name,
            });
      res.status(201).json({
        apiKey: apiKeyToWire(created.apiKey),
        secret: created.secret,
      });
    } catch (err) {
      // P3：校验类失败 400，其余（Mongo/驱动等）500——基建故障不误报为请求错误。
      const message = (err as Error).message;
      if (message === 'API Key 名称不能为空' || message === '云电脑 ID 非法') {
        res.status(400).json({ error: 'INVALID_BODY' });
        return;
      }
      console.error('[internal-billing] POST /api-keys failed', message);
      res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  });

  // 按云电脑 ID 撤销全部 active Key（停止/删除/终态兜底）：幂等。
  router.post('/api-keys/revoke-by-host', async (req: Request, res: Response) => {
    const cloudHostId = req.body?.cloudHostId;
    if (typeof cloudHostId !== 'string' || !mongoose.isValidObjectId(cloudHostId)) {
      res.status(400).json({ error: 'INVALID_BODY' });
      return;
    }
    try {
      const revoked = await apiKeyService.revokeByCloudHost(cloudHostId);
      res.json({ success: true, revoked });
    } catch (err) {
      console.error('[internal-billing] POST /api-keys/revoke-by-host failed', (err as Error).message);
      res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  });

  // 按 ID 撤销（不要求 owner）：幂等；未知 id 404。
  router.post('/api-keys/:id/revoke', async (req: Request, res: Response) => {
    if (!mongoose.isValidObjectId(String(req.params.id))) {
      res.status(400).json({ error: 'INVALID_ID' });
      return;
    }
    try {
      const revoked = await apiKeyService.revokeById(String(req.params.id));
      res.json({ success: true, apiKey: apiKeyToWire(revoked) });
    } catch (err) {
      if (err instanceof ApiKeyNotFoundError) {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }
      console.error('[internal-billing] POST /api-keys/:id/revoke failed', (err as Error).message);
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
