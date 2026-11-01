import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

import { getRedisClient } from '../middleware/redis.js';
import { McpForwardConsumer } from './mcp-forward-consumer.js';

interface MockRedis {
  duplicate: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
}

function makeMockRedis(): MockRedis {
  return {
    duplicate: vi.fn(),
    subscribe: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    publish: vi.fn().mockResolvedValue(1),
    disconnect: vi.fn(),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
  };
}

function createContext() {
  const mockRedis = makeMockRedis();
  const subscriber = makeMockRedis();
  mockRedis.duplicate.mockReturnValue(subscriber);

  let messageHandler: ((channel: string, message: string) => void) | undefined;
  subscriber.on.mockImplementation((event: string, cb: (channel: string, message: string) => void) => {
    if (event === 'message') messageHandler = cb;
  });

  vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);

  const registry = {
    hasActiveProxy: vi.fn(),
    forwardRequest: vi.fn(),
  };

  const consumer = new McpForwardConsumer(registry as never, mockRedis as never);
  consumer.start();

  return {
    mockRedis,
    subscriber,
    registry,
    trigger: (channel: string, message: string) => messageHandler?.(channel, message),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('McpForwardConsumer', () => {
  it('should subscribe to mcp:forward:request', () => {
    const { subscriber } = createContext();
    expect(subscriber.subscribe).toHaveBeenCalledWith('mcp:forward:request');
  });

  it('should ignore request when not the owner of the proxy', async () => {
    const { registry, trigger } = createContext();
    registry.hasActiveProxy.mockReturnValue(false);

    await trigger('mcp:forward:request', JSON.stringify({
      requestId: 'req-1',
      serverId: 'server-1',
      sessionId: 'sess-1',
      request: { method: 'tools/list' },
    }));

    expect(registry.forwardRequest).not.toHaveBeenCalled();
  });

  it('should forward request and publish response when owner', async () => {
    const { registry, mockRedis, trigger } = createContext();
    registry.hasActiveProxy.mockReturnValue(true);
    registry.forwardRequest.mockResolvedValue({ jsonrpc: '2.0', result: { tools: [] } });

    await trigger('mcp:forward:request', JSON.stringify({
      requestId: 'req-1',
      serverId: 'server-1',
      sessionId: 'sess-1',
      request: { method: 'tools/list' },
    }));

    expect(registry.forwardRequest).toHaveBeenCalledWith('proxy_server-1', { method: 'tools/list' });
    expect(mockRedis.publish).toHaveBeenCalled();
    const fwdCall = mockRedis.publish.mock.calls.at(-1)! as [string, string];
    expect(fwdCall[0]).toBe('mcp:forward:response');
    expect(JSON.parse(fwdCall[1])).toMatchObject({
      requestId: 'req-1',
      response: { jsonrpc: '2.0', result: { tools: [] } },
    });
  });

  it('should publish error when forwarding fails', async () => {
    const { registry, mockRedis, trigger } = createContext();
    registry.hasActiveProxy.mockReturnValue(true);
    registry.forwardRequest.mockRejectedValue(new Error('boom'));

    await trigger('mcp:forward:request', JSON.stringify({
      requestId: 'req-2',
      serverId: 'server-1',
      sessionId: 'sess-1',
      request: { method: 'tools/call' },
    }));

    expect(mockRedis.publish).toHaveBeenCalled();
    const errCall = mockRedis.publish.mock.calls.at(-1)! as [string, string];
    expect(errCall[0]).toBe('mcp:forward:response');
    expect(JSON.parse(errCall[1])).toMatchObject({
      requestId: 'req-2',
      error: { code: 'FORWARD_ERROR', message: 'boom' },
    });
  });

  it('should not crash on malformed message', () => {
    const { trigger } = createContext();
    expect(() => trigger('mcp:forward:request', 'not json')).not.toThrow();
  });
});
