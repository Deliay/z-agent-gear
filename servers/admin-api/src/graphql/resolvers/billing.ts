import { GraphQLError } from 'graphql';
import mongoose from 'mongoose';
import { BillingAccount } from '../../models/billing-account.js';
import { BillingDeadLetter } from '../../models/billing-dead-letter.js';
import { BillingInvoice } from '../../models/billing-invoice.js';
import { BillingLedger } from '../../models/billing-ledger.js';
import { BillingReceipt } from '../../models/billing-receipt.js';
import { Model } from '../../models/model.js';
import { ProductPrice } from '../../models/product-price.js';
import { accountService } from '../../services/billing/account-service.js';
import { apiKeyService, type BillingApiKeyDTO } from '../../services/billing/api-key-service.js';
import { billingRuntime } from '../../services/billing/instances.js';
import { reconciliationRuntime } from '../../services/billing/instances.js';
import {
  toBillingAccountWire,
  toBillingInvoice,
  toBillingReceipt,
  toBillingReservation,
  toBillingRollup,
} from '../../services/billing/mappers.js';
import { creditsToCents } from '../../services/billing/money.js';
import { documentId } from '../../services/billing/id.js';
import { reservationService } from '../../services/billing/reservation.js';
import { rollupService, type RollupGranularity } from '../../services/billing/rollup-service.js';
import { assertAdmin } from './guard.js';
import type { AdminAuthContext } from './auth.js';

function toDate(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new GraphQLError(`${field} 非法时间格式`);
  return date;
}

function toApiKeyWire(key: BillingApiKeyDTO) {
  return {
    ...key,
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

export const billingResolvers = {
  Query: {
    adminBillingAccounts: async (
      _parent: unknown,
      args: {
        keyword?: string;
        ownerType?: 'front_user' | 'admin_user';
        page?: number;
        pageSize?: number;
      },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      const accounts = await accountService.list(args);
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
      if (!account) throw new GraphQLError('账户不存在');
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
      const filter: Record<string, unknown> = { accountId: args.accountId };
      if (args.type) filter.type = args.type;
      if (args.category) filter.category = args.category;
      const from = toDate(args.from, 'from');
      const to = toDate(args.to, 'to');
      if (from || to) {
        filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
      }
      const page = Math.max(1, args.page ?? 1);
      const pageSize = Math.min(200, Math.max(1, args.pageSize ?? 50));
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
      const page = Math.max(1, args.page ?? 1);
      const pageSize = Math.min(200, Math.max(1, args.pageSize ?? 50));
      const docs = await BillingReceipt.find({ accountId: args.accountId })
        .sort({ issuedAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean();
      return docs.map((doc) => toBillingReceipt(doc as never));
    },
    adminBillingRollups: async (
      _parent: unknown,
      args: { accountId: string; granularity: RollupGranularity; from: string; to: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      const from = toDate(args.from, 'from');
      const to = toDate(args.to, 'to');
      if (!from || !to) throw new GraphQLError('from/to 必填');
      const buckets = await rollupService.query(args.accountId, args.granularity, from, to);
      return buckets.map((bucket) => toBillingRollup(bucket as never));
    },
    adminBillingReservations: async (
      _parent: unknown,
      args: { accountId?: string; status?: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
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
      args: { accountId: string; amount: number; note?: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      const result = await billingRuntime.recharge({
        accountId: args.accountId,
        amountCredits: args.amount,
        note: args.note,
        operator: context.currentAdmin!.username,
      });
      const invoice = await BillingInvoice.findById(result.invoiceId).lean();
      if (!invoice) throw new GraphQLError('充值账单生成失败');
      return toBillingInvoice(invoice as never);
    },
    setBillingAccountCreditLimit: async (
      _parent: unknown,
      args: { accountId: string; creditLimit: number },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      const cents = creditsToCents(args.creditLimit);
      if (cents < 0) throw new GraphQLError('授信额度不能为负数');
      const account = await accountService.setCreditLimit(args.accountId, cents);
      return toBillingAccountWire(account);
    },
    setBillingAccountStatus: async (
      _parent: unknown,
      args: { accountId: string; status: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      const account = await accountService.setStatus(args.accountId, args.status);
      return toBillingAccountWire(account);
    },
    reconcileBillingAccount: async (
      _parent: unknown,
      args: { accountId: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      const result = await accountService.reconcileAccount(args.accountId);
      return toBillingAccountWire(result.account);
    },
    runReconciliation: async (
      _parent: unknown,
      args: { line?: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
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
      const model = await Model.findById(args.modelId);
      if (!model) throw new GraphQLError('模型不存在');
      const rates = {
        inputPerMillion: creditsToCents(args.pricing.inputPerMillion),
        cachedInputPerMillion: creditsToCents(args.pricing.cachedInputPerMillion),
        outputPerMillion: creditsToCents(args.pricing.outputPerMillion),
      };
      if (Object.values(rates).some((value) => value < 0)) {
        throw new GraphQLError('模型单价不能为负数');
      }
      const pricing = { ...rates, isBillable: args.pricing.isBillable !== false };
      model.set('pricing', pricing);
      await model.save();
      await ProductPrice.updateOne(
        { productId: `model.${args.modelId}.token`, effectiveFrom: new Date() },
        {
          $set: {
            productId: `model.${args.modelId}.token`,
            productName: model.name,
            pricingModel: 'per_token',
            unitPrice: 0,
            rates,
            isBillable: pricing.isBillable,
          },
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
      const key = await apiKeyService.revoke(args.id, {
        ownerType: 'admin_user',
        ownerId: context.currentAdmin!.id,
      });
      return toApiKeyWire(key);
    },
  },
};

// 保证账户模型在首次使用时已注册（BillingAccount 用于 ledgerCounts 之外的查询路径）
export const billingModels = { BillingAccount };
