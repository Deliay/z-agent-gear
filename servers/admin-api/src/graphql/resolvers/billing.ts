import { GraphQLError } from 'graphql';
import mongoose from 'mongoose';
import { BillingAccount, type BillingOwnerType } from '../../models/billing-account.js';
import { BillingApiCall } from '../../models/billing-api-call.js';
import { BillingDeadLetter } from '../../models/billing-dead-letter.js';
import { BillingInvoice } from '../../models/billing-invoice.js';
import { BillingLedger } from '../../models/billing-ledger.js';
import { BillingReceipt } from '../../models/billing-receipt.js';
import { Model } from '../../models/model.js';
import { ProductPrice } from '../../models/product-price.js';
import { accountService } from '../../services/billing/account-service.js';
import {
  apiKeyService,
  ApiKeyNotFoundError,
  type BillingApiKeyDTO,
} from '../../services/billing/api-key-service.js';
import { billingRuntime, reconciliationRuntime } from '../../services/billing/instances.js';
import {
  toBillingAccountWire,
  toBillingApiCall,
  toBillingInvoice,
  toBillingReceipt,
  toBillingReservation,
  toBillingRollup,
} from '../../services/billing/mappers.js';
import { creditsToCents, MoneyError } from '../../services/billing/money.js';
import { documentId } from '../../services/billing/id.js';
import { reservationService } from '../../services/billing/reservation.js';
import { isReconciliationLine } from '../../services/billing/reconciliation.js';
import { rollupService, type RollupGranularity } from '../../services/billing/rollup-service.js';
import { assertAdmin } from './guard.js';
import type { AdminAuthContext } from './auth.js';

/**
 * O1：统一 GraphQL 错误映射（与 cloud-container 的 `toGraphQLError` 同口径）。
 * 非 `GraphQLError` 在 Yoga 生产掩码下会退化成 `Unexpected error.`，前端无法分支；
 * 这里把已知业务错误映射为稳定 `extensions.code`，未知错误统一收敛为 INTERNAL_ERROR。
 */
export function toBillingGraphQLError(err: unknown): GraphQLError {
  if (err instanceof GraphQLError) return err;
  if (err instanceof MoneyError) {
    return billingError(err.message, 'INVALID_ARGUMENT');
  }
  if (err instanceof ApiKeyNotFoundError) {
    return billingError(err.message, 'NOT_FOUND');
  }
  const message = err instanceof Error ? err.message : String(err);
  const notFound = /不存在|not found|无权操作/i.test(message);
  const conflict = /已存在|重复|conflict/i.test(message);
  const insufficient = /余额不足|可用余额不足|insufficient/i.test(message);
  const invalid = /不能|非法|必须|超出|不支持|精度|至少|最多|参数/i.test(message);
  if (notFound) return billingError(message, 'NOT_FOUND');
  if (conflict) return billingError(message, 'CONFLICT');
  if (insufficient) return billingError(message, 'INSUFFICIENT_FUNDS');
  if (invalid) return billingError(message, 'INVALID_ARGUMENT');
  return billingError('服务内部错误，请稍后重试', 'INTERNAL_SERVER_ERROR');
}

/** R2-5：统一构造带稳定 `extensions.code` 的业务错误（避免裸 `GraphQLError` 被掩码降级）。 */
export function billingError(
  message: string,
  code:
    | 'INVALID_ARGUMENT'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'INSUFFICIENT_FUNDS'
    | 'INTERNAL_SERVER_ERROR',
): GraphQLError {
  return new GraphQLError(message, { extensions: { code } });
}

type ResolverFn = (...args: never[]) => unknown;

/** 把一组 resolver 的同步/异步异常统一映射为可对外的 GraphQLError。 */
function mapResolvers<T extends Record<string, ResolverFn>>(group: T): T {
  const wrapped: Record<string, ResolverFn> = {};
  for (const [name, fn] of Object.entries(group)) {
    wrapped[name] = (async (...args: unknown[]) => {
      try {
        return await (fn as unknown as (...a: unknown[]) => unknown)(...args);
      } catch (err) {
        throw toBillingGraphQLError(err);
      }
    }) as unknown as ResolverFn;
  }
  return wrapped as T;
}

function toDate(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw billingError(`${field} 非法时间格式`, 'INVALID_ARGUMENT');
  return date;
}

