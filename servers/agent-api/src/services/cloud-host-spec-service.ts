import mongoose from 'mongoose';
import { logger as rootLogger } from '../observability/logger.js';
import { CloudHostSpec } from '../models/cloud-host-spec.js';
import { getWorkspaceContext } from '../services/workspace-context.js';
import { billingClient, type SpecQuoteWire } from './billing-client.js';

/** 前台可见规格（契约 `CloudHostSpec`）。 */
export interface CloudHostSpecDTO {
  id: string;
  name: string;
  cpu: number;
  memoryGi: number;
  ephemeralStorageGi: number;
  unlimited: boolean;
  isPreset: boolean;
  hourlyCredits: number;
}

/** 分档明细（契约 `CloudHostSpecQuoteTier`）。 */
export interface CloudHostSpecQuoteDTO {
  hourlyCredits: number;
  tiers: Array<{ label: string; amountCredits: number }>;
  availableBalance: number | null;
}

export function isUnlimitedSpecValues(values: {
  cpu: number;
  memoryGi: number;
  ephemeralStorageGi: number;
}): boolean {
  return values.cpu === 0 && values.memoryGi === 0 && values.ephemeralStorageGi === 0;
}

/**
 * 计费服务不可用时的本地降级价目（单位分，与 admin-api `services/billing/pricing.ts`
 * 的 `DEFAULT_CLOUD_SPEC_*_CENTS` 播种值一致；两处修改必须同步，防漂移）。
 */
const FALLBACK_SPEC_CENTS = {
  cpuTier1: 1500,
  cpuTier2: 3000,
  memTier1: 1500,
  memTier2: 3000,
  memTier3: 4500,
  memTier4: 6000,
  ephemeralTier: 1000,
} as const;

/** 本地降级计算每小时 credits（与 `quoteSpecHourly` 同公式）。 */
export function fallbackSpecHourlyCredits(spec: {
  cpu: number;
  memoryGi: number;
  ephemeralStorageGi: number;
}): number {
  if (isUnlimitedSpecValues(spec)) return 0;
  const mem =
    Math.min(spec.memoryGi, 4) * FALLBACK_SPEC_CENTS.memTier1 +
    Math.min(Math.max(spec.memoryGi - 4, 0), 4) * FALLBACK_SPEC_CENTS.memTier2 +
    Math.min(Math.max(spec.memoryGi - 8, 0), 8) * FALLBACK_SPEC_CENTS.memTier3 +
    Math.max(spec.memoryGi - 16, 0) * FALLBACK_SPEC_CENTS.memTier4;
  const cpu =
    Math.min(spec.cpu, 4) * FALLBACK_SPEC_CENTS.cpuTier1 +
    Math.max(spec.cpu - 4, 0) * FALLBACK_SPEC_CENTS.cpuTier2;
  const ephemeral =
    Math.max(spec.ephemeralStorageGi - 10, 0) * FALLBACK_SPEC_CENTS.ephemeralTier;
  return (cpu + mem + ephemeral) / 100;
}

/** 规格快照装配（CloudHost.spec 字段级 resolver；不回查规格表）。 */
export function buildCloudHostSpecSnapshot(parent: Record<string, unknown>): CloudHostSpecDTO | null {
  if (parent.specCpu === undefined || parent.specCpu === null) return null;
  const cpu = Number(parent.specCpu);
  const memoryGi = Number(parent.specMemoryGi ?? 0);
  const ephemeralStorageGi = Number(parent.specEphemeralStorageGi ?? 0);
  return {
    id: parent.specId ? String(parent.specId) : '',
    name: String(parent.specName ?? ''),
    cpu,
    memoryGi,
    ephemeralStorageGi,
    unlimited: isUnlimitedSpecValues({ cpu, memoryGi, ephemeralStorageGi }),
    // 快照不回查规格表：isPreset 恒 false（已删除规格仍可展示）。
    isPreset: false,
    // 快照不保存价目；每小时费用由调用方（详情按需查询）补充，默认 0。
    hourlyCredits: 0,
  };
}

/** 当前租户（请求上下文）可见性唯一口径：非白名单 或 名单命中。 */
function visibleFilter(tenantId: string): Record<string, unknown> {
  return {
    $or: [{ whitelistEnabled: false }, { allowedTenantIds: String(tenantId) }],
  };
}

