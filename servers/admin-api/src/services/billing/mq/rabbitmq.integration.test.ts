import { describe, it, expect } from 'vitest';
import amqp from 'amqplib';
import {
  BILLING_EVENTS_EXCHANGE,
  METERING_QUEUE,
  declareBillingTopology,
} from './topology.js';

/**
 * 真实 RabbitMQ 链路测试（裁决 15）：仅当配置 `RABBITMQ_TEST_URL` 时执行，
 * CI 提供 broker 时全量跑；未配置则跳过，保证本地/CI 单测绿灯。
 */
const RABBITMQ_URL = process.env.RABBITMQ_TEST_URL;

(RABBITMQ_URL ? describe : describe.skip)('RabbitMQ 计费链路（真实 broker）', () => {
  it(
    'outbox 事件 → topic exchange → 计量队列可消费（幂等 eventId 透传）',
    async () => {
      const connection = await amqp.connect(RABBITMQ_URL);
      const channel = await connection.createChannel();
      try {
        await declareBillingTopology(channel);
        const eventId = `rabbitmq-test:${Date.now()}:${Math.random().toString(16).slice(2)}`;
        const event = {
          eventId,
          eventType: 'model_call.aborted',
          occurredAt: new Date().toISOString(),
          accountId: 'acct-rabbit',
          resourceId: 'req-rabbit',
          payload: { modelId: 'm1', inputTokens: 1, outputTokens: 1 },
        };
        const received = new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('consume timeout')), 10_000);
          void channel
            .consume(METERING_QUEUE, (msg) => {
              if (!msg) return;
              const parsed = JSON.parse(msg.content.toString()) as Record<string, unknown>;
              if (parsed.eventId !== eventId) {
                channel.ack(msg);
                return;
              }
              clearTimeout(timer);
              channel.ack(msg);
              resolve(parsed);
            })
            .catch(reject);
        });

        channel.publish(
          BILLING_EVENTS_EXCHANGE,
          'model_call.aborted',
          Buffer.from(JSON.stringify(event)),
          {
            persistent: true,
            contentType: 'application/json',
            messageId: eventId,
            headers: { 'x-event-id': eventId, 'x-publish-attempts': 0 },
          },
        );
        const consumed = await received;
        expect(consumed.eventId).toBe(eventId);
        expect(consumed.eventType).toBe('model_call.aborted');
      } finally {
        await channel.close();
        await connection.close();
      }
    },
    20_000,
  );
});
