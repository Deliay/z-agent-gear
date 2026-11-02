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
  eval: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
});

describe('SessionService', () => {
  describe('takeoverSession', () => {
    it('T-ST1: returns null when no previous session and sets the new socket id', async () => {
      mockRedis.eval.mockResolvedValue(null);

      const result = await sessionService.takeoverSession('key1', 'socket1');

      expect(result).toBeNull();
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('GET', KEYS[1])"),
        1,
        'session:key1',
        'socket1',
        90,
      );
    });

    it('T-ST2: returns the previous socket id when a session already exists', async () => {
      mockRedis.eval.mockResolvedValue('existing-socket');

      const result = await sessionService.takeoverSession('key1', 'socket1');

      expect(result).toBe('existing-socket');
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        'session:key1',
        'socket1',
        90,
      );
    });
  });

  describe('releaseSession', () => {
    it('T-ST3: releases the session when the socket id matches', async () => {
      mockRedis.eval.mockResolvedValue(1);

      const result = await sessionService.releaseSession('key1', 'socket1');

      expect(result).toBe(true);
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('DEL', KEYS[1])"),
        1,
        'session:key1',
        'socket1',
      );
    });

    it('T-ST4: does not release the session when the socket id does not match', async () => {
      mockRedis.eval.mockResolvedValue(0);

      const result = await sessionService.releaseSession('key1', 'stale-socket');

      expect(result).toBe(false);
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
