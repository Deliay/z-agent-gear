import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/session.js', () => ({
  Session: {
    findByIdAndUpdate: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findByIdAndDelete: vi.fn(),
    find: vi.fn(),
    findById: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    }),
  },
}));

vi.mock('../models/acp-message.js', () => ({
  AcpMessage: {
    create: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

import { ACPSessionManager } from './acp-session-manager.js';
import { Session } from '../models/session.js';
import { AcpMessage } from '../models/acp-message.js';
import { getRedisClient } from '../middleware/redis.js';

const mockRedis = {
  publish: vi.fn(),
  set: vi.fn(),
  get: vi.fn(),
  lpush: vi.fn(),
  expire: vi.fn(),
  lrange: vi.fn(),
  del: vi.fn(),
};

function createMockSocket() {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    id: 'socket-123',
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    // 与真实 EventEmitter 一致：once 监听器首次触发后即移除
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers[event]) handlers[event] = [];
      const wrapped = (...args: unknown[]) => {
        handlers[event] = handlers[event].filter((h) => h !== wrapped);
        handler(...args);
      };
      handlers[event].push(wrapped);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (handlers[event]) {
        handlers[event] = handlers[event].filter((h) => h !== handler);
      }
    }),
    _handlers: handlers,
    _trigger(event: string, ...args: unknown[]) {
      for (const handler of handlers[event] ?? []) {
        handler(...args);
      }
    },
  };
}

function mockAcpMessageDoc() {
  return {
    _id: { toString: () => 'msg-1' },
    sessionId: { toString: () => 'sess-1' },
    direction: 'input',
    type: 'text',
    content: 'Hello',
    metadata: null,
    createdAt: new Date('2026-01-01'),
    toObject() { return { ...this }; },
  };
}

