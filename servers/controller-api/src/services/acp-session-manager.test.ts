import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/session.js', () => ({
  Session: {
    findByIdAndUpdate: vi.fn(),
  },
}));

vi.mock('../models/acp-message.js', () => ({
  AcpMessage: {
    create: vi.fn(),
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
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      const resultPromise = manager.startSession(
        socket as never, 'sess-1', 'ctrl-1', 'user-1', 'opencode', '/tmp',
      );

      // Wait for async operations (findByIdAndUpdate + publishStatus) to complete
      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:start', expect.objectContaining({
          sessionId: 'sess-1',
          serverType: 'opencode',
          cwd: '/tmp',
        }));
      });

      expect(Session.findByIdAndUpdate).toHaveBeenCalledWith('sess-1', { status: 'connecting' });
      expect(mockRedis.publish).toHaveBeenCalledWith('session:status', expect.stringContaining('"status":"connecting"'));

      // Simulate controller response
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

    it('should handle controller start failure', async () => {
      const socket = createMockSocket();
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
        error: 'OpenCode not found',
      });

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('OpenCode not found');
    });

    it('should return timeout error when controller does not respond', async () => {
      const socket = createMockSocket();
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      const resultPromise = manager.startSession(
        socket as never, 'sess-1', 'ctrl-1', 'user-1', 'opencode', '/tmp',
      );

      // Wait for the start event to be emitted
      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:start', expect.anything());
      }, 1000);

      // Don't trigger the result - wait for real timeout (30s)
      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('ACP start timeout');
    }, 35000);
  });

  describe('sendMessage', () => {
    it('should create message, publish, and forward to controller', async () => {
      const socket = createMockSocket();
      vi.mocked(AcpMessage.create).mockResolvedValue(mockAcpMessageDoc() as never);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      // Start a session first
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
        sessionId: 'sess-1', direction: 'input', type: 'text', content: 'Hello',
      }));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:message', expect.stringContaining('"content":"Hello"'));
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

      await manager.handleControllerMessage('sess-1', { type: 'text', content: 'Response' });

      expect(AcpMessage.create).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess-1', direction: 'output', type: 'text', content: 'Response',
      }));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:message', expect.stringContaining('"direction":"output"'));
    });
  });

  describe('stopSession', () => {
    it('should send acp:stop, clean up mapping, and update status', async () => {
      const socket = createMockSocket();
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

  describe('handleSocketDisconnect', () => {
    it('should stop all sessions for the socket', async () => {
      const socket = createMockSocket();
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
