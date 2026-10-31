import { describe, it, expect, vi, beforeEach } from 'vitest';

const { connectMock } = vi.hoisted(() => ({ connectMock: vi.fn() }));
vi.mock('amqplib', () => ({ default: { connect: connectMock } }));

import { MqConnection } from './connection.js';
import { createTestLogger } from '../../../observability/testing.js';

/** 静音 logger（无断言路径注入）。 */
const silentLogger = createTestLogger('billing-mq').logger;

function fakeModel() {
  const channel = { close: vi.fn() };
  const model = {
    on: vi.fn(),
    createChannel: vi.fn(async () => channel),
    createConfirmChannel: vi.fn(async () => channel),
    close: vi.fn(async () => undefined),
  };
  return { model, channel };
}

describe('MqConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('连接复用 + channel 创建 + 关闭', async () => {
    const { model } = fakeModel();
    connectMock.mockResolvedValue(model);
    const connection = new MqConnection('amqp://x', silentLogger);
    const channel = await connection.createChannel();
    expect(connectMock).toHaveBeenCalledWith('amqp://x', { timeout: 10000 });
    expect(channel).toBeDefined();
    await connection.createConfirmChannel();
    expect(model.createConfirmChannel).toHaveBeenCalled();
    // 第二次取 model 不重复连接
    await connection.createChannel();
    expect(connectMock).toHaveBeenCalledTimes(1);
    await connection.close();
    expect(model.close).toHaveBeenCalled();
  });

  it('连接关闭/错误回调可安全处理，close 幂等', async () => {
    const { model } = fakeModel();
    connectMock.mockResolvedValue(model);
    const warn = vi.fn();
    const connection = new MqConnection('amqp://x', { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() });
    await connection.createChannel();
    const closeHandler = model.on.mock.calls.find((call) => call[0] === 'close')?.[1] as () => void;
    const errorHandler = model.on.mock.calls.find((call) => call[0] === 'error')?.[1] as (e: Error) => void;
    closeHandler();
    errorHandler(new Error('boom'));
    // 新签名断言：(obj, msg)，err 进 err 字段（旧形态第二参会被静默丢弃）
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ message: 'boom' }) }),
      expect.stringContaining('connection error'),
    );
    await connection.close();
    await connection.close();
  });

  it('默认向 amqp.connect 透传 10s 握手超时（防代理接受 TCP 但握手卡死）', async () => {
    const { model } = fakeModel();
    connectMock.mockResolvedValue(model);
    const connection = new MqConnection('amqp://x', silentLogger);
    await connection.createChannel();
    expect(connectMock).toHaveBeenCalledWith('amqp://x', { timeout: 10000 });
    await connection.close();
  });

  it('握手超时可通过 connectTimeoutMs 覆盖', async () => {
    const { model } = fakeModel();
    connectMock.mockResolvedValue(model);
    const connection = new MqConnection('amqp://x', silentLogger, 3000);
    await connection.createChannel();
    expect(connectMock).toHaveBeenCalledWith('amqp://x', { timeout: 3000 });
    await connection.close();
  });
});
