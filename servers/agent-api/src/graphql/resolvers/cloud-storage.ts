import { GraphQLError } from 'graphql';
import { logger as rootLogger } from '../../observability/logger.js';
import { billingClient, type StorageQuoteWire } from '../../services/billing-client.js';
import {
  cloudStorageService,
  fallbackStorageQuote,
  toCloudStorageGraphQLError,
} from '../../services/cloud-storage-service.js';
import type { AuthContext } from './auth.js';

type Doc = Record<string, unknown>;

const logger = rootLogger.child({ component: 'cloud-storage' });

const DEFAULT_QUOTE_SIZE_GI = 10;
const QUOTE_MIN_SIZE_GI = 1;
const QUOTE_MAX_SIZE_GI = 30;

const TIER_LABELS: Record<string, string> = {
  'cloud_storage.base.hour': '前 10Gi',
  'cloud_storage.tier1.gib_hour': '10~25Gi 每 Gi',
  'cloud_storage.tier2.gib_hour': '25~30Gi 每 Gi',
};

/** 同一 GraphQL 请求内对同一父对象只报价一次（WeakMap 随 parent 生命周期回收）。 */
const quoteCache = new WeakMap<object, Promise<StorageQuoteWire>>();

function requireUser(context: AuthContext): string {
  if (!context.currentUser) throw new GraphQLError('Not authenticated');
  return context.currentUser.id;
}

function normalizeSize(sizeGi: unknown): number {
  const value = typeof sizeGi === 'number' ? sizeGi : Number(sizeGi);
  if (!Number.isInteger(value) || value < QUOTE_MIN_SIZE_GI || value > QUOTE_MAX_SIZE_GI) {
    return DEFAULT_QUOTE_SIZE_GI;
  }
  return value;
}

function toTiers(quote: { items: Array<{ productId: string; amountCredits: number }> }) {
  return quote.items.map((item) => ({
    label: TIER_LABELS[item.productId] ?? item.productId,
    amountCredits: item.amountCredits,
  }));
}

function toRateQuote(quote: { hourlyCredits: number; items: Array<{ productId: string; amountCredits: number }> }) {
  return { hourlyCredits: quote.hourlyCredits, tiers: toTiers(quote) };
}

async function loadQuote(sizeGi: number): Promise<StorageQuoteWire> {
  try {
    return await billingClient.getStorageQuote(sizeGi);
  } catch (err) {
    logger.warn(
      { component: 'cloud-storage', event: 'price-fallback', sizeGi, err },
      'storage quote fallback',
    );
    return fallbackStorageQuote(sizeGi) as unknown as StorageQuoteWire;
  }
}

function quoteForParent(parent: Doc): Promise<StorageQuoteWire> {
  const sizeGi = normalizeSize(parent.sizeGi);
  const cached = quoteCache.get(parent);
  if (cached) return cached;
  const promise = loadQuote(sizeGi);
  quoteCache.set(parent, promise);
  return promise;
}

export const cloudStorageResolvers = {
  Query: {
    cloudStorages: async (
      _parent: unknown,
      args: { onlyAttachable?: boolean | null; includeDestroyed?: boolean | null },
      context: AuthContext,
    ) => {
      requireUser(context);
      try {
        return await cloudStorageService.list({
          onlyAttachable: args.onlyAttachable === true,
          includeDestroyed: args.includeDestroyed === true,
        });
      } catch (err) {
        toCloudStorageGraphQLError(err);
      }
    },
    cloudStorage: async (_parent: unknown, args: { id: string }, context: AuthContext) => {
      requireUser(context);
      try {
        return await cloudStorageService.get(args.id);
      } catch (err) {
        toCloudStorageGraphQLError(err);
      }
    },
    cloudStorageBillingQuote: async (
      _parent: unknown,
      args: { sizeGi?: number | null },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      const sizeGi = normalizeSize(args.sizeGi ?? DEFAULT_QUOTE_SIZE_GI);
      const quote = await loadQuote(sizeGi);
      const billingTenantId =
        context.workspaceAccess?.tenantId ?? context.currentUser?.tenantId ?? userId;
      let availableBalance: number | null = null;
      try {
        const account = await billingClient.getAccount('tenant', billingTenantId);
        availableBalance = account.availableBalance;
      } catch (err) {
        logger.warn(
          { component: 'cloud-storage', event: 'balance-unavailable', err },
          'storage quote balance unavailable',
        );
      }
      return {
        sizeGi,
        full: toRateQuote(quote.full),
        archived: toRateQuote(quote.archived),
        availableBalance,
      };
    },
    cloudStorageCapabilities: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      requireUser(context);
      return cloudStorageService.getCapabilities();
    },
  },
  Mutation: {
    createCloudStorage: async (
      _parent: unknown,
      args: { input: { name: string; sizeGi: number } },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      try {
        return await cloudStorageService.create(userId, args.input);
      } catch (err) {
        toCloudStorageGraphQLError(err);
      }
    },
    destroyCloudStorage: async (_parent: unknown, args: { id: string }, context: AuthContext) => {
      const userId = requireUser(context);
      try {
        return await cloudStorageService.destroy(args.id, userId);
      } catch (err) {
        toCloudStorageGraphQLError(err);
      }
    },
    retryCloudStorageArchive: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      const userId = requireUser(context);
      try {
        return await cloudStorageService.retryArchive(args.id, userId);
      } catch (err) {
        toCloudStorageGraphQLError(err);
      }
    },
    refreshCloudStorageUsage: async (
      _parent: unknown,
      args: { id: string },
      context: AuthContext,
    ) => {
      requireUser(context);
      try {
        return await cloudStorageService.refreshUsage(args.id);
      } catch (err) {
        toCloudStorageGraphQLError(err);
      }
    },
  },
  CloudStorage: {
    archiveSpace: () => ({ capacityGi: 100, usedGi: null }),
    hourlyCredits: async (parent: Doc) => {
      const quote = await quoteForParent(parent);
      return parent.status === 'ARCHIVED' ? quote.archived.hourlyCredits : quote.full.hourlyCredits;
    },
    hourlyCreditsFull: async (parent: Doc) => (await quoteForParent(parent)).full.hourlyCredits,
    hourlyCreditsArchived: async (parent: Doc) =>
      (await quoteForParent(parent)).archived.hourlyCredits,
  },
  CloudStorageSummary: {
    hourlyCredits: async (parent: Doc) => {
      const quote = await quoteForParent(parent);
      return parent.status === 'ARCHIVED' ? quote.archived.hourlyCredits : quote.full.hourlyCredits;
    },
  },
};
