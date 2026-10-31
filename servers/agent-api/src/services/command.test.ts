import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

import { commandService } from './command.js';
import { getRedisClient } from '../middleware/redis.js';

const mockRedis = {
  publish: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
});

describe('CommandService', () => {
  describe('sendShutdown', () => {
    it('should publish shutdown command to Redis', async () => {
      mockRedis.publish.mockResolvedValue(1);

      await commandService.sendShutdown('key123');

      expect(mockRedis.publish).toHaveBeenCalledWith('controller:command', expect.any(String));
      const { _meta, ...shutdownBody } = JSON.parse(mockRedis.publish.mock.calls[0][1]);
      expect(shutdownBody).toEqual({ type: 'shutdown', keyId: 'key123' });
    });

    it('should throw when Redis publish fails', async () => {
      mockRedis.publish.mockRejectedValue(new Error('Redis connection lost'));

      await expect(commandService.sendShutdown('key123')).rejects.toThrow('Redis connection lost');
    });
  });
});
