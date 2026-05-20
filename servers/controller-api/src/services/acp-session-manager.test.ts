import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/session.js', () => ({
  Session: {
    findByIdAndUpdate: vi.fn(),
    findByIdAndDelete: vi.fn(),
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
};

function createMockSocket() {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    id: 'socket-123',
    emit: vi.fn(),
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handler;
    }),
    _handlers: handlers,
    _trigger(event: string, ...args: unknown[]) {
      handlers[event]?.(...args);
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
        content: JSON.stringify({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Hello' } }),
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
        content: JSON.stringify(rawUpdate),
      }));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:message', expect.stringContaining('"direction":"output"'));
    });
  });

  describe('stopSession', () => {
    it('should send acp:stop, clean up mapping, and update status', async () => {
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

      await manager.stopSession('sess-1', 'user_close');

      expect(socket.emit).toHaveBeenCalledWith('acp:stop', { sessionId: 'sess-1' });
      expect(Session.findByIdAndUpdate).toHaveBeenCalledWith('sess-1', expect.objectContaining({ status: 'ended' }));
    });

    it('should handle stop for nonexistent session', async () => {
      await expect(manager.stopSession('nonexistent', 'user_close')).resolves.toBeUndefined();
    });
  });

  describe('handleControllerStopped', () => {
    it('should clean up and update status', async () => {
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      await manager.handleControllerStopped('sess-1', 'agent_exit', 0);

      expect(Session.findByIdAndUpdate).toHaveBeenCalledWith('sess-1', expect.objectContaining({ status: 'ended' }));
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
          controllerId: 'ctrl-1',
          userId: 'user-1',
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
      expect(Session.findByIdAndUpdate).toHaveBeenCalledWith('sess-1', { status: 'idling' });
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
  });

  describe('handleSocketDisconnect', () => {
    it('should stop all sessions for the socket', async () => {
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

      mockRedis.publish.mockClear();

      await manager.handleSocketDisconnect('socket-123');

      expect(Session.findByIdAndUpdate).toHaveBeenCalledWith('sess-1', expect.objectContaining({ status: 'ended' }));
    });

    it('should handle disconnect for unknown socket', async () => {
      await expect(manager.handleSocketDisconnect('unknown')).resolves.toBeUndefined();
    });
  });
});
