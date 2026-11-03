import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../models/billing-event.js', () => ({
  BillingEvent: { updateOne: vi.fn(), updateMany: vi.fn() },
}));
vi.mock('../../models/metering-record.js', () => ({
  MeteringRecord: { create: vi.fn(), findOne: vi.fn() },
}));

import { BillingEvent } from '../../models/billing-event.js';
import { MeteringRecord } from '../../models/metering-record.js';
import { MeteringService, containerMinutes } from './metering.js';

const event = (overrides: Record<string, unknown> = {}) => ({
  eventId: 'evt-1',
  eventType: 'model_call.completed',
  occurredAt: new Date('2026-01-01T00:00:00Z'),
  accountId: 'acct-1',
  resourceId: 'req-1',
  payload: {},
  metered: false,
  receivedAt: new Date(),
  ...overrides,
});

describe('MeteringService（事件 → 计量事实）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('容器分钟数：不足 1 分钟按 1 分钟', () => {
    expect(containerMinutes(new Date(0), new Date(30_000))).toBe(1);
    expect(containerMinutes(new Date(0), new Date(60_000))).toBe(1);
    expect(containerMinutes(new Date(0), new Date(60_001))).toBe(2);
  });

  it('T-B1: 模型三段 token 计量并标注 usage', async () => {
    (MeteringRecord.create as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (BillingEvent.updateOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const service = new MeteringService();
    const result = await service.meterEvent(
      event({
        payload: {
          modelId: 'gpt-5',
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 50,
        },
      }) as never,
    );
    expect(result?.productId).toBe('model.gpt-5.token');
    expect(result?.quantity).toBe(150);
    const created = (MeteringRecord.create as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(created.dims).toMatchObject({ inputTokens: 100, cachedInputTokens: 20, outputTokens: 50 });
    expect(created.estimated).toBe(false);
  });

  it('T-B9: 用量缺失时兜底估算并标注 estimated', async () => {
    (MeteringRecord.create as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (BillingEvent.updateOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const service = new MeteringService();
    const result = await service.meterEvent(
      event({ eventType: 'model_call.aborted', payload: { modelId: 'gpt-5' } }) as never,
    );
    const created = (MeteringRecord.create as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(result?.estimated).toBe(true);
    expect(created.estimated).toBe(true);
    expect(created.quantity).toBeGreaterThan(0);
  });

  it('T-B1: 已计量事件重放不重复创建', async () => {
    (MeteringRecord.findOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      productId: 'model.gpt-5.token',
      quantity: 150,
      estimated: false,
      windowFrom: new Date(0),
      windowTo: new Date(0),
    });
    const service = new MeteringService();
    const result = await service.meterEvent(event({ metered: true }) as never);
    expect(result?.created).toBe(false);
    expect(MeteringRecord.create).not.toHaveBeenCalled();
  });

  it('容器事件不直接计量（按周期窗口计量，避免重复计费）', async () => {
    (MeteringRecord.create as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (BillingEvent.updateOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const service = new MeteringService();
    const result = await service.meterEvent(
      event({
        eventType: 'container.destroyed',
        payload: { billingStartedAt: '2026-01-01T00:00:00Z', exitedAt: '2026-01-01T00:05:00Z' },
      }) as never,
    );
    expect(result).toBeNull();
    expect(MeteringRecord.create).not.toHaveBeenCalled();
  });

  it('模型事件缺 modelId 不计费；未知事件类型跳过；重放游标可重置', async () => {
    (MeteringRecord.create as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (BillingEvent.updateOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ updated: 3 });
    const service = new MeteringService();
    expect(
      await service.meterEvent(event({ payload: { inputTokens: 10 } }) as never),
    ).toBeNull();
    expect(await service.meterEvent(event({ eventType: 'unknown' }) as never)).toBeNull();

    (BillingEvent.updateMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      modifiedCount: 3,
    });
    expect(await service.resetCursor({ metered: true })).toBe(3);
  });

  it('estimated 兜底使用 payload 提供的估算 token', async () => {
    (MeteringRecord.create as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (BillingEvent.updateOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const service = new MeteringService();
    await service.meterEvent(
      event({
        eventType: 'model_call.aborted',
        payload: {
          modelId: 'gpt-5',
          estimated: true,
          estimatedInputTokens: 12,
          estimatedOutputTokens: 34,
        },
      }) as never,
    );
    const created = (MeteringRecord.create as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(created.dims).toMatchObject({ inputTokens: 12, outputTokens: 34 });
    expect(created.estimated).toBe(true);
  });

  it('T-AB2: aborted 记录在 dims 固化 20/80 拆分，实际三段与 quantity 不变', async () => {
    (MeteringRecord.create as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (BillingEvent.updateOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const service = new MeteringService();
    const result = await service.meterEvent(
      event({
        eventType: 'model_call.aborted',
        payload: {
          modelId: 'gpt-5',
          inputTokens: 100,
          cachedInputTokens: 30,
          outputTokens: 50,
        },
      }) as never,
    );
    const created = (MeteringRecord.create as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // 实际用量（事实）保持事件原值，不被计价口径污染
    expect(created.dims).toMatchObject({
      modelId: 'gpt-5',
      inputTokens: 100,
      cachedInputTokens: 30,
      outputTokens: 50,
      estimated: false,
    });
    // 计价口径固化：20% 未缓存 + 80% 缓存，且两段和 = 实际输入总量
    expect(created.dims.aborted).toBe(true);
    expect(created.dims.billedInputCachedTokens).toBe(80);
    expect(created.dims.billedInputNonCachedTokens).toBe(20);
    expect(
      created.dims.billedInputCachedTokens + created.dims.billedInputNonCachedTokens,
    ).toBe(created.dims.inputTokens);
    // quantity 仍是事实口径（input + output）
    expect(created.quantity).toBe(150);
    expect(result?.quantity).toBe(150);
  });

  it('T-AB2: completed 记录不写拆分字段', async () => {
    (MeteringRecord.create as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (BillingEvent.updateOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const service = new MeteringService();
    await service.meterEvent(
      event({
        eventType: 'model_call.completed',
        payload: { modelId: 'gpt-5', inputTokens: 100, cachedInputTokens: 30, outputTokens: 50 },
      }) as never,
    );
    const created = (MeteringRecord.create as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(created.dims.aborted).toBeUndefined();
    expect(created.dims.billedInputCachedTokens).toBeUndefined();
    expect(created.dims.billedInputNonCachedTokens).toBeUndefined();
  });

  it('T-AB2: estimated 兜底后输入同样按 20/80 拆分（拆分基数为估算归一后的输入）', async () => {
    (MeteringRecord.create as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (BillingEvent.updateOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const service = new MeteringService();
    await service.meterEvent(
      event({
        eventType: 'model_call.aborted',
        payload: {
          modelId: 'gpt-5',
          estimated: true,
          estimatedInputTokens: 12,
          estimatedOutputTokens: 34,
        },
      }) as never,
    );
    const created = (MeteringRecord.create as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(created.estimated).toBe(true);
    expect(created.dims.billedInputCachedTokens).toBe(10); // round(12 × 0.8)
    expect(created.dims.billedInputNonCachedTokens).toBe(2);
    expect(
      created.dims.billedInputCachedTokens + created.dims.billedInputNonCachedTokens,
    ).toBe(created.dims.inputTokens);
  });
});
