import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

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
import { createTestLogger } from '../observability/testing.js';
import type { ObservationLogger } from '../observability/logger.js';
import { installSpanCapture } from '../test-support/tracing.js';

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

function createContext(serviceLogger?: ObservationLogger) {
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

  const service = new McpRelayService(serviceLogger);

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

    expect(mockRedis.publish).toHaveBeenCalled();
    const relayCall = mockRedis.publish.mock.calls.at(-1)! as [string, string];
    expect(relayCall[0]).toBe('mcp:relay:request');
    expect(JSON.parse(relayCall[1])).toMatchObject({
      requestId: 'mcpreq_1',
      sessionId: 'sess-1',
      serverName: 'server-1',
      token: 'token-1',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
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
      _meta: {},
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

    expect(socket.emit).toHaveBeenCalledWith('mcp:response', { requestId: 'mcpreq_2', status: 404, body: {}, _meta: {} });
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

    expect(socket.emit).toHaveBeenCalledWith('mcp:response', { requestId: 'mcpreq_3', status: 504, body: {}, _meta: {} });
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
        _meta: {},
      }],
      ['mcp:response', {
        requestId: 'mcpreq_a',
        status: 200,
        body: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'A' }] } },
        _meta: {},
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

    expect(socket.emit).toHaveBeenCalledWith('mcp:response', { requestId: 'mcpreq_x', status: 503, body: {}, _meta: {} });
    expect(subscribers[0].sub.disconnect).toHaveBeenCalled();
  });
});

describe('McpRelayService 链路回程（A4）', () => {
  const PARENT_TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
  const PARENT_SPAN_ID = 'b7ad6b7169203331';
  const PARENT_TP = `00-${PARENT_TRACE_ID}-${PARENT_SPAN_ID}-01`;
  const TP_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;

  let capture: ReturnType<typeof installSpanCapture>;

  beforeAll(() => {
    // 延后安装追踪捕获：避免影响本文件其他用例（无活跃 span 时 `_meta` 为空对象）的断言
    capture = installSpanCapture();
  });

  beforeEach(() => {
    capture.reset();
  });

  it('mcp:relay:response handle 以 _meta.traceparent 为 parent（span 父子），回程 emit 注入 _meta 续链', async () => {
    const { service, triggerOn } = createContext();
    const socket = createMockSocket();
    vi.mocked(acpSessionManager.sessionBelongsToController).mockReturnValue(true);

    await service.handleMcpRequest(socket as never, {
      requestId: 'mcpreq_tp',
      sessionId: 'sess-1',
      serverName: 'server-1',
      token: 'token-1',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call' },
    });

    triggerOn(0, 'mcp:relay:response:mcpreq_tp', JSON.stringify({
      requestId: 'mcpreq_tp',
      status: 200,
      body: { ok: true },
      _meta: { traceparent: PARENT_TP },
    }));

    const span = capture.find('mcp:relay:response handle');
    expect(span).toBeDefined();
    // 父子：handle span 挂在报文 `_meta.traceparent` 之下（socket → mcp:relay:request → agent-api → 回程续链）
    expect(span?.parentSpanContext?.traceId).toBe(PARENT_TRACE_ID);
    expect(span?.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID);
    // 回程下发 emit 顶层注入 `_meta.traceparent`（指向 handle span，供 controller 侧续链）
    const emit = socket.emit.mock.calls.at(-1)! as [string, { _meta?: { traceparent?: string } }];
    expect(emit[0]).toBe('mcp:response');
    expect(emit[1]._meta?.traceparent).toMatch(TP_RE);
    expect(emit[1]._meta?.traceparent).toBe(`00-${span?.spanContext().traceId}-${span?.spanContext().spanId}-01`);
  });

  it('无 _meta 容错：handle span 照常创建（root），emit 仍注入 _meta', async () => {
    const { service, triggerOn } = createContext();
    const socket = createMockSocket();
    vi.mocked(acpSessionManager.sessionBelongsToController).mockReturnValue(true);

    await service.handleMcpRequest(socket as never, {
      requestId: 'mcpreq_nor',
      sessionId: 'sess-1',
      serverName: 'server-1',
      token: 'token-1',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call' },
    });

    triggerOn(0, 'mcp:relay:response:mcpreq_nor', JSON.stringify({
      requestId: 'mcpreq_nor',
      status: 200,
      body: { ok: true },
    }));

    const span = capture.find('mcp:relay:response handle');
    expect(span).toBeDefined();
    expect(span?.parentSpanContext).toBeUndefined();
    const emit = socket.emit.mock.calls.at(-1)! as [string, { _meta?: { traceparent?: string } }];
    expect(emit[1]._meta?.traceparent).toBe(`00-${span?.spanContext().traceId}-${span?.spanContext().spanId}-01`);
  });

  it('A4: 非法响应报文 → 502，错误对象进 err 字段留痕（不再静默）', async () => {
    const testLog = createTestLogger('mcp-relay');
    const { service, triggerOn } = createContext(testLog.logger);
    const socket = createMockSocket();
    vi.mocked(acpSessionManager.sessionBelongsToController).mockReturnValue(true);

    await service.handleMcpRequest(socket as never, {
      requestId: 'mcpreq_bad',
      sessionId: 'sess-1',
      serverName: 'server-1',
      token: 'token-1',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call' },
    });

    triggerOn(0, 'mcp:relay:response:mcpreq_bad', 'invalid-json');

    expect(socket.emit).toHaveBeenCalledWith('mcp:response', {
      requestId: 'mcpreq_bad',
      status: 502,
      body: {},
      _meta: {},
    });
    const rec = testLog.records.find((r) => r.msg === 'failed to handle mcp:relay:response');
    expect(rec?.level).toBe('error');
    expect(rec?.err).toBeTruthy();
    expect(rec?.requestId).toBe('mcpreq_bad');
  });
});