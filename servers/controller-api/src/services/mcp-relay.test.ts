import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('./acp-session-manager.js', () => ({
  acpSessionManager: {
    sessionBelongsToController: vi.fn(),
  },
}));

import { getRedisClient } from '../middleware/redis.js';
import { acpSessionManager } from './acp-session-manager.js';
import { McpRelayService } from './mcp-relay.js';

interface MockRedis {
  duplicate: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function makeMockRedis(): MockRedis {
  return {
    duplicate: vi.fn(),
    publish: vi.fn().mockResolvedValue(1),
    on: vi.fn(),
    off: vi.fn(),
    subscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  };
}

function createMockSocket() {
  const emit = vi.fn();
  return {
    id: 'socket-123',
    data: { controllerId: 'ctrl123' },
    emit,
  };
}

function createContext() {
  const mockRedis = makeMockRedis();
  vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);

  const subscribers: Array<{
    sub: MockRedis;
    messageHandler?: (channel: string, message: string) => void;
  }> = [];

  mockRedis.duplicate.mockImplementation(() => {
    const sub = makeMockRedis();
    const entry: { sub: MockRedis; messageHandler?: (channel: string, message: string) => void } = { sub };
    sub.on.mockImplementation((event: string, cb: (channel: string, message: string) => void) => {
      if (event === 'message') entry.messageHandler = cb;
    });
    sub.off.mockImplementation(() => {
      entry.messageHandler = undefined;
    });
    subscribers.push(entry);
    return sub;
  });

  const service = new McpRelayService();

  return {
    mockRedis,
    subscribers,
    service,
    triggerOn: (index: number, channel: string, message: string) =>
      subscribers[index]?.messageHandler?.(channel, message),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('McpRelayService', () => {
  it('T-S1: should forward mcp:request to Redis and emit mcp:response on relay response', async () => {
    const { mockRedis, subscribers, service, triggerOn } = createContext();
    const socket = createMockSocket();
    vi.mocked(acpSessionManager.sessionBelongsToController).mockReturnValue(true);

    await service.handleMcpRequest(socket as never, {
      requestId: 'mcpreq_1',
      sessionId: 'sess-1',
      serverName: 'server-1',
      token: 'token-1',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });

    expect(mockRedis.publish).toHaveBeenCalledWith(
      'mcp:relay:request',
      JSON.stringify({
        requestId: 'mcpreq_1',
        sessionId: 'sess-1',
        serverName: 'server-1',
        token: 'token-1',
        body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      }),
    );
    expect(subscribers[0].sub.subscribe).toHaveBeenCalledWith('mcp:relay:response:mcpreq_1');

    triggerOn(0, 'mcp:relay:response:mcpreq_1', JSON.stringify({
      requestId: 'mcpreq_1',
      status: 200,
      body: { jsonrpc: '2.0', id: 1, result: { tools: [] } },
    }));

    expect(socket.emit).toHaveBeenCalledWith('mcp:response', {
      requestId: 'mcpreq_1',
      status: 200,
      body: { jsonrpc: '2.0', id: 1, result: { tools: [] } },
    });
    expect(subscribers[0].sub.disconnect).toHaveBeenCalled();
  });

  it('T-S2: should return 404 without publishing when session does not belong to controller', async () => {
    const { mockRedis, service } = createContext();
    const socket = createMockSocket();
    vi.mocked(acpSessionManager.sessionBelongsToController).mockReturnValue(false);

    await service.handleMcpRequest(socket as never, {
      requestId: 'mcpreq_2',
      sessionId: 'other-sess',
      serverName: 'server-1',
      token: 'token-1',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });

    expect(socket.emit).toHaveBeenCalledWith('mcp:response', { requestId: 'mcpreq_2', status: 404, body: {} });
    expect(mockRedis.publish).not.toHaveBeenCalled();
  });

  it('T-S3: should return 504 and clean up after 60s without a response', async () => {
    vi.useFakeTimers();
    const { mockRedis, subscribers, service } = createContext();
    const socket = createMockSocket();
    vi.mocked(acpSessionManager.sessionBelongsToController).mockReturnValue(true);

    await service.handleMcpRequest(socket as never, {
      requestId: 'mcpreq_3',
      sessionId: 'sess-1',
      serverName: 'server-1',
      token: 'token-1',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call' },
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(socket.emit).toHaveBeenCalledWith('mcp:response', { requestId: 'mcpreq_3', status: 504, body: {} });
    expect(subscribers[0].sub.disconnect).toHaveBeenCalled();
    expect(mockRedis.publish).toHaveBeenCalled();
  });

  it('T-S4: should match concurrent requests by requestId without cross-talk', async () => {
    const { subscribers, service, triggerOn } = createContext();
    const socket = createMockSocket();
    vi.mocked(acpSessionManager.sessionBelongsToController).mockReturnValue(true);

    await service.handleMcpRequest(socket as never, {
      requestId: 'mcpreq_a',
      sessionId: 'sess-1',
      serverName: 'server-1',
      token: 'token-1',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call' },
    });
    await service.handleMcpRequest(socket as never, {
      requestId: 'mcpreq_b',
      sessionId: 'sess-1',
      serverName: 'server-2',
      token: 'token-1',
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call' },
    });

    triggerOn(1, 'mcp:relay:response:mcpreq_b', JSON.stringify({
      requestId: 'mcpreq_b',
      status: 200,
      body: { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'B' }] } },
    }));
    triggerOn(0, 'mcp:relay:response:mcpreq_a', JSON.stringify({
      requestId: 'mcpreq_a',
      status: 200,
      body: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'A' }] } },
    }));

    const emitCalls = socket.emit.mock.calls.filter(([event]) => event === 'mcp:response');
    expect(emitCalls).toEqual([
      ['mcp:response', {
        requestId: 'mcpreq_b',
        status: 200,
        body: { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'B' }] } },
      }],
      ['mcp:response', {
        requestId: 'mcpreq_a',
        status: 200,
        body: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'A' }] } },
      }],
    ]);
  });

  it('T-S4b: should fail all pending requests with 503 on socket disconnect', async () => {
    const { subscribers, service } = createContext();
    const socket = createMockSocket();
    vi.mocked(acpSessionManager.sessionBelongsToController).mockReturnValue(true);

    await service.handleMcpRequest(socket as never, {
      requestId: 'mcpreq_x',
      sessionId: 'sess-1',
      serverName: 'server-1',
      token: 'token-1',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call' },
    });

    service.handleSocketDisconnect('socket-123');

    expect(socket.emit).toHaveBeenCalledWith('mcp:response', { requestId: 'mcpreq_x', status: 503, body: {} });
    expect(subscribers[0].sub.disconnect).toHaveBeenCalled();
  });
});