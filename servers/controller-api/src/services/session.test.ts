import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

import { sessionService } from './session.js';
import { getRedisClient } from '../middleware/redis.js';

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  expire: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
});

describe('SessionService', () => {
  describe('acquireSession', () => {
    it('should acquire session when no existing session', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockRedis.set.mockResolvedValue('OK');

      const result = await sessionService.acquireSession('key1', 'socket1');

      expect(result).toBe(true);
      expect(mockRedis.get).toHaveBeenCalledWith('session:key1');
      expect(mockRedis.set).toHaveBeenCalledWith('session:key1', 'socket1', 'EX', 90);
    });

    it('should fail to acquire session when session exists', async () => {
      mockRedis.get.mockResolvedValue('existing-socket');

      const result = await sessionService.acquireSession('key1', 'socket1');

      expect(result).toBe(false);
      expect(mockRedis.set).not.toHaveBeenCalled();
    });
  });

  describe('refreshSession', () => {
    it('should refresh session TTL', async () => {
      mockRedis.expire.mockResolvedValue(1);

      await sessionService.refreshSession('key1');

      expect(mockRedis.expire).toHaveBeenCalledWith('session:key1', 90);
    });
  });

  describe('removeSession', () => {
    it('should remove session', async () => {
      mockRedis.del.mockResolvedValue(1);

      await sessionService.removeSession('key1');

      expect(mockRedis.del).toHaveBeenCalledWith('session:key1');
    });
  });

  describe('getSocketId', () => {
    it('should return socket id', async () => {
      mockRedis.get.mockResolvedValue('socket123');

      const result = await sessionService.getSocketId('key1');

      expect(result).toBe('socket123');
    });

    it('should return null when no session', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await sessionService.getSocketId('key1');

      expect(result).toBeNull();
    });
  });

  describe('updateHeartbeat', () => {
    it('should update heartbeat timestamp', async () => {
      mockRedis.set.mockResolvedValue('OK');

      await sessionService.updateHeartbeat('key1');

      expect(mockRedis.set).toHaveBeenCalledWith(
        'heartbeat:key1',
        expect.any(String),
        'EX',
        90,
      );
    });
  });

  describe('storeResumeToken', () => {
    it('should generate and store a resume token', async () => {
      mockRedis.set.mockResolvedValue('OK');

      const token = await sessionService.storeResumeToken('key1');

      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
      expect(mockRedis.set).toHaveBeenCalledWith('resume:key1', token);
    });
  });

  describe('acquireSession with resumeToken', () => {
    it('should allow reconnection when resume token matches', async () => {
      mockRedis.get
        .mockResolvedValueOnce('existing-socket')  // session:key1 exists
        .mockResolvedValueOnce('valid-token');      // resume:key1 matches
      mockRedis.del.mockResolvedValue(1);
      mockRedis.set.mockResolvedValue('OK');

      const result = await sessionService.acquireSession('key1', 'new-socket', 'valid-token');

      expect(result).toBe(true);
      expect(mockRedis.del).toHaveBeenCalledWith('session:key1');
      expect(mockRedis.set).toHaveBeenCalledWith('session:key1', 'new-socket', 'EX', 90);
    });

    it('should reject when resume token does not match', async () => {
      mockRedis.get
        .mockResolvedValueOnce('existing-socket')  // session:key1 exists
        .mockResolvedValueOnce('valid-token');      // resume:key1 has different value

      const result = await sessionService.acquireSession('key1', 'new-socket', 'wrong-token');

      expect(result).toBe(false);
      expect(mockRedis.set).not.toHaveBeenCalled();
    });
  });

  describe('cleanupKey', () => {
    it('should remove session, heartbeat, and resume token', async () => {
      mockRedis.del.mockResolvedValue(1);

      await sessionService.cleanupKey('key1');

      expect(mockRedis.del).toHaveBeenCalledWith('session:key1');
      expect(mockRedis.del).toHaveBeenCalledWith('heartbeat:key1');
      expect(mockRedis.del).toHaveBeenCalledWith('resume:key1');
    });
  });
});
