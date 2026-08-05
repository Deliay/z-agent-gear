import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('./mcp-endpoint.js', () => ({
  mcpEndpointService: {
    revokeEndpoint: vi.fn(),
  },
}));

import { getRedisClient } from '../middleware/redis.js';
import { mcpEndpointService } from './mcp-endpoint.js';
import { McpEndpointRevokeSubscriber } from './mcp-endpoint-subscriber.js';

type MessageHandler = (channel: string, message: string) => Promise<void> | void;

let messageHandler: MessageHandler;

const subscriber = {
  subscribe: vi.fn().mockResolvedValue(undefined),
  on: vi.fn((event: string, cb: MessageHandler) => {
    if (event === 'message') messageHandler = cb;
  }),
  unsubscribe: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRedisClient).mockReturnValue({ duplicate: vi.fn().mockReturnValue(subscriber) } as never);
});

function startSubscriber(): McpEndpointRevokeSubscriber {
  const sub = new McpEndpointRevokeSubscriber();
  sub.start();
  return sub;
}

describe('McpEndpointRevokeSubscriber', () => {
  it('should subscribe to session:status', () => {
    startSubscriber();

    expect(subscriber.subscribe).toHaveBeenCalledWith('session:status');
  });

  it('should revoke the endpoint when a session ends', async () => {
    startSubscriber();

    await messageHandler('session:status', JSON.stringify({ sessionId: 'sess-1', status: 'ended' }));

    expect(mcpEndpointService.revokeEndpoint).toHaveBeenCalledWith('sess-1');
  });

  it('should revoke the endpoint when a session is removed', async () => {
    startSubscriber();

    await messageHandler('session:status', JSON.stringify({ sessionId: 'sess-2', status: 'removed' }));

    expect(mcpEndpointService.revokeEndpoint).toHaveBeenCalledWith('sess-2');
  });

  it('should ignore non-terminal statuses', async () => {
    startSubscriber();

    await messageHandler('session:status', JSON.stringify({ sessionId: 'sess-1', status: 'idling' }));
    await messageHandler('session:status', JSON.stringify({ sessionId: 'sess-1', status: 'running' }));

    expect(mcpEndpointService.revokeEndpoint).not.toHaveBeenCalled();
  });

  it('should ignore malformed messages', async () => {
    startSubscriber();

    await messageHandler('session:status', 'not-json');
    await messageHandler('session:status', JSON.stringify({ status: 'ended' }));

    expect(mcpEndpointService.revokeEndpoint).not.toHaveBeenCalled();
  });
});
