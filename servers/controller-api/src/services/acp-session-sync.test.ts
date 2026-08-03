import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

import { AcpSessionSyncService } from './acp-session-sync.js';
import { getRedisClient } from '../middleware/redis.js';

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
};

function createMockSocket() {
  return {
    id: 'socket-123',
    emit: vi.fn(),
  };
}

describe('AcpSessionSyncService', () => {
  let service: AcpSessionSyncService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
    service = new AcpSessionSyncService();
  });

  describe('listSessions', () => {
    it('should emit acp:list-sessions and resolve on handleListResult', async () => {
      const socket = createMockSocket();
      const resultPromise = service.listSessions(socket as never, 'opencode', '/home/user');

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:list-sessions', expect.objectContaining({
          serverType: 'opencode',
          cwd: '/home/user',
          requestId: expect.any(String),
        }));
      });

      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:list-sessions');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;

      service.handleListResult(requestId, {
        success: true,
        sessions: [{ sessionId: 'hist-1', title: 'Session 1', cwd: '/home/user', updatedAt: null }],
      });

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions![0].sessionId).toBe('hist-1');
    });

    it('should pass custom serverType to acp:list-sessions', async () => {
      const socket = createMockSocket();
      service.listSessions(socket as never, 'claude_code', '/home/user');

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:list-sessions', expect.objectContaining({
          serverType: 'claude_code',
        }));
      });
    });

    it('should timeout after 120s if no response', async () => {
      vi.useFakeTimers();
      const socket = createMockSocket();

      const resultPromise = service.listSessions(socket as never, 'opencode', '/home/user');

      await vi.advanceTimersByTimeAsync(121000);

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('ACP list-sessions timeout');

      vi.useRealTimers();
    }, 15000);

    it('should handle error result', async () => {
      const socket = createMockSocket();
      const resultPromise = service.listSessions(socket as never, 'opencode', '/home/user');

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalled();
      });

      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:list-sessions');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;

      service.handleListResult(requestId, { success: false, error: 'ACP process not found' });

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('ACP process not found');
    });
  });

  describe('loadSession', () => {
    it('should emit acp:load-session and resolve on handleLoadResult', async () => {
      const socket = createMockSocket();
      const resultPromise = service.loadSession(socket as never, 'opencode', 'hist-1', '/home/user');

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:load-session', expect.objectContaining({
          serverType: 'opencode',
          sessionId: 'hist-1',
          cwd: '/home/user',
          requestId: expect.any(String),
        }));
      });

      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:load-session');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;

      service.handleLoadResult(requestId, {
        success: true,
        sessionId: 'hist-1',
        title: 'Session 1',
        messages: [{ direction: 'input', type: 'text', content: '{"text":"hello"}' }],
      });

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.messages).toHaveLength(1);
      expect(result.messages![0].direction).toBe('input');
    });

    it('should pass custom serverType to acp:load-session', async () => {
      const socket = createMockSocket();
      service.loadSession(socket as never, 'gemini_cli', 'hist-1', '/home/user');

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:load-session', expect.objectContaining({
          serverType: 'gemini_cli',
        }));
      });
    });

    it('should timeout after 300s if no response', async () => {
      vi.useFakeTimers();
      const socket = createMockSocket();

      const resultPromise = service.loadSession(socket as never, 'opencode', 'hist-1', '/home/user');

      await vi.advanceTimersByTimeAsync(311000);

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('ACP load-session timeout');

      vi.useRealTimers();
    }, 15000);

    it('should handle load error', async () => {
      const socket = createMockSocket();
      const resultPromise = service.loadSession(socket as never, 'opencode', 'hist-1', '/home/user');

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalled();
      });

      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:load-session');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;

      service.handleLoadResult(requestId, { success: false, error: 'Session not found' });

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('Session not found');
    });
  });

  describe('handleListResult', () => {
    it('should handle unknown requestId gracefully', () => {
      expect(() => service.handleListResult('unknown', { success: false })).not.toThrow();
    });
  });

  describe('handleLoadResult', () => {
    it('should handle unknown requestId gracefully', () => {
      expect(() => service.handleLoadResult('unknown', { success: false })).not.toThrow();
    });
  });

  describe('cacheListResult', () => {
    it('should cache result in Redis with 120s TTL', async () => {
      vi.mocked(mockRedis.set).mockResolvedValue(undefined);

      await service.cacheListResult('req-1', {
        success: true,
        sessions: [{ sessionId: 'hist-1', title: 'S1', cwd: '/home/user', updatedAt: null }],
      });

      expect(mockRedis.set).toHaveBeenCalledWith(
        'acp:list-sessions:req-1',
        expect.any(String),
        'EX',
        120,
      );
    });
  });

  describe('cacheLoadResult', () => {
    it('should cache result in Redis with 300s TTL', async () => {
      vi.mocked(mockRedis.set).mockResolvedValue(undefined);

      await service.cacheLoadResult('req-1', {
        success: true,
        sessionId: 'hist-1',
        messages: [],
      });

      expect(mockRedis.set).toHaveBeenCalledWith(
        'acp:load-session:req-1',
        expect.any(String),
        'EX',
        300,
      );
    });
  });

  describe('getCachedListResult', () => {
    it('should return cached list result', async () => {
      const cached = { success: true, sessions: [] };
      vi.mocked(mockRedis.get).mockResolvedValue(JSON.stringify(cached));

      const result = await service.getCachedListResult('req-1');

      expect(result).toEqual(cached);
      expect(mockRedis.get).toHaveBeenCalledWith('acp:list-sessions:req-1');
    });

    it('should return null when no cache', async () => {
      vi.mocked(mockRedis.get).mockResolvedValue(null);

      const result = await service.getCachedListResult('req-1');

      expect(result).toBeNull();
    });
  });

  describe('getCachedLoadResult', () => {
    it('should return cached load result', async () => {
      const cached = { success: true, sessionId: 'hist-1', messages: [] };
      vi.mocked(mockRedis.get).mockResolvedValue(JSON.stringify(cached));

      const result = await service.getCachedLoadResult('req-1');

      expect(result).toEqual(cached);
    });
  });

  describe('deleteHistorySession', () => {
    it('should emit acp:delete-history-session and resolve on handleDeleteResult', async () => {
      const socket = createMockSocket();
      const resultPromise = service.deleteHistorySession(socket as never, 'opencode', 'db-id-1', 'ext-1', '/home/user');

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:delete-history-session', expect.objectContaining({
          serverType: 'opencode',
          sessionId: 'db-id-1',
          externalSessionId: 'ext-1',
          cwd: '/home/user',
          requestId: expect.any(String),
        }));
      });

      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:delete-history-session');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;

      service.handleDeleteResult(requestId, { success: true, supported: true });

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.supported).toBe(true);
    });

    it('should handle unsupported result', async () => {
      const socket = createMockSocket();
      const resultPromise = service.deleteHistorySession(socket as never, 'opencode', 'db-id-1', 'ext-1', '/home/user');

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalled();
      });

      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:delete-history-session');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;

      service.handleDeleteResult(requestId, { success: false, supported: false, error: 'Session delete not supported by agent' });

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.supported).toBe(false);
    });

    it('should timeout after 120s if no response', async () => {
      vi.useFakeTimers();
      const socket = createMockSocket();

      const resultPromise = service.deleteHistorySession(socket as never, 'opencode', 'db-id-1', 'ext-1', '/home/user');

      await vi.advanceTimersByTimeAsync(121000);

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('ACP delete-session timeout');

      vi.useRealTimers();
    }, 15000);
  });

  describe('cacheDeleteResult', () => {
    it('should cache result in Redis with 120s TTL', async () => {
      vi.mocked(mockRedis.set).mockResolvedValue(undefined);

      await service.cacheDeleteResult('req-1', { success: true, supported: true });

      expect(mockRedis.set).toHaveBeenCalledWith(
        'acp:delete-session:req-1',
        expect.any(String),
        'EX',
        120,
      );
    });
  });
});
