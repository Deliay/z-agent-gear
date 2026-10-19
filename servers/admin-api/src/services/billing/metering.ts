import { config } from '../../config/index.js';
import { BillingEvent, type IBillingEvent } from '../../models/billing-event.js';
import { MeteringRecord } from '../../models/metering-record.js';
import { ceilMinutes } from './money.js';

export interface MeteringResult {
  created: boolean;
  productId: string | null;
  quantity: number;
  estimated: boolean;
  windowFrom: Date;
  windowTo: Date;
}

/** 容器的分钟数（不足 1 分钟按 1 分钟）。 */
export function containerMinutes(startedAt: Date, exitedAt: Date): number {
  return ceilMinutes(exitedAt.getTime() - startedAt.getTime());
}

function toInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? '0'), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 事件 → 计量事实（可重放）：容器分钟数 / 模型三段 token。
 * 幂等：同一 `eventId` 只产生一条计量记录；`event.metered` 作为重放游标。
 */
export class MeteringService {
  async meterEvent(event: IBillingEvent): Promise<MeteringResult | null> {
    if (event.metered) {
      const existing = await MeteringRecord.findOne({ eventId: event.eventId });
      if (existing) {
        return {
          created: false,
          productId: existing.productId,
          quantity: existing.quantity,
          estimated: existing.estimated,
          windowFrom: existing.windowFrom,
          windowTo: existing.windowTo,
        };
      }
    }

    const record = this.buildRecord(event);
    if (!record) {
      await BillingEvent.updateOne({ eventId: event.eventId }, { $set: { metered: true } });
      return null;
    }

    let created = true;
    try {
      await MeteringRecord.create(record);
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      created = false;
    }
    await BillingEvent.updateOne({ eventId: event.eventId }, { $set: { metered: true } });
    return {
      created,
      productId: record.productId,
      quantity: record.quantity,
      estimated: record.estimated,
      windowFrom: record.windowFrom,
      windowTo: record.windowTo,
    };
  }

  /** 重放：重置游标后重扫（对账/修复用）。 */
  async resetCursor(filter: Record<string, unknown> = {}): Promise<number> {
    const result = await BillingEvent.updateMany(filter, { $set: { metered: false } });
    return result.modifiedCount ?? 0;
  }

  private buildRecord(event: IBillingEvent): {
    eventId: string;
    accountId: string;
    resourceType: 'container' | 'model';
    resourceId: string;
    productId: string;
    quantity: number;
    dims: Record<string, unknown>;
    windowFrom: Date;
    windowTo: Date;
    estimated: boolean;
    invoiced: boolean;
  } | null {
    const payload = (event.payload ?? {}) as Record<string, unknown>;

    if (event.eventType === 'container.ready') {
      return null;
    }

    if (event.eventType === 'container.destroyed') {
      // 容器按周期计量：销毁事件只触发最终结算，完整时长由周期/最终结算窗口分别入账，
      // 避免「全时长一条记录」与周期账单重复计费。
      return null;
    }

    if (event.eventType === 'model_call.completed' || event.eventType === 'model_call.aborted') {
      const modelId = String(payload.modelId ?? '');
      if (!modelId) return null;
      let inputTokens = toInt(payload.inputTokens);
      let cachedInputTokens = toInt(payload.cachedInputTokens);
      let outputTokens = toInt(payload.outputTokens);
      let estimated = payload.estimated === true;
      // 计量缺失兜底：没有 usage 时按请求上限估算（不逃费），并标注 estimated。
      if (inputTokens + outputTokens === 0) {
        estimated = true;
        inputTokens = Math.max(1, toInt(payload.estimatedInputTokens));
        outputTokens = Math.max(1, toInt(payload.estimatedOutputTokens) || config.modelDefaultMaxOutputTokens);
      }
      if (cachedInputTokens > inputTokens) cachedInputTokens = inputTokens;
      return {
        eventId: event.eventId,
        accountId: event.accountId,
        resourceType: 'model',
        resourceId: event.resourceId,
        productId: `model.${modelId}.token`,
        quantity: inputTokens + outputTokens,
        dims: { modelId, inputTokens, cachedInputTokens, outputTokens, estimated },
        windowFrom: event.occurredAt,
        windowTo: event.occurredAt,
        estimated,
        invoiced: false,
      };
    }

    return null;
  }
}

export const meteringService = new MeteringService();
