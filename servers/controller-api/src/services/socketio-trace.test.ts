/**
 * A2 回归：socket 事件链路可观测性。
 * - socket 事件 → Redis 发布报文顶层 `_meta.traceparent` 非空且指向 `socket.<event>` span（活跃 span 注入）；
 * - span 父子关系：`socket.<event>` parent = 握手 traceparent（T-OBS13）；消费端以报文 `_meta` 为 parent
 *   建 span 即为其子 span（socket → 跨服务续链）；
 * - 管理器下发 `socket.emit` 统一注入顶层 `_meta`（elicitation 全回程验证）；
 * - F11 豁免：acp:message / acp:load-session:message / port-forward:data / heartbeat 不逐条开 span。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('./key-cache.js', () => ({
  lookupKey: vi.fn(),
}));

vi.mock('../models/controller-key.js', () => ({
  ControllerKey: {
    findById: vi.fn(),
    updateOne: vi.fn(),
    deleteOne: vi.fn(),
  },
}));

vi.mock('../models/controller.js', () => ({
  Controller: {
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
    deleteOne: vi.fn(),
  },
}));

vi.mock('../models/session.js', () => ({
  Session: {
    find: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
  },
}));

vi.mock('./session.js', () => ({
  sessionService: {
    acquireSession: vi.fn(),
    storeResumeToken: vi.fn().mockResolvedValue('test-resume-token'),
    refreshSession: vi.fn(),
    updateHeartbeat: vi.fn(),
    cleanupKey: vi.fn(),
    removeSession: vi.fn(),
  },
}));

vi.mock('bcryptjs', () => ({
  default: {
    compare: vi.fn(),
  },
}));

vi.mock('./acp-session-manager.js', () => ({
  acpSessionManager: {
    reconcileOnRegister: vi.fn().mockResolvedValue(undefined),
    sessionBelongsToController: vi.fn().mockReturnValue(true),
    handleControllerMessage: vi.fn().mockResolvedValue(undefined),
    handlePromptStart: vi.fn().mockResolvedValue(undefined),
  },
}));

import { createSocketIOServer } from './socketio.js';
import { ControllerKey } from '../models/controller-key.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import { lookupKey } from './key-cache.js';
import { getRedisClient } from '../middleware/redis.js';
import { acpSessionManager } from './acp-session-manager.js';
import { elicitationManager } from './elicitation-manager.js';
import { mcpRelayService } from './mcp-relay.js';
import bcrypt from 'bcryptjs';
import { withSpan } from '../observability/trace.js';
import { installSpanCapture, type SpanCapture } from '../test-support/tracing.js';

// 客户端握手链路上下文（W3C traceparent）：断言 socket span 为其子 span
const PARENT_TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const PARENT_SPAN_ID = 'b7ad6b7169203331';
const HANDSHAKE_TP = `00-${PARENT_TRACE_ID}-${PARENT_SPAN_ID}-01`;
const TP_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;

interface MockSocket {
  id: string;
  handshake: { address: string; headers: Record<string, string>; query: Record<string, string>; auth: Record<string, unknown> };
  nsp: { name: string };
  data: Record<string, unknown>;
  join: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  _trigger: (event: string, ...args: unknown[]) => void;
}

function createMockSocket(): MockSocket {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    id: 'socket-123',
    handshake: {
      address: '127.0.0.1',
      headers: { 'user-agent': 'vitest' },
      query: { transport: 'websocket' },
      auth: { traceparent: HANDSHAKE_TP },
    },
    nsp: { name: '/' },
    data: {} as Record<string, unknown>,
    join: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handler;
    }),
    _trigger: (event: string, ...args: unknown[]) => handlers[event]?.(...args),
  };
}

const mockRedis = {
  publish: vi.fn().mockResolvedValue(1),
  duplicate: vi.fn(),
  lrange: vi.fn().mockResolvedValue([]),
  del: vi.fn().mockResolvedValue(1),
};

interface SubMock {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  messageHandler?: (channel: string, message: string) => void;
}

const subscribers: SubMock[] = [];

function createMockIO(socket: MockSocket) {
  const connectionHandler = vi.fn();
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'connection') connectionHandler(handler);
    }),
    engine: {
      on: vi.fn(),
    },
    sockets: {
      sockets: new Map([[socket.id, socket]]),
    },
    _connectionHandler: connectionHandler,
  };
}

async function registerAuthenticated(mockSocket: MockSocket, mockIO: ReturnType<typeof createMockIO>): Promise<void> {
  vi.mocked(lookupKey).mockResolvedValue({
    keyId: 'key123',
    keyHash: 'hashed-key',
    userId: 'user1',
    status: 'active',
    type: 'local',
  } as never);
  vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
  vi.mocked(sessionService.acquireSession).mockResolvedValue(true);
  vi.mocked(Controller.findOneAndUpdate).mockResolvedValue({
    _id: { toString: () => 'ctrl123' },
  } as never);
  vi.mocked(ControllerKey.findById).mockReturnValue({
    select: () => ({ lean: async () => ({ tenantId: 'user1', workspaceId: null }) }),
  } as never);
  vi.mocked(ControllerKey.updateOne).mockResolvedValue({} as never);

  createSocketIOServer(mockIO as never);
  const connectionHandler = mockIO._connectionHandler.mock.calls[0][0] as (socket: MockSocket) => void;
  connectionHandler(mockSocket);
  mockSocket._trigger('register', { key: 'zag_k_1_abc123', hostname: 'dev-machine', version: '2.0.0' });
  await vi.waitFor(() => {
    expect(mockSocket.emit).toHaveBeenCalledWith('registered', expect.anything());
  });
  mockSocket.emit.mockClear();
}

function lastPublishBody(channel: string): Record<string, unknown> {
  const calls = vi.mocked(mockRedis.publish).mock.calls.filter(([ch]) => ch === channel);
  const last = calls.at(-1)! as [string, string];
  return JSON.parse(last[1]) as Record<string, unknown>;
}

/** 异步 handler 的 span 在 handler 完成后的微任务里才 end/导出：用 waitFor 取已结束 span。 */
async function endedSpan(name: string) {
  await vi.waitFor(() => {
    expect(capture.find(name), `span ${name} should be recorded`).toBeDefined();
  });
  return capture.find(name)!;
}