function mapSpec(
  doc: Record<string, unknown>,
  hourlyCredits: number,
): CloudHostSpecDTO {
  const cpu = Number(doc.cpu ?? 0);
  const memoryGi = Number(doc.memoryGi ?? 0);
  const ephemeralStorageGi = Number(doc.ephemeralStorageGi ?? 0);
  return {
    id: String(doc._id ?? ''),
    name: String(doc.name ?? ''),
    cpu,
    memoryGi,
    ephemeralStorageGi,
    unlimited: isUnlimitedSpecValues({ cpu, memoryGi, ephemeralStorageGi }),
    isPreset: doc.isPreset === true,
    hourlyCredits,
  };
}

export class CloudHostSpecService {
  private resolveTenantId(): string | null {
    const context = getWorkspaceContext();
    // 规格是平台目录：可见性按当前请求租户；无上下文（引擎/内部）不放行任何白名单规格。
    return context?.tenantId ? String(context.tenantId) : null;
  }

  /** 当前租户可见规格列表（按 cpu/memory/ephemeral 降序），按需填充每小时费用。 */
  async listVisible(): Promise<CloudHostSpecDTO[]> {
    const tenantId = this.resolveTenantId();
    if (!tenantId) return [];
    const docs = await CloudHostSpec.find(visibleFilter(tenantId))
      .sort({ cpu: -1, memoryGi: -1, ephemeralStorageGi: -1 })
      .lean<Array<Record<string, unknown>>>();
    if (docs.length === 0) return [];
    const quotes = await Promise.all(
      docs.map((doc) => {
        const spec = {
          cpu: Number(doc.cpu ?? 0),
          memoryGi: Number(doc.memoryGi ?? 0),
          ephemeralStorageGi: Number(doc.ephemeralStorageGi ?? 0),
        };
        return this.quoteHourlyCredits(spec).catch((err) => {
          rootLogger.warn(
            { event: 'spec-hours-fallback', specId: String(doc._id ?? ''), err },
            'spec hourly quote fallback to local defaults',
          );
          return fallbackSpecHourlyCredits(spec);
        });
      }),
    );
    return docs.map((doc, index) => mapSpec(doc, quotes[index] ?? 0));
  }

  /** 按租户可见性取规格（不可见 = 不存在，不泄露存在性）；创建链路服务端强制校验用。 */
  async findVisibleById(id: string, tenantId?: string | null): Promise<Record<string, unknown> | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const resolvedTenant = tenantId ? String(tenantId) : this.resolveTenantId();
    if (!resolvedTenant) return null;
    return CloudHostSpec.findOne({ _id: id, ...visibleFilter(resolvedTenant) })
      .lean<Record<string, unknown> | null>();
  }

  /** 按规格 id 报价（规格须对当前租户可见）。 */
  async quoteById(id: string): Promise<CloudHostSpecQuoteDTO> {
    const tenantId = this.resolveTenantId();
    const doc = tenantId ? await this.findVisibleById(id, tenantId) : null;
    if (!doc) throw new Error('spec not found');
    return this.quoteResources({
      cpu: Number(doc.cpu ?? 0),
      memoryGi: Number(doc.memoryGi ?? 0),
      ephemeralStorageGi: Number(doc.ephemeralStorageGi ?? 0),
    });
  }

  async quoteResources(spec: {
    cpu: number;
    memoryGi: number;
    ephemeralStorageGi: number;
  }): Promise<CloudHostSpecQuoteDTO> {
    const tenantId = this.resolveTenantId();
    const [quote, account] = await Promise.allSettled([
      billingClient.getSpecQuote({
        cpu: spec.cpu,
        memoryGi: spec.memoryGi,
        ephemeralStorageGi: spec.ephemeralStorageGi,
      }),
      tenantId ? billingClient.getAccount('tenant', tenantId) : Promise.reject(new Error('no tenant')),
    ]);
    if (quote.status !== 'fulfilled') {
      throw quote.reason instanceof Error ? quote.reason : new Error('billing service unavailable');
    }
    return {
      hourlyCredits: quote.value.hourlyCredits,
      tiers: quote.value.tiers,
      availableBalance: account.status === 'fulfilled' ? account.value.availableBalance : null,
    };
  }

  /** 单规格每小时费用（列表填充用；计费不可用时降级为 0 并计 warn 由调用方处理）。 */
  async quoteHourlyCredits(spec: {
    cpu: number;
    memoryGi: number;
    ephemeralStorageGi: number;
  }): Promise<number> {
    const quote: SpecQuoteWire = await billingClient.getSpecQuote(spec);
    return quote.hourlyCredits;
  }
}

export const cloudHostSpecService = new CloudHostSpecService();
