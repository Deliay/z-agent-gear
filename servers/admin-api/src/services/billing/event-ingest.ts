import { BillingEvent, type IBillingEvent } from '../../models/billing-event.js';

export interface BillingEventInput {
  eventId: string;
  eventType: string;
  occurredAt: string | Date;
  accountId: string;
  resourceId: string;
  payload?: Record<string, unknown>;
}

/** 事件接入：`eventId` 唯一去重；只落事实，不解析金额。 */
export class EventIngestService {
  async ingest(input: BillingEventInput): Promise<{ event: IBillingEvent; created: boolean }> {
    const occurredAt = input.occurredAt instanceof Date ? input.occurredAt : new Date(input.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) throw new Error('invalid occurredAt');
    try {
      const event = await BillingEvent.create({
        eventId: input.eventId,
        eventType: input.eventType,
        occurredAt,
        accountId: input.accountId,
        resourceId: input.resourceId,
        payload: input.payload ?? {},
        metered: false,
        receivedAt: new Date(),
      });
      return { event, created: true };
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      const existing = await BillingEvent.findOne({ eventId: input.eventId });
      if (!existing) throw err;
      return { event: existing, created: false };
    }
  }

  /** 消费失败重试时按事件 ID 重新读取（供 DLQ/对账重放）。 */
  async getByEventId(eventId: string): Promise<IBillingEvent | null> {
    return BillingEvent.findOne({ eventId });
  }
}

export const eventIngestService = new EventIngestService();