let capture: SpanCapture;

beforeAll(() => {
  capture = installSpanCapture();
});

beforeEach(() => {
  vi.clearAllMocks();
  capture.reset();
  subscribers.length = 0;
  mockRedis.duplicate.mockImplementation(() => {
    const sub: SubMock = {
      on: vi.fn((event: string, cb: (channel: string, message: string) => void) => {
        if (event === 'message') sub.messageHandler = cb;
      }),
      off: vi.fn(),
      subscribe: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    };
    subscribers.push(sub);
    return sub;
  });
  vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
});

afterAll(() => {
  elicitationManager.stop();
});

describe('A2 socket 事件链路', () => {
  it('socket.<event> span 以握手 traceparent 为 parent（T-OBS13 父子①）', async () => {
    const mockSocket = createMockSocket();
    const mockIO = createMockIO(mockSocket);
    await registerAuthenticated(mockSocket, mockIO);

    mockSocket._trigger('acp:elicitation:complete', { sessionId: 'sess-1', elicitationId: 'el-1' });
    await vi.waitFor(() => {
      expect(mockRedis.publish).toHaveBeenCalledWith('elicitation:complete', expect.anything());
    });

    const span = await endedSpan('socket.acp:elicitation:complete');
    expect(span.parentSpanContext?.traceId).toBe(PARENT_TRACE_ID);
    expect(span.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID);
  });

  it('socket 事件 → Redis 发布报文 _meta.traceparent 非空且指向 socket.<event> span（父子②③）', async () => {
    const mockSocket = createMockSocket();
    const mockIO = createMockIO(mockSocket);
    await registerAuthenticated(mockSocket, mockIO);

    mockSocket._trigger('acp:permission', {
      requestId: 'req-tp-1',
      sessionId: 'sess-1',
      toolCall: { toolCallId: 'tc-1', title: 'run' },
      options: [{ optionId: 'opt-1', name: 'allow', kind: 'allow_once' }],
    });
    await vi.waitFor(() => {
      expect(mockRedis.publish).toHaveBeenCalledWith('permission:request', expect.anything());
    });

    const body = lastPublishBody('permission:request');
    const traceparent = (body._meta as { traceparent?: string })?.traceparent;
    // 父子②：发布报文 traceparent 非空，且指向 socket.acp:permission span 本身（活跃 span 注入）
    expect(traceparent).toMatch(TP_RE);
    const span = await endedSpan('socket.acp:permission');
    expect(traceparent).toBe(`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);

    // 父子③：消费端以 `_meta` 为 parent 建 span 即为 socket.acp:permission 的子 span（跨服务续链）
    await withSpan('permission:request handle', { 'messaging.system': 'redis' }, () => undefined, {
      parent: traceparent,
    });
    const child = capture.find('permission:request handle');
    expect(child?.parentSpanContext?.traceId).toBe(span.spanContext().traceId);
    expect(child?.parentSpanContext?.spanId).toBe(span.spanContext().spanId);
  });

  it('mcp:request → mcp:relay:request 发布 _meta.traceparent 非空（socket.mcp:request span）', async () => {
    const mockSocket = createMockSocket();
    const mockIO = createMockIO(mockSocket);
    vi.mocked(acpSessionManager.sessionBelongsToController).mockReturnValue(true);
    await registerAuthenticated(mockSocket, mockIO);

    mockSocket._trigger('mcp:request', {
      requestId: 'mcpreq-trace-1',
      sessionId: 'sess-1',
      serverName: 'server-1',
      token: 'token-1',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    await vi.waitFor(() => {
      expect(mockRedis.publish).toHaveBeenCalledWith('mcp:relay:request', expect.anything());
    });

    const body = lastPublishBody('mcp:relay:request');
    const traceparent = (body._meta as { traceparent?: string })?.traceparent;
    expect(traceparent).toMatch(TP_RE);
    const span = await endedSpan('socket.mcp:request');
    expect(traceparent).toBe(`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);

    mcpRelayService.handleSocketDisconnect(mockSocket.id);
  });

  it('管理器下发 socket.emit 注入 _meta：elicitation 全回程（请求 span → 响应 handle 子 span → 下发续链）', async () => {
    const mockSocket = createMockSocket();
    const mockIO = createMockIO(mockSocket);
    await registerAuthenticated(mockSocket, mockIO);
    elicitationManager.start(mockIO as never);

    // 1) socket 事件 → elicitation:request 发布（_meta 指向 socket.acp:elicitation span）
    mockSocket._trigger('acp:elicitation', {
      requestId: 'elic-trace-1',
      sessionId: 'sess-1',
      mode: 'form',
      message: 'need input',
    });
    await vi.waitFor(() => {
      expect(mockRedis.publish).toHaveBeenCalledWith('elicitation:request', expect.anything());
    });
    const requestSpan = await endedSpan('socket.acp:elicitation');
    const requestTp = (lastPublishBody('elicitation:request')._meta as { traceparent?: string }).traceparent;
    expect(requestTp).toBe(`00-${requestSpan.spanContext().traceId}-${requestSpan.spanContext().spanId}-01`);

    // 2) 模拟下游以 `_meta.traceparent` 为 parent 处理响应：elicitation:response handle 为子 span
    const responseSubscriber = subscribers.find((s) => s.messageHandler)?.messageHandler;
    expect(responseSubscriber).toBeDefined();
    responseSubscriber!(
      'elicitation:response',
      JSON.stringify({
        requestId: 'elic-trace-1',
        action: 'accept',
        content: { ok: true },
        _meta: { traceparent: requestTp },
      }),
    );
    await vi.waitFor(() => {
      expect(mockSocket.emit).toHaveBeenCalledWith('acp:elicitation:response', expect.anything());
    });

    const handleSpan = capture.find('elicitation:response handle');
    expect(handleSpan).toBeDefined();
    expect(handleSpan?.parentSpanContext?.spanId).toBe(requestSpan?.spanContext().spanId);
    expect(handleSpan?.parentSpanContext?.traceId).toBe(requestSpan?.spanContext().traceId);

    // 3) 管理器下发 emit 顶层注入 `_meta.traceparent`（指向 handle span，供 controller 侧续链）
    const emit = mockSocket.emit.mock.calls.at(-1)! as [string, { _meta?: { traceparent?: string } }];
    expect(emit[0]).toBe('acp:elicitation:response');
    expect(emit[1]._meta?.traceparent).toBe(
      `00-${handleSpan?.spanContext().traceId}-${handleSpan?.spanContext().spanId}-01`,
    );
  });

  it('unregister → unregistered 下发报文顶层 _meta.traceparent 非空且指向 socket.unregister span（A2 全量 withTraceMeta）', async () => {
    const mockSocket = createMockSocket();
    const mockIO = createMockIO(mockSocket);
    await registerAuthenticated(mockSocket, mockIO);

    mockSocket._trigger('unregister', { reason: 'bye' });
    await vi.waitFor(() => {
      expect(mockSocket.emit).toHaveBeenCalledWith('unregistered', expect.anything());
    });

    // 下发报文顶层注入 `_meta.traceparent`（活跃 socket.unregister span，与其它下发 emit 口径一致）
    const emit = mockSocket.emit.mock.calls.at(-1)! as [string, { _meta?: { traceparent?: string } }];
    expect(emit[0]).toBe('unregistered');
    expect(emit[1]._meta?.traceparent).toMatch(TP_RE);
    const span = await endedSpan('socket.unregister');
    expect(emit[1]._meta?.traceparent).toBe(
      `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`,
    );
  });

  it('F11 豁免：acp:message / acp:load-session:message / port-forward:data / heartbeat 不逐条开 span', async () => {
    const mockSocket = createMockSocket();
    const mockIO = createMockIO(mockSocket);
    await registerAuthenticated(mockSocket, mockIO);
    capture.reset();

    mockSocket._trigger('acp:message', { sessionId: 'sess-1', message: { type: 'agent_message_chunk', content: 'x' } });
    mockSocket._trigger('acp:load-session:message', { requestId: 'req-1', direction: 'input', type: 'text', content: 'x' });
    mockSocket._trigger('port-forward:data', { tunnelId: 't-1', data: Buffer.from('x').toString('base64') });
    mockSocket._trigger('heartbeat');
    await vi.waitFor(() => {
      expect(sessionService.refreshSession).toHaveBeenCalledWith('key123');
    });

    expect(acpSessionManager.handleControllerMessage).toHaveBeenCalled();
    expect(capture.names()).not.toContain('socket.acp:message');
    expect(capture.names()).not.toContain('socket.acp:load-session:message');
    expect(capture.names()).not.toContain('socket.port-forward:data');
    expect(capture.names()).not.toContain('socket.heartbeat');
    // 同批对照：常规事件仍开 span
    mockSocket._trigger('acp:prompt:start', { sessionId: 'sess-1' });
    await vi.waitFor(() => {
      expect(capture.names()).toContain('socket.acp:prompt:start');
    });
  });
});
