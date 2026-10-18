import { describe, it, expect, vi, beforeEach } from 'vitest';

const { connectMock } = vi.hoisted(() => ({ connectMock: vi.fn() }));
vi.mock('amqplib', () => ({ default: { connect: connectMock } }));

import { MqConnection } from './connection.js';

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
    const connection = new MqConnection('amqp://x', { warn: vi.fn() });
    const channel = await connection.createChannel();
    expect(connectMock).toHaveBeenCalledWith('amqp://x');
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
    const connection = new MqConnection('amqp://x', { warn });
    await connection.createChannel();
    const closeHandler = model.on.mock.calls.find((call) => call[0] === 'close')?.[1] as () => void;
    const errorHandler = model.on.mock.calls.find((call) => call[0] === 'error')?.[1] as (e: Error) => void;
    closeHandler();
    errorHandler(new Error('boom'));
    expect(warn).toHaveBeenCalled();
    await connection.close();
    await connection.close();
  });
});
