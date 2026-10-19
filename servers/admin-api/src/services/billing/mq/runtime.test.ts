import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { createChannelMock, connectionCloseMock, startMeteringMock, startSettlementMock } =
  vi.hoisted(() => ({
    createChannelMock: vi.fn(),
    connectionCloseMock: vi.fn(async () => undefined),
    startMeteringMock: vi.fn(async () => undefined),
    startSettlementMock: vi.fn(async () => undefined),
  }));

vi.mock('./connection.js', () => ({
  MqConnection: class {
    createChannel = createChannelMock;
    close = connectionCloseMock;
  },
}));
vi.mock('./consumers.js', () => ({
  startMeteringConsumer: startMeteringMock,
  startSettlementConsumer: startSettlementMock,
}));
vi.mock('./topology.js', () => ({
  declareBillingTopology: vi.fn(async () => undefined),
  publishSettlementCycle: vi.fn(async () => undefined),
}));

import { declareBillingTopology } from './topology.js';
import { BillingMqRuntime } from './runtime.js';

function channelStub() {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handler;
    }),
    close: vi.fn(async () => undefined),
    trigger: (event: string, ...args: unknown[]) => handlers[event]?.(...args),
  };
}

describe('BillingMqRuntime（断线自动重连）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('启动后声明拓扑并订阅两个消费者；stop 关闭连接', async () => {
    const channel = channelStub();
    createChannelMock.mockResolvedValue(channel);
    const runtime = new BillingMqRuntime({
      url: 'amqp://x',
      billing: {} as never,
      ingest: {} as never,
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    await runtime.start();
    expect(declareBillingTopology).toHaveBeenCalled();
    expect(startMeteringMock).toHaveBeenCalled();
    expect(startSettlementMock).toHaveBeenCalled();
    await runtime.stop();
    expect(channel.close).toHaveBeenCalled();
    expect(connectionCloseMock).toHaveBeenCalled();
  });

  it('channel 关闭后按退避重建（重新声明拓扑与订阅）', async () => {
    vi.useFakeTimers();
    const channel = channelStub();
    createChannelMock.mockResolvedValue(channel);
    const runtime = new BillingMqRuntime({
      url: 'amqp://x',
      billing: {} as never,
      ingest: {} as never,
      reconnectDelayMs: 1000,
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    await runtime.start();
    expect(createChannelMock).toHaveBeenCalledTimes(1);
    channel.trigger('close');
    await vi.advanceTimersByTimeAsync(1100);
    expect(createChannelMock).toHaveBeenCalledTimes(2);
    channel.trigger('error', new Error('boom'));
    await runtime.stop();
  });

  it('首次连接失败同样调度重连', async () => {
    vi.useFakeTimers();
    createChannelMock.mockRejectedValueOnce(new Error('down')).mockResolvedValue(channelStub());
    const runtime = new BillingMqRuntime({
      url: 'amqp://x',
      billing: {} as never,
      ingest: {} as never,
      reconnectDelayMs: 500,
      logger: { warn: vi.fn() },
    });
    await runtime.start();
    await vi.advanceTimersByTimeAsync(600);
    expect(createChannelMock).toHaveBeenCalledTimes(2);
    await runtime.stop();
  });
});
