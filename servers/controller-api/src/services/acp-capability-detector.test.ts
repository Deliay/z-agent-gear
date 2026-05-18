import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

import { ACPCapabilityDetector } from './acp-capability-detector.js';
import { getRedisClient } from '../middleware/redis.js';

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
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

describe('ACPCapabilityDetector', () => {
  let detector: ACPCapabilityDetector;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
    detector = new ACPCapabilityDetector();
  });

  describe('detectCapabilities', () => {
    it('should return cached capabilities from in-memory cache', async () => {
      vi.mocked(mockRedis.get).mockResolvedValue(JSON.stringify({
        servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
        checkedAt: new Date().toISOString(),
      }));

      const socket = createMockSocket();
      const result = await detector.detectCapabilities(socket as never, 'ctrl-1');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(expect.objectContaining({ type: 'opencode', available: true }));
    });

    it('should send acp:check when no cache and resolve on result', async () => {
      vi.mocked(mockRedis.get).mockResolvedValue(null);
      vi.mocked(mockRedis.set).mockResolvedValue(undefined);
      const socket = createMockSocket();

      const resultPromise = detector.detectCapabilities(socket as never, 'ctrl-1');

      // Wait for the async redis.get to complete so emit is called
      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:check', expect.objectContaining({ requestId: expect.any(String) }));
      });

      // Extract requestId from the emit call
      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:check');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;

      // Handle the result
      detector.handleCheckResult(requestId, [{ type: 'opencode', available: true, version: '1.0.0' }]);

      const result = await resultPromise;
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(expect.objectContaining({ type: 'opencode', available: true }));
      expect(mockRedis.set).toHaveBeenCalledWith('acp:capability:ctrl-1', expect.any(String), 'EX', 3600);
    });

    it('should return empty array on timeout', async () => {
      vi.mocked(mockRedis.get).mockResolvedValue(null);
      vi.mocked(mockRedis.set).mockResolvedValue(undefined);
      const socket = createMockSocket();

      const resultPromise = detector.detectCapabilities(socket as never, 'ctrl-1');

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalledWith('acp:check', expect.anything());
      }, 1000);

      // Don't trigger handleCheckResult - wait for real timeout (10s)
      // Increase test timeout for this test
      const result = await resultPromise;
      expect(result).toEqual([]);
    }, 15000);
  });

  describe('handleCheckResult', () => {
    it('should resolve pending request', async () => {
      vi.mocked(mockRedis.get).mockResolvedValue(null);
      vi.mocked(mockRedis.set).mockResolvedValue(undefined);
      const socket = createMockSocket();

      const resultPromise = detector.detectCapabilities(socket as never, 'ctrl-1');

      await vi.waitFor(() => {
        expect(socket.emit).toHaveBeenCalled();
      });

      const emitArgs = socket.emit.mock.calls.find((c) => c[0] === 'acp:check');
      const requestId = (emitArgs?.[1] as Record<string, unknown>)?.requestId as string;

      detector.handleCheckResult(requestId, [{ type: 'opencode', available: true }]);

      const result = await resultPromise;
      expect(result).toHaveLength(1);
    });

    it('should handle unknown requestId gracefully', () => {
      expect(() => detector.handleCheckResult('unknown-request', [])).not.toThrow();
    });
  });

  describe('invalidateCache', () => {
    it('should delete from both local cache and Redis', async () => {
      vi.mocked(mockRedis.get).mockResolvedValue(JSON.stringify({
        servers: [{ type: 'opencode', available: true }],
        checkedAt: new Date().toISOString(),
      }));
      vi.mocked(mockRedis.del).mockResolvedValue(undefined);

      const socket = createMockSocket();
      await detector.detectCapabilities(socket as never, 'ctrl-1');

      detector.invalidateCache('ctrl-1');

      expect(mockRedis.del).toHaveBeenCalledWith('acp:capability:ctrl-1');
    });
  });
});
