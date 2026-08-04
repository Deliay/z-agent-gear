import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

import { getRedisClient } from '../middleware/redis.js';
import { McpForwarder } from './mcp-forwarder.js';

const REQUEST_CHANNEL = 'mcp:forward:request';
const RESPONSE_CHANNEL = 'mcp:forward:response';

const messageHandlers: Array<(channel: string, message: string) => void> = [];

const subscriber = {
  subscribe: vi.fn().mockResolvedValue(undefined),
  on: vi.fn((event: string, cb: (channel: string, message: string) => void) => {
    if (event === 'message') {
      messageHandlers.push(cb);
    }
  }),
  off: vi.fn(),
  disconnect: vi.fn(),
};

const redisClient = {
  duplicate: vi.fn().mockReturnValue(subscriber),
  publish: vi.fn().mockResolvedValue(1),
  set: vi.fn().mockResolvedValue('OK'),
  get: vi.fn().mockResolvedValue(null),
  del: vi.fn().mockResolvedValue(1),
};

beforeEach(() => {
  vi.clearAllMocks();
  messageHandlers.length = 0;
  vi.mocked(getRedisClient).mockReturnValue(redisClient as never);
});

function flushPromises(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('McpForwarder', () => {
  it('should subscribe to response channel and publish request with requestId', async () => {
    const forwarder = new McpForwarder();
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/call' };

    const promise = forwarder.request({ serverId: 'server-1', sessionId: 'session-1', request });
    // The request publishes only after the response-channel subscription is active.
    await flushPromises();

    expect(subscriber.subscribe).toHaveBeenCalledWith(RESPONSE_CHANNEL);
    expect(redisClient.publish).toHaveBeenCalledWith(REQUEST_CHANNEL, expect.any(String));

    const published = JSON.parse(vi.mocked(redisClient.publish).mock.calls[0][1] as string) as {
      requestId: string;
      serverId: string;
      sessionId: string;
      request: unknown;
    };
    expect(published.requestId).toEqual(expect.any(String));
    expect(published.serverId).toBe('server-1');
    expect(published.sessionId).toBe('session-1');
    expect(published.request).toEqual(request);

    const onMessage = messageHandlers[0];
    onMessage(RESPONSE_CHANNEL, JSON.stringify({ requestId: published.requestId, response: { jsonrpc: '2.0', result: 'ok' } }));
    await expect(promise).resolves.toEqual({ jsonrpc: '2.0', result: 'ok' });
    expect(subscriber.off).toHaveBeenCalledWith('message', onMessage);
  });

  it('should ignore responses with non-matching requestId', async () => {
    const forwarder = new McpForwarder();
    const promise = forwarder.request({ serverId: 'server-1', sessionId: 'session-1', request: { method: 'x' } });
    await flushPromises();

    let resolved: unknown = undefined;
    promise.then(value => { resolved = value; });

    const published = JSON.parse(vi.mocked(redisClient.publish).mock.calls[0][1] as string) as { requestId: string };
    const onMessage = messageHandlers[0];

    onMessage(RESPONSE_CHANNEL, JSON.stringify({ requestId: 'other-request-id', response: { result: 'nope' } }));
    await flushPromises();
    expect(resolved).toBeUndefined();

    onMessage(RESPONSE_CHANNEL, JSON.stringify({ requestId: published.requestId, response: { result: 'yep' } }));
    await expect(promise).resolves.toEqual({ result: 'yep' });
  });

  it('should reject with FORWARD_TIMEOUT code when no matching response arrives', async () => {
    const forwarder = new McpForwarder(20);

    const promise = forwarder.request({ serverId: 'server-1', sessionId: 'session-1', request: { method: 'x' } });

    await expect(promise).rejects.toMatchObject({ name: 'ForwardError', code: 'FORWARD_TIMEOUT' });
    expect(subscriber.off).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('should reject with the original error code when response contains error', async () => {
    const forwarder = new McpForwarder();
    const promise = forwarder.request({ serverId: 'server-1', sessionId: 'session-1', request: { method: 'x' } });
    await flushPromises();

    const published = JSON.parse(vi.mocked(redisClient.publish).mock.calls[0][1] as string) as { requestId: string };
    const onMessage = messageHandlers[0];

    onMessage(RESPONSE_CHANNEL, JSON.stringify({
      requestId: published.requestId,
      error: { code: 'FORWARD_ERROR', message: 'forward exploded' },
    }));
    await expect(promise).rejects.toMatchObject({ name: 'ForwardError', code: 'FORWARD_ERROR', message: 'forward exploded' });
  });
});