/** C4：GraphQL 入参 ObjectId 校验，避免 CastError 500。 */
function assertObjectId(value: string, field: string): void {
  if (!mongoose.isValidObjectId(value)) throw billingError(`${field} 非法`, 'INVALID_ARGUMENT');
}

/** C4：分页参数整数校验 + 上界。 */
function toPage(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(1, value));
}

function toApiKeyWire(key: BillingApiKeyDTO) {
  return {
    ...key,
    // 契约枚举为 ACCOUNT/CLOUD_HOST（持久层为小写）
    scope: key.scope === 'cloud_host' ? 'CLOUD_HOST' : 'ACCOUNT',
    cloudHostId: key.cloudHostId ?? null,
    expiresAt: key.expiresAt ? key.expiresAt.toISOString() : null,
    lastUsedAt: key.lastUsedAt ? key.lastUsedAt.toISOString() : null,
    createdAt: key.createdAt.toISOString(),
  };
}

async function ledgerCounts(accountIds: string[]): Promise<Map<string, number>> {
  if (accountIds.length === 0) return new Map();
  const rows = (await BillingLedger.aggregate([
    { $match: { accountId: { $in: accountIds.map((id) => new mongoose.Types.ObjectId(id)) } } },
    { $group: { _id: '$accountId', count: { $sum: 1 } } },
  ])) as Array<{ _id: mongoose.Types.ObjectId; count: number }>;
  return new Map(rows.map((row) => [String(row._id), row.count]));
}