describe('ACPSessionManager', () => {
  let manager: ACPSessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
    manager = new ACPSessionManager();
  });

  describe('startSession', () => {
    it('should update status to connecting and emit acp:start', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ status: 'creating' }) } as never);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      const resultPromise = manager.startSession(
        socket as never, 'sess-1', 'ctrl-1', 'user-1', 'opencode', '/tmp',
      );

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:start', expect.objectContaining({
          sessionId: 'sess-1',
          serverType: 'opencode',
          cwd: '/tmp',
        }));
      });

      expect(Session.findByIdAndUpdate).toHaveBeenCalledWith('sess-1', { status: 'connecting' });
      expect(mockRedis.publish).toHaveBeenCalledWith('session:status', expect.stringContaining('"status":"connecting"'));

      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:start');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;

      socket._trigger('acp:start:result', {
        requestId,
        sessionId: 'sess-1',
        success: true,
        externalSessionId: 'ext-123',
      });

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.externalSessionId).toBe('ext-123');
    });

    it('should include mcpEndpoint in acp:start payload when provided', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ status: 'creating' }) } as never);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      const mcpEndpoint = { url: 'http://gateway/mcp/sess-1', token: 'tok', serverNames: ['github-mcp'] };
      const resultPromise = manager.startSession(
        socket as never, 'sess-1', 'ctrl-1', 'user-1', 'opencode', '/tmp', mcpEndpoint,
      );

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:start', expect.objectContaining({
          sessionId: 'sess-1',
          mcpEndpoint,
        }));
      });

      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:start');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;
      socket._trigger('acp:start:result', {
        requestId,
        sessionId: 'sess-1',
        success: true,
        externalSessionId: 'ext-123',
      });
      await resultPromise;
    });

    it('should include modeId/modelId in acp:start payload when provided', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ status: 'creating' }) } as never);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      const resultPromise = manager.startSession(
        socket as never, 'sess-1', 'ctrl-1', 'user-1', 'opencode', '/tmp', undefined,
        { modeId: 'code', modelId: 'gpt-5' },
      );

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:start', expect.objectContaining({
          sessionId: 'sess-1',
          modeId: 'code',
          modelId: 'gpt-5',
        }));
      });

      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:start');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;
      socket._trigger('acp:start:result', {
        requestId,
        sessionId: 'sess-1',
        success: true,
        externalSessionId: 'ext-123',
      });
      await resultPromise;
    });

    it('should omit modeId/modelId from acp:start payload when not provided', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ status: 'creating' }) } as never);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      const resultPromise = manager.startSession(
        socket as never, 'sess-1', 'ctrl-1', 'user-1', 'opencode', '/tmp',
      );

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:start', expect.objectContaining({ sessionId: 'sess-1' }));
      });

      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:start');
      const payload = emitArgs?.[1] as Record<string, unknown>;
      expect(payload.modeId).toBeUndefined();
      expect(payload.modelId).toBeUndefined();

      const requestId = payload?.requestId as string;
      socket._trigger('acp:start:result', {
        requestId,
        sessionId: 'sess-1',
        success: true,
        externalSessionId: 'ext-123',
      });
      await resultPromise;
    });

    it('should omit mcpEndpoint from acp:start payload when not provided', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ status: 'creating' }) } as never);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      const resultPromise = manager.startSession(
        socket as never, 'sess-1', 'ctrl-1', 'user-1', 'opencode', '/tmp',
      );

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:start', expect.objectContaining({ sessionId: 'sess-1' }));
      });

      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:start');
      const payload = emitArgs?.[1] as Record<string, unknown>;
      expect(payload.mcpEndpoint).toBeUndefined();

      const requestId = payload?.requestId as string;
      socket._trigger('acp:start:result', {
        requestId,
        sessionId: 'sess-1',
        success: true,
        externalSessionId: 'ext-123',
      });
      await resultPromise;
    });

    it('should delete session on controller start failure for creating session', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ status: 'creating' }) } as never);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);
      vi.mocked(AcpMessage.deleteMany).mockResolvedValue({} as never);
      vi.mocked(Session.findByIdAndDelete).mockResolvedValue({} as never);

      const resultPromise = manager.startSession(
        socket as never, 'sess-1', 'ctrl-1', 'user-1', 'opencode', '/tmp',
      );

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:start', expect.anything());
      });

      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:start');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;

      socket._trigger('acp:start:result', {
        requestId,
        sessionId: 'sess-1',
        success: false,
        error: 'OpenCode not found',
      });

      const result = await resultPromise;
      expect(result.success).toBe(false);
      // Controller explicitly reported failure — session kept with 'ended' status
      expect(Session.findByIdAndUpdate).toHaveBeenCalledWith('sess-1', { status: 'ended', endedAt: expect.any(Date) });
      expect(mockRedis.publish).toHaveBeenCalledWith('session:status', expect.stringContaining('"status":"ended"'));
    });

    it('should delete session on timeout for connecting session', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ status: 'connecting' }) } as never);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);
      vi.mocked(AcpMessage.deleteMany).mockResolvedValue({} as never);
      vi.mocked(Session.findByIdAndDelete).mockResolvedValue({} as never);

      const resultPromise = manager.startSession(
        socket as never, 'sess-1', 'ctrl-1', 'user-1', 'opencode', '/tmp',
      );

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:start', expect.anything());
      }, 1000);

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('ACP start timeout');
      expect(AcpMessage.deleteMany).toHaveBeenCalledWith({ sessionId: 'sess-1' });
      expect(Session.findByIdAndDelete).toHaveBeenCalledWith('sess-1');
    }, 35000);

    it('should mark as ended (not delete) when session was already running', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ status: 'running' }) } as never);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      const resultPromise = manager.startSession(
        socket as never, 'sess-1', 'ctrl-1', 'user-1', 'opencode', '/tmp',
      );

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:start', expect.anything());
      });

      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:start');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;

      socket._trigger('acp:start:result', {
        requestId,
        sessionId: 'sess-1',
        success: false,
        error: 'error',
      });

      await resultPromise;
      expect(Session.findByIdAndUpdate).toHaveBeenCalledWith('sess-1', expect.objectContaining({ status: 'ended' }));
      expect(Session.findByIdAndDelete).not.toHaveBeenCalled();
    });

    it('should return timeout error when controller does not respond', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ status: 'creating' }) } as never);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);
      vi.mocked(AcpMessage.deleteMany).mockResolvedValue({} as never);
      vi.mocked(Session.findByIdAndDelete).mockResolvedValue({} as never);

      const resultPromise = manager.startSession(
        socket as never, 'sess-1', 'ctrl-1', 'user-1', 'opencode', '/tmp',
      );

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:start', expect.anything());
      }, 1000);

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('ACP start timeout');
    }, 35000);
  });

  describe('forwardToController 排队补发（start/resume 竞态）', () => {
    async function startAndGetRequestId(socket: ReturnType<typeof createMockSocket>, sessionId = 'sess-1') {
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ status: 'creating' }) } as never);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);
      const resultPromise = manager.startSession(
        socket as never, sessionId, 'ctrl-1', 'user-1', 'opencode', '/tmp',
      );
      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:start', expect.anything());
      });
      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:start');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;
      return { resultPromise, requestId };
    }

    it('start 完成前到达的输入消息排队，start:result 后按序补发', async () => {
      const socket = createMockSocket();
      const { resultPromise, requestId } = await startAndGetRequestId(socket);

      // 会话尚未注册（acp:start:result 未回），消息到达 → 排队，不直接 emit
      expect(manager.forwardToController('sess-1', { type: 'text', content: '第一条 prompt' })).toBe(true);
      expect(manager.forwardToController('sess-1', { type: 'text', content: '第二条 prompt' })).toBe(true);
      expect(socket.emit).not.toHaveBeenCalledWith('acp:message', expect.anything());

      socket.emit.mockClear();
      socket._trigger('acp:start:result', { requestId, sessionId: 'sess-1', success: true });
      await resultPromise;

      const messages = socket.emit.mock.calls
        .filter((c) => c[0] === 'acp:message')
        .map((c) => (c[1] as { message: { content: string } }).message.content);
      expect(messages).toEqual(['第一条 prompt', '第二条 prompt']);
    });

    it('resume 完成前到达的输入消息排队，resume:result 后补发', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ status: 'ended', acpServerType: 'opencode' }) } as never);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      const resultPromise = manager.resumeSession(
        socket as never, 'sess-2', 'ext-1', 'ctrl-1', 'user-1', '/tmp',
      );
      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:resume', expect.anything());
      });
      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:resume');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;

      expect(manager.forwardToController('sess-2', { type: 'text', content: '返工提示词' })).toBe(true);
      expect(socket.emit).not.toHaveBeenCalledWith('acp:message', expect.anything());

      socket.emit.mockClear();
      socket._trigger('acp:resume:result', { requestId, sessionId: 'sess-2', success: true });
      await resultPromise;

      expect(socket.emit).toHaveBeenCalledWith('acp:message', expect.objectContaining({
        sessionId: 'sess-2',
        message: { type: 'text', content: '返工提示词' },
      }));
    });

    it('start 失败后队列被清空，不再补发', async () => {
      const socket = createMockSocket();
      const { resultPromise, requestId } = await startAndGetRequestId(socket);

      manager.forwardToController('sess-1', { type: 'text', content: '第一条 prompt' });

      socket._trigger('acp:start:result', { requestId, sessionId: 'sess-1', success: false, error: 'spawn failed' });
      const result = await resultPromise;
      expect(result.success).toBe(false);

      expect(socket.emit).not.toHaveBeenCalledWith('acp:message', expect.anything());
    });
  });

  describe('sendMessage', () => {
    it('should create message, publish, and forward to controller', async () => {
      const socket = createMockSocket();
      vi.mocked(AcpMessage.create).mockResolvedValue(mockAcpMessageDoc() as never);
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ status: 'creating' }) } as never);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      const startPromise = manager.startSession(
        socket as never, 'sess-1', 'ctrl-1', 'user-1', 'opencode', '/tmp',
      );
      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:start', expect.anything());
      });
      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:start');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;
      socket._trigger('acp:start:result', { requestId, sessionId: 'sess-1', success: true });
      await startPromise;

      socket.emit.mockClear();
      mockRedis.publish.mockClear();

      const result = await manager.sendMessage('sess-1', { type: 'text', content: 'Hello' });

      expect(result).toBe(true);
      expect(AcpMessage.create).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess-1', direction: 'input', type: 'text',
        content: expect.objectContaining({ sessionUpdate: 'user_message_chunk' }),
      }));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:message', expect.stringContaining('"direction":"input"'));
      expect(socket.emit).toHaveBeenCalledWith('acp:message', expect.objectContaining({
        sessionId: 'sess-1',
        message: { type: 'text', content: 'Hello' },
      }));
    });

    it('should return false when session not found', async () => {
      const result = await manager.sendMessage('nonexistent', { type: 'text', content: 'Hi' });
      expect(result).toBe(false);
    });
  });

  describe('handleControllerMessage', () => {
    it('should save output message and publish to Redis', async () => {
      vi.mocked(AcpMessage.create).mockResolvedValue(mockAcpMessageDoc() as never);

      const rawUpdate = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Response' } };
      await manager.handleControllerMessage('sess-1', rawUpdate as never);

      expect(AcpMessage.create).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess-1', direction: 'output', type: 'text',
        content: expect.objectContaining({ sessionUpdate: 'agent_message_chunk' }),
      }));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:message', expect.stringContaining('"direction":"output"'));
    });

    it('should persist and publish messageId when present in update', async () => {
      vi.mocked(AcpMessage.create).mockResolvedValue(mockAcpMessageDoc() as never);

      const rawUpdate = {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Response' },
        messageId: 'msg-abc-123',
      };
      await manager.handleControllerMessage('sess-1', rawUpdate as never);

      expect(AcpMessage.create).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess-1', direction: 'output', type: 'text',
        messageId: 'msg-abc-123',
      }));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:message', expect.stringContaining('"messageId":"msg-abc-123"'));
    });

    it('should omit messageId when not present in update', async () => {
      vi.mocked(AcpMessage.create).mockResolvedValue(mockAcpMessageDoc() as never);

      const rawUpdate = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Response' } };
      await manager.handleControllerMessage('sess-1', rawUpdate as never);

      const createCall = vi.mocked(AcpMessage.create).mock.calls[0]?.[0] as Record<string, unknown>;
      expect(createCall.messageId).toBeUndefined();
    });

    it('should publish messages in arrival order even when persistence completes out of order', async () => {
      const docWithId = (id: string) => ({ ...mockAcpMessageDoc(), _id: { toString: () => id } });
      vi.mocked(AcpMessage.create).mockImplementation((async (input: { content: { content: { text: string } } }) => {
        const text = input.content.content.text;
        // 模拟 MongoDB 写入完成乱序：先到达的消息落库更慢
        await new Promise((resolve) => setTimeout(resolve, text === 'one' ? 30 : 0));
        return docWithId(text === 'one' ? 'msg-1' : 'msg-2');
      }) as never);

      const chunk = (text: string) => ({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      });
      await Promise.all([
        manager.handleControllerMessage('sess-1', chunk('one') as never),
        manager.handleControllerMessage('sess-1', chunk('two') as never),
      ]);

      const published = mockRedis.publish.mock.calls
        .filter((call) => call[0] === 'session:message')
        .map((call) => JSON.parse(call[1] as string) as { message: { id: string } });
      expect(published.map((payload) => payload.message.id)).toEqual(['msg-1', 'msg-2']);
    });

    it('should not serialize messages across different sessions', async () => {
      const resolvers: Array<(doc: unknown) => void> = [];
      vi.mocked(AcpMessage.create).mockImplementation(
        (() => new Promise((resolve) => { resolvers.push(resolve); })) as never,
      );

      const chunk = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } };
      const p1 = manager.handleControllerMessage('sess-1', chunk as never);
      const p2 = manager.handleControllerMessage('sess-2', chunk as never);

      // 两个 session 的落库应并发开始，互不阻塞
      await vi.waitFor(() => expect(resolvers).toHaveLength(2));
      resolvers[0]!(mockAcpMessageDoc());
      resolvers[1]!(mockAcpMessageDoc());
      await Promise.all([p1, p2]);
    });

    it('should continue processing later messages when an earlier one fails', async () => {
      vi.mocked(AcpMessage.create)
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce(mockAcpMessageDoc() as never);

      const chunk = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } };
      const p1 = manager.handleControllerMessage('sess-1', chunk as never);
      const p2 = manager.handleControllerMessage('sess-1', chunk as never);

      await expect(p1).rejects.toThrow('db down');
      await p2;
      expect(mockRedis.publish).toHaveBeenCalledWith('session:message', expect.stringContaining('"direction":"output"'));
    });
  });

  describe('stopSession', () => {
    it('should send acp:stop with ackRequired, clean up mapping, and update status', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ status: 'creating' }) } as never);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      const startPromise = manager.startSession(
        socket as never, 'sess-1', 'ctrl-1', 'user-1', 'opencode', '/tmp',
      );
      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:start', expect.anything());
      });
      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:start');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;
      socket._trigger('acp:start:result', { requestId, sessionId: 'sess-1', success: true });
      await startPromise;

      socket.emit.mockClear();
      mockRedis.publish.mockClear();

      // Simulate ack response to avoid timeout
      const stopPromise = manager.stopSession('sess-1', 'user_close');
      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:stop', { sessionId: 'sess-1', ackRequired: true });
      });
      // Trigger the ack
      socket._trigger('acp:stopped', { sessionId: 'sess-1', reason: 'user_close' });
      await stopPromise;

      expect(Session.findByIdAndUpdate).toHaveBeenCalledWith('sess-1', expect.objectContaining({ status: 'ended' }));
    }, 15000);

    it('同 socket 其他 session 的 acp:stopped 不应消耗本 session 的 ack 监听', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ status: 'creating' }) } as never);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      const startPromise = manager.startSession(
        socket as never, 'sess-1', 'ctrl-1', 'user-1', 'opencode', '/tmp',
      );
      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:start', expect.anything());
      });
      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:start');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;
      socket._trigger('acp:start:result', { requestId, sessionId: 'sess-1', success: true });
      await startPromise;

      socket.emit.mockClear();

      const stopPromise = manager.stopSession('sess-1', 'user_close');
      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:stop', { sessionId: 'sess-1', ackRequired: true });
      });
      // 同 socket 上另一个 session 的 acp:stopped 先到 —— 不得结算/消耗 sess-1 的 ack 等待
      socket._trigger('acp:stopped', { sessionId: 'sess-other', reason: 'user_close' });
      // 本 session 的 ack 随后到达，应正常结算
      socket._trigger('acp:stopped', { sessionId: 'sess-1', reason: 'user_close' });
      await stopPromise;

      // ack 已收到，不应进入 pending 列表
      expect(mockRedis.lpush).not.toHaveBeenCalled();
    }, 15000);

    it('should handle stop for nonexistent session', async () => {
      await expect(manager.stopSession('nonexistent', 'user_close')).resolves.toBeUndefined();
    });

    it('start 在途时收到 stop：等待 start 结算后再停，不得走离线 pending', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ status: 'creating', controllerId: 'ctrl-1' }) } as never);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      // start 开始但不立即结算（模拟 harness 慢启动）
      const startPromise = manager.startSession(
        socket as never, 'sess-1', 'ctrl-1', 'user-1', 'opencode', '/tmp',
      );
      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:start', expect.anything());
      });
      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:start');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;

      // start 在途期间收到 stop：此时 sessions Map 未命中
      const stopPromise = manager.stopSession('sess-1', 'user_delete');
      await new Promise((r) => setTimeout(r, 50));
      // 不得立即发 acp:stop（bridge 尚未就绪），也不得误入离线 pending
      expect(socket.emit).not.toHaveBeenCalledWith('acp:stop', expect.anything());
      expect(mockRedis.lpush).not.toHaveBeenCalled();

      // start 结算成功 → stop 应继续走正常流程
      socket._trigger('acp:start:result', { requestId, sessionId: 'sess-1', success: true });
      await startPromise;
      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:stop', { sessionId: 'sess-1', ackRequired: true });
      });
      socket._trigger('acp:stopped', { sessionId: 'sess-1', reason: 'user_delete' });
      await stopPromise;

      expect(mockRedis.lpush).not.toHaveBeenCalled();
      expect(Session.findByIdAndUpdate).toHaveBeenCalledWith('sess-1', expect.objectContaining({ status: 'ended' }));
    }, 15000);
  });

  describe('handleControllerStopped', () => {
    it('should clean up and update status', async () => {
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue({ _id: 'sess-1' } as never);

      await manager.handleControllerStopped('sess-1', 'agent_exit', 0);

      expect(Session.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'sess-1', status: { $ne: 'connecting' } },
        expect.objectContaining({ status: 'ended' }),
      );
      expect(mockRedis.publish).toHaveBeenCalledWith('session:status', expect.stringContaining('"status":"ended"'));
    });

    it('会话处于 connecting（start/resume 进行中）时不落 ended，避免 stop 后立即 resume 的状态抖动', async () => {
      // 状态为 connecting 时条件更新不命中
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue(null);

      await manager.handleControllerStopped('sess-1', 'user_close');

      expect(Session.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'sess-1', status: { $ne: 'connecting' } },
        expect.objectContaining({ status: 'ended' }),
      );
      expect(mockRedis.publish).not.toHaveBeenCalledWith('session:status', expect.stringContaining('"status":"ended"'));
      // ack 标记仍写入，agent-api 的 waitForStopAck 不受影响（TTL 60s）
      expect(mockRedis.set).toHaveBeenCalledWith(
        'acp:stop:ack:sess-1',
        expect.any(String),
        'EX',
        60,
      );
    });
  });

  describe('stopSessionWithAck 离线 pending', () => {
    it('session 不在活跃映射（controller 离线）时写入 pending 列表', async () => {
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ controllerId: 'ctrl-1' }) } as never);

      await manager.stopSession('sess-offline', 'user_close');

      expect(mockRedis.lpush).toHaveBeenCalledWith('acp:stop:pending:ctrl-1', 'sess-offline');
      expect(mockRedis.expire).toHaveBeenCalledWith('acp:stop:pending:ctrl-1', 86400);
    });

    it('DB 中也不存在会话记录时不写 pending', async () => {
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue(null) } as never);

      await manager.stopSession('ghost', 'user_close');

      expect(mockRedis.lpush).not.toHaveBeenCalled();
    });
  });

  describe('reconcileOnRegister（acp:reconcile 下发）', () => {
    it('离线删除 → 重连 reconcile 补做：pending 写入后随 reconcile 下发并清除', async () => {
      // 离线期间删除：sessions Map 未命中，但 DB 会话记录尚在 → 写 pending
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ controllerId: 'ctrl-1' }) } as never);
      await manager.stopSession('sess-1', 'user_close');
      expect(mockRedis.lpush).toHaveBeenCalledWith('acp:stop:pending:ctrl-1', 'sess-1');

      // controller 重连注册：读取活跃会话 + pending 列表，emit acp:reconcile
      const socket = createMockSocket();
      vi.mocked(Session.find).mockReturnValue({ lean: vi.fn().mockResolvedValue([{ _id: 'sess-2' }]) } as never);
      mockRedis.lrange.mockResolvedValue(['sess-1']);

      await manager.reconcileOnRegister(socket as never, 'ctrl-1');

      expect(socket.emit).toHaveBeenCalledWith('acp:reconcile', {
        activeSessionIds: ['sess-2'],
        pendingKillSessionIds: ['sess-1'],
      });
      expect(mockRedis.del).toHaveBeenCalledWith('acp:stop:pending:ctrl-1');
    });

    it('活跃会话取内存映射与 DB 未 ended 会话的并集，pending 去重', async () => {
      const socket = createMockSocket();
      // 内存中一个活跃会话（属于 ctrl-1）
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ status: 'creating' }) } as never);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);
      const startPromise = manager.startSession(
        socket as never, 'sess-mem', 'ctrl-1', 'user-1', 'opencode', '/tmp',
      );
      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:start', expect.anything());
      });
      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:start');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;
      socket._trigger('acp:start:result', { requestId, sessionId: 'sess-mem', success: true });
      await startPromise;

      vi.mocked(Session.find).mockReturnValue({ lean: vi.fn().mockResolvedValue([{ _id: 'sess-db' }]) } as never);
      mockRedis.lrange.mockResolvedValue(['sess-kill', 'sess-kill']);

      await manager.reconcileOnRegister(socket as never, 'ctrl-1');

      expect(socket.emit).toHaveBeenCalledWith('acp:reconcile', {
        activeSessionIds: expect.arrayContaining(['sess-mem', 'sess-db']),
        pendingKillSessionIds: ['sess-kill'],
      });
    });

    it('pending 为空时不删 key，仍下发空 pendingKillSessionIds', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.find).mockReturnValue({ lean: vi.fn().mockResolvedValue([]) } as never);
      mockRedis.lrange.mockResolvedValue([]);

      await manager.reconcileOnRegister(socket as never, 'ctrl-1');

      expect(socket.emit).toHaveBeenCalledWith('acp:reconcile', {
        activeSessionIds: [],
        pendingKillSessionIds: [],
      });
      expect(mockRedis.del).not.toHaveBeenCalled();
    });
  });

  describe('handlePromptStart', () => {
    it('should set status to running and publish when session is idling', async () => {
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue({ _id: 'sess-1' } as never);

      await manager.handlePromptStart('sess-1');

      expect(Session.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'sess-1', status: 'idling' },
        { status: 'running' },
      );
      expect(mockRedis.publish).toHaveBeenCalledWith('session:status', expect.stringContaining('"status":"running"'));
    });

    it('should not publish when session is not idling', async () => {
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue(null);

      await manager.handlePromptStart('sess-1');

      expect(Session.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'sess-1', status: 'idling' },
        { status: 'running' },
      );
      expect(mockRedis.publish).not.toHaveBeenCalled();
    });
  });

  describe('handlePromptComplete', () => {
    it('should set status to idling and publish when session is running', async () => {
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue({ _id: 'sess-1' } as never);

      await manager.handlePromptComplete('sess-1', 'end_turn');

      expect(Session.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'sess-1', status: 'running' },
        { status: 'idling' },
      );
      expect(mockRedis.publish).toHaveBeenCalledWith('session:status', expect.stringContaining('"status":"idling"'));
    });

    it('should not publish when session is not running (crash race)', async () => {
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue(null);

      await manager.handlePromptComplete('sess-1', 'end_turn');

      expect(Session.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'sess-1', status: 'running' },
        { status: 'idling' },
      );
      expect(mockRedis.publish).not.toHaveBeenCalled();
    });
  });

  describe('resumeSession', () => {
    it('should update status to connecting and emit acp:resume', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      const resultPromise = manager.resumeSession(
        socket as never, 'sess-1', 'ext-123', 'ctrl-1', 'user-1', '/tmp',
      );

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:resume', expect.objectContaining({
          sessionId: 'sess-1',
          externalSessionId: 'ext-123',
          serverType: 'opencode',
          cwd: '/tmp',
        }));
      });

      expect(Session.findByIdAndUpdate).toHaveBeenCalledWith('sess-1', { status: 'connecting' });
      expect(mockRedis.publish).toHaveBeenCalledWith('session:status', expect.stringContaining('"status":"connecting"'));

      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:resume');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;

      socket._trigger('acp:resume:result', {
        requestId,
        sessionId: 'sess-1',
        success: true,
      });

      const result = await resultPromise;
      expect(result.success).toBe(true);
    });

    it('should include mcpEndpoint in acp:resume payload when provided', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      const mcpEndpoint = { url: 'http://gateway/mcp/sess-1', token: 'tok', serverNames: ['github-mcp'] };
      const resultPromise = manager.resumeSession(
        socket as never, 'sess-1', 'ext-123', 'ctrl-1', 'user-1', '/tmp', mcpEndpoint,
      );

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:resume', expect.objectContaining({ mcpEndpoint }));
      });

      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:resume');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;
      socket._trigger('acp:resume:result', {
        requestId,
        sessionId: 'sess-1',
        success: true,
      });
      await resultPromise;
    });

    it('should set status to idling on success', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      const resultPromise = manager.resumeSession(
        socket as never, 'sess-1', 'ext-123', 'ctrl-1', 'user-1', '/tmp',
      );

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:resume', expect.anything());
      });

      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:resume');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;

      socket._trigger('acp:resume:result', {
        requestId,
        sessionId: 'sess-1',
        success: true,
      });

      await resultPromise;
      expect(Session.findByIdAndUpdate).toHaveBeenCalledWith('sess-1', { status: 'idling', modes: [], availableModels: [], authRequired: false });
      expect(mockRedis.publish).toHaveBeenCalledWith('session:status', expect.stringContaining('"status":"idling"'));
    });

    it('should set status to ended with error on failure', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      const resultPromise = manager.resumeSession(
        socket as never, 'sess-1', 'ext-123', 'ctrl-1', 'user-1', '/tmp',
      );

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:resume', expect.anything());
      });

      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:resume');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;

      socket._trigger('acp:resume:result', {
        requestId,
        sessionId: 'sess-1',
        success: false,
        error: 'ACP_SESSION_EXPIRED',
      });

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('ACP_SESSION_EXPIRED');
      expect(Session.findByIdAndUpdate).toHaveBeenCalledWith('sess-1', expect.objectContaining({ status: 'ended' }));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:status', expect.stringContaining('"error":"ACP_SESSION_EXPIRED"'));
    });

    it('should return timeout error when controller does not respond', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      const resultPromise = manager.resumeSession(
        socket as never, 'sess-1', 'ext-123', 'ctrl-1', 'user-1', '/tmp',
      );

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:resume', expect.anything());
      }, 1000);

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('ACP resume timeout');
    }, 35000);

    it('should set authRequired true when authMethods provided', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      const resultPromise = manager.resumeSession(
        socket as never, 'sess-1', 'ext-123', 'ctrl-1', 'user-1', '/tmp',
      );

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:resume', expect.anything());
      });

      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:resume');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;

      socket._trigger('acp:resume:result', {
        requestId,
        sessionId: 'sess-1',
        success: true,
        authMethods: [{ id: 'oauth', kind: 'agent' }],
      });

      await resultPromise;
      expect(Session.findByIdAndUpdate).toHaveBeenCalledWith('sess-1', expect.objectContaining({ authRequired: true }));
    });
  });

  describe('handleSocketDisconnect', () => {
    it('should set active sessions to disconnected status', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ status: 'creating' }) } as never);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue({ _id: 'sess-1' } as never);

      const startPromise = manager.startSession(
        socket as never, 'sess-1', 'ctrl-1', 'user-1', 'opencode', '/tmp',
      );
      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:start', expect.anything());
      });
      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:start');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;
      socket._trigger('acp:start:result', { requestId, sessionId: 'sess-1', success: true });
      await startPromise;

      mockRedis.publish.mockClear();

      await manager.handleSocketDisconnect('socket-123');

      expect(Session.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'sess-1', status: { $in: ['idling', 'running'] } },
        { status: 'disconnected', disconnectedAt: expect.any(Date) },
      );
      expect(mockRedis.publish).toHaveBeenCalledWith('session:status', expect.stringContaining('"status":"disconnected"'));
    });

    it('should set non-active sessions to ended status', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ status: 'creating' }) } as never);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);
      // First call returns null (session not idling/running), second call succeeds
      vi.mocked(Session.findOneAndUpdate)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ _id: 'sess-1' } as never);

      const startPromise = manager.startSession(
        socket as never, 'sess-1', 'ctrl-1', 'user-1', 'opencode', '/tmp',
      );
      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:start', expect.anything());
      });
      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:start');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;
      socket._trigger('acp:start:result', { requestId, sessionId: 'sess-1', success: true });
      await startPromise;

      mockRedis.publish.mockClear();

      await manager.handleSocketDisconnect('socket-123');

      expect(Session.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'sess-1', status: { $in: ['idling', 'running'] } },
        { status: 'disconnected', disconnectedAt: expect.any(Date) },
      );
      expect(Session.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'sess-1', status: { $nin: ['ended', 'disconnected'] } },
        { status: 'ended', endedAt: expect.any(Date) },
      );
      expect(mockRedis.publish).toHaveBeenCalledWith('session:status', expect.stringContaining('"status":"ended"'));
    });

    it('should handle disconnect for unknown socket', async () => {
      await expect(manager.handleSocketDisconnect('unknown')).resolves.toBeUndefined();
    });
  });

  describe('startSession authRequired', () => {
    it('should set authRequired true when authMethods provided', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ status: 'creating' }) } as never);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      const resultPromise = manager.startSession(
        socket as never, 'sess-1', 'ctrl-1', 'user-1', 'opencode', '/tmp',
      );
      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:start', expect.anything());
      });
      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:start');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;
      socket._trigger('acp:start:result', {
        requestId,
        sessionId: 'sess-1',
        success: true,
        authMethods: [{ id: 'oauth', kind: 'agent' }],
      });
      await resultPromise;

      expect(Session.findByIdAndUpdate).toHaveBeenCalledWith('sess-1', expect.objectContaining({ authRequired: true }));
    });

    it('should reset authRequired to false when no authMethods provided', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ status: 'creating' }) } as never);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      const resultPromise = manager.startSession(
        socket as never, 'sess-1', 'ctrl-1', 'user-1', 'opencode', '/tmp',
      );
      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:start', expect.anything());
      });
      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:start');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;
      socket._trigger('acp:start:result', {
        requestId,
        sessionId: 'sess-1',
        success: true,
        authMethods: [],
      });
      await resultPromise;

      expect(Session.findByIdAndUpdate).toHaveBeenCalledWith('sess-1', expect.objectContaining({ authRequired: false }));
    });
  });

  describe('config option status publishing', () => {
    it('should publish current session status for config_option_update (running)', async () => {
      vi.mocked(AcpMessage.create).mockResolvedValue(mockAcpMessageDoc() as never);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ status: 'running' }) } as never);

      const rawUpdate = {
        sessionUpdate: 'config_option_update',
        configOptions: [{ id: 'model', category: 'model', currentValue: 'model-2' }],
      };
      await manager.handleControllerMessage('sess-1', rawUpdate as never);

      expect(mockRedis.publish).toHaveBeenCalledWith('session:status', expect.stringContaining('"status":"running"'));
      expect(mockRedis.publish).not.toHaveBeenCalledWith('session:status', expect.stringContaining('"status":"idling"'));
    });

    it('should fall back to idling for config_option_update when session not found', async () => {
      vi.mocked(AcpMessage.create).mockResolvedValue(mockAcpMessageDoc() as never);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue(null) } as never);

      const rawUpdate = {
        sessionUpdate: 'config_option_update',
        configOptions: [{ id: 'mode', category: 'mode', currentValue: 'code' }],
      };
      await manager.handleControllerMessage('sess-1', rawUpdate as never);

      expect(mockRedis.publish).toHaveBeenCalledWith('session:status', expect.stringContaining('"status":"idling"'));
    });

    it('should publish current session status for publishConfigOptions (running)', async () => {
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue({ status: 'running' }) } as never);

      await manager.publishConfigOptions('sess-1', [{ id: 'model', category: 'model', currentValue: 'model-2' }]);

      expect(mockRedis.publish).toHaveBeenCalledWith('session:status', expect.stringContaining('"status":"running"'));
      expect(mockRedis.publish).not.toHaveBeenCalledWith('session:status', expect.stringContaining('"status":"idling"'));
    });

    it('should fall back to idling for publishConfigOptions when session not found', async () => {
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);
      vi.mocked(Session.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue(null) } as never);

      await manager.publishConfigOptions('sess-1', [{ id: 'model', category: 'model', currentValue: 'model-2' }]);

      expect(mockRedis.publish).toHaveBeenCalledWith('session:status', expect.stringContaining('"status":"idling"'));
    });
  });
});