const rawBillingResolvers = {
  Query: {    adminBillingAccounts: async (
      _parent: unknown,
      args: {
        keyword?: string;
        ownerType?: BillingOwnerType;
        page?: number;
        pageSize?: number;
      },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      // P1/C4：该查询此前未走 toPage，`page=2^31` 会退化为超大 skip 慢查询；统一做整数校验 + 上界。
      const accounts = await accountService.list({
        ...args,
        page: toPage(args.page, 1, 100_000),
        pageSize: toPage(args.pageSize, 50, 200),
      });
      const counts = await ledgerCounts(accounts.map((account) => account.id));
      return accounts.map((account) => ({
        ...toBillingAccountWire(account),
        ledgerCount: counts.get(account.id) ?? 0,
      }));
    },
    adminBillingAccount: async (
      _parent: unknown,
      args: { id: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      const account = await accountService.getById(args.id);
      if (!account) throw billingError('账户不存在', 'NOT_FOUND');
      const counts = await ledgerCounts([account.id]);
      return { ...toBillingAccountWire(account), ledgerCount: counts.get(account.id) ?? 0 };
    },
    adminBillingInvoices: async (
      _parent: unknown,
      args: {
        accountId: string;
        from?: string;
        to?: string;
        type?: string;
        category?: string;
        page?: number;
        pageSize?: number;
      },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      assertObjectId(args.accountId, 'accountId');
      const filter: Record<string, unknown> = { accountId: args.accountId };
      if (args.type) filter.type = args.type;
      if (args.category) filter.category = args.category;
      const from = toDate(args.from, 'from');
      const to = toDate(args.to, 'to');
      if (from || to) {
        filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
      }
      const page = toPage(args.page, 1, 100_000);
      const pageSize = toPage(args.pageSize, 50, 200);
      const docs = await BillingInvoice.find(filter)
        .sort({ seq: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean();
      return docs.map((doc) => toBillingInvoice(doc as never));
    },
    adminBillingReceipts: async (
      _parent: unknown,
      args: { accountId: string; page?: number; pageSize?: number },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      assertObjectId(args.accountId, 'accountId');
      const page = toPage(args.page, 1, 100_000);
      const pageSize = toPage(args.pageSize, 50, 200);
      const docs = await BillingReceipt.find({ accountId: args.accountId })
        .sort({ issuedAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean();
      return docs.map((doc) => toBillingReceipt(doc as never));
    },
    adminBillingReceipt: async (
      _parent: unknown,
      args: { invoiceId: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      assertObjectId(args.invoiceId, 'invoiceId');
      // D-1：按账单直查收据（不再依赖「收据分页 rank 与账单分页一致」这一脆弱假设）。
      const doc = await BillingReceipt.findOne({ invoiceId: args.invoiceId }).lean();
      return doc ? toBillingReceipt(doc as never) : null;
    },
    adminBillingRollups: async (
      _parent: unknown,
      args: { accountId: string; granularity: RollupGranularity; from: string; to: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      assertObjectId(args.accountId, 'accountId');
      const from = toDate(args.from, 'from');
      const to = toDate(args.to, 'to');
      if (!from || !to) throw billingError('from/to 必填', 'INVALID_ARGUMENT');
      if (from.getTime() >= to.getTime() || to.getTime() - from.getTime() > 366 * 24 * 60 * 60 * 1000) {
        throw billingError('rollup 时间范围非法', 'INVALID_ARGUMENT');
      }
      const buckets = await rollupService.query(args.accountId, args.granularity, from, to);
      return buckets.map((bucket) => toBillingRollup(bucket as never));
    },
    adminBillingReservations: async (
      _parent: unknown,
      args: { accountId?: string; status?: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      if (args.accountId) assertObjectId(args.accountId, 'accountId');
      const docs = await reservationService.list(args);
      return docs.map((doc) => toBillingReservation(doc as never));
    },
    adminReconciliationReports: async (
      _parent: unknown,
      args: { line?: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      return reconciliationRuntime.latest(args.line).map((report) => ({
        line: report.line,
        ranAt: report.ranAt,
        checkedCount: report.checkedCount,
        errorCount: report.errorCount,
        errors: report.errors,
      }));
    },
    adminBillingApiKeys: async (_parent: unknown, _args: unknown, context: AdminAuthContext) => {
      assertAdmin(context);
      const keys = await apiKeyService.list('admin_user', context.currentAdmin!.id);
      return keys.map(toApiKeyWire);
    },
    adminBillingApiCalls: async (
      _parent: unknown,
      args: { accountId: string; status?: string; page?: number; pageSize?: number },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      assertObjectId(args.accountId, 'accountId');
      const filter: Record<string, unknown> = { accountId: args.accountId };
      if (args.status) filter.status = args.status;
      const page = toPage(args.page, 1, 100_000);
      const pageSize = toPage(args.pageSize, 50, 200);
      const docs = await BillingApiCall.find(filter)
        .sort({ startedAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean();
      return docs.map((doc) => toBillingApiCall(doc as never));
    },
    adminBillingDeadLetters: async (
      _parent: unknown,
      args: { limit?: number },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      const limit = Math.min(200, Math.max(1, args.limit ?? 100));
      const docs = await BillingDeadLetter.find().sort({ createdAt: -1 }).limit(limit).lean();
      return docs.map((doc) => ({
        id: documentId(doc),
        queue: doc.queue,
        routingKey: doc.routingKey,
        eventId: doc.eventId ?? null,
        error: doc.error ?? '',
        attempts: doc.attempts ?? 0,
        createdAt: new Date(doc.createdAt as Date).toISOString(),
      }));
    },
  },
  Mutation: {
    rechargeBillingAccount: async (
      _parent: unknown,
      args: { accountId: string; amount: number; note?: string; idempotencyKey?: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      assertObjectId(args.accountId, 'accountId');
      const result = await billingRuntime.recharge({
        accountId: args.accountId,
        amountCredits: args.amount,
        note: args.note,
        operator: context.currentAdmin!.username,
        idempotencyKey: args.idempotencyKey,
      });
      const invoice = await BillingInvoice.findById(result.invoiceId).lean();
      if (!invoice) throw billingError('充值账单生成失败', 'INTERNAL_SERVER_ERROR');
      return toBillingInvoice(invoice as never);
    },
    setBillingAccountCreditLimit: async (
      _parent: unknown,
      args: { accountId: string; creditLimit: number },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      assertObjectId(args.accountId, 'accountId');
      const cents = creditsToCents(args.creditLimit);
      if (cents < 0) throw billingError('授信额度不能为负数', 'INVALID_ARGUMENT');
      const account = await accountService.setCreditLimit(args.accountId, cents);
      return toBillingAccountWire(account);
    },
    setBillingAccountStatus: async (
      _parent: unknown,
      args: { accountId: string; status: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      assertObjectId(args.accountId, 'accountId');
      const account = await accountService.setStatus(args.accountId, args.status);
      return toBillingAccountWire(account);
    },
    reconcileBillingAccount: async (
      _parent: unknown,
      args: { accountId: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      assertObjectId(args.accountId, 'accountId');
      const result = await accountService.reconcileAccount(args.accountId);
      return toBillingAccountWire(result.account);
    },
    runReconciliation: async (
      _parent: unknown,
      args: { line?: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      // 建议 3：line 白名单校验，避免任意串透传到服务层。
      if (args.line && !isReconciliationLine(args.line)) {
        throw new GraphQLError('非法对账线', { extensions: { code: 'INVALID_ARGUMENT' } });
      }
      const reports = await reconciliationRuntime.run(args.line);
      return reports.map((report) => ({
        line: report.line,
        ranAt: report.ranAt,
        checkedCount: report.checkedCount,
        errorCount: report.errorCount,
        errors: report.errors,
      }));
    },
    updateModelPricing: async (
      _parent: unknown,
      args: {
        modelId: string;
        pricing: {
          inputPerMillion: number;
          cachedInputPerMillion: number;
          outputPerMillion: number;
          isBillable: boolean;
        };
      },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      assertObjectId(args.modelId, 'modelId');
      const model = await Model.findById(args.modelId);
      if (!model) throw billingError('模型不存在', 'NOT_FOUND');
      // 建议 1：模型定价只能作用于全局模型（价目表 `model.<id>.token` 是全局真相；
      // 用户私有模型定价会污染全局价目）。
      if (model.scope !== 'global') {
        throw new GraphQLError('仅支持为全局模型配置计费价目', {
          extensions: { code: 'INVALID_ARGUMENT' },
        });
      }
      const rates = {
        inputPerMillion: creditsToCents(args.pricing.inputPerMillion),
        cachedInputPerMillion: creditsToCents(args.pricing.cachedInputPerMillion),
        outputPerMillion: creditsToCents(args.pricing.outputPerMillion),
      };
      if (Object.values(rates).some((value) => value < 0)) {
        throw billingError('模型单价不能为负数', 'INVALID_ARGUMENT');
      }
      const pricing = { ...rates, isBillable: args.pricing.isBillable !== false };
      model.set('pricing', pricing);
      await model.save();
      // 建议 1：按 `productId` upsert 单档（`effectiveFrom` 仅在首次插入时确定），
      // 避免「每次调用必插新档」导致价目行无限累积（历史档由迁移/显式接口维护）。
      await ProductPrice.updateOne(
        { productId: `model.${args.modelId}.token` },
        {
          $set: {
            productId: `model.${args.modelId}.token`,
            productName: model.name,
            pricingModel: 'per_token',
            unitPrice: 0,
            rates,
            isBillable: pricing.isBillable,
          },
          $setOnInsert: { effectiveFrom: new Date(0) },
        },
        { upsert: true },
      );
      return {
        id: String(model._id),
        providerId: String(model.providerId),
        name: model.name,
        isCustom: model.isCustom,
        isEnabled: model.isEnabled,
        sortOrder: model.sortOrder,
        scope: model.scope,
        pricing: {
          inputPerMillion: rates.inputPerMillion / 100,
          cachedInputPerMillion: rates.cachedInputPerMillion / 100,
          outputPerMillion: rates.outputPerMillion / 100,
          isBillable: pricing.isBillable,
        },
        createdAt: new Date(model.createdAt as Date).toISOString(),
        updatedAt: new Date(model.updatedAt as Date).toISOString(),
      };
    },
    createBillingApiKey: async (
      _parent: unknown,
      args: { name: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      const admin = context.currentAdmin!;
      const account = await accountService.getOrCreate('admin_user', admin.id, admin.username);
      const created = await apiKeyService.create({
        accountId: account.id,
        ownerType: 'admin_user',
        ownerId: admin.id,
        name: args.name,
      });
      return { apiKey: toApiKeyWire(created.apiKey), secret: created.secret };
    },
    revokeBillingApiKey: async (
      _parent: unknown,
      args: { id: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      assertObjectId(args.id, 'id');
      const key = await apiKeyService.revoke(args.id, {
        ownerType: 'admin_user',
        ownerId: context.currentAdmin!.id,
      });
      return toApiKeyWire(key);
    },
  },
};

// O1：全部 Query/Mutation 统一错误映射，业务错误带稳定 extensions.code（与 cloud-container 同口径）。
export const billingResolvers = {
  Query: mapResolvers(rawBillingResolvers.Query),
  Mutation: mapResolvers(rawBillingResolvers.Mutation),
};

// 保证账户模型在首次使用时已注册（BillingAccount 用于 ledgerCounts 之外的查询路径）
export const billingModels = { BillingAccount };
