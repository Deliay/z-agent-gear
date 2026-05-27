import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/port-forward.js', () => ({
  PortForward: {
    find: vi.fn(),
    findOne: vi.fn(),
    countDocuments: vi.fn(),
    create: vi.fn(),
    deleteOne: vi.fn(),
  },
}));

vi.mock('../models/controller.js', () => ({
  Controller: {
    findOne: vi.fn(),
  },
}));

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

import { portForwardService } from './port-forward.js';
import { PortForward } from '../models/port-forward.js';
import { Controller } from '../models/controller.js';
import { getRedisClient } from '../middleware/redis.js';

const mockRedis = { publish: vi.fn().mockResolvedValue(1) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
});

describe('PortForwardService', () => {
  describe('findAllByController', () => {
    it('should return port forwards for a controller', async () => {
      const now = new Date();
      vi.mocked(PortForward.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([
            {
              _id: { toString: () => 'pf1' },
              controllerId: { toString: () => 'ctrl1' },
              port: 3000,
              status: 'active',
              createdAt: now,
            },
          ]),
        }),
      } as never);

      const result = await portForwardService.findAllByController('ctrl1', 'user1');

      expect(result.portForwards).toHaveLength(1);
      expect(result.portForwards[0].port).toBe(3000);
      expect(result.total).toBe(1);
    });

    it('should return empty list when no port forwards exist', async () => {
      vi.mocked(PortForward.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      } as never);

      const result = await portForwardService.findAllByController('ctrl1', 'user1');

      expect(result.portForwards).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe('create', () => {
    it('should create a port forward and publish Redis command', async () => {
      const now = new Date();
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl1', status: 'online' }),
      } as never);
      vi.mocked(PortForward.countDocuments).mockResolvedValue(0);
      vi.mocked(PortForward.findOne).mockResolvedValue(null);
      vi.mocked(PortForward.create).mockResolvedValue({
        toObject: () => ({
          _id: { toString: () => 'pf1' },
          controllerId: { toString: () => 'ctrl1' },
          port: 3000,
          status: 'active',
          createdAt: now,
        }),
      } as never);

      const result = await portForwardService.create('ctrl1', 'user1', 3000, 5);

      expect(result.port).toBe(3000);
      expect(result.status).toBe('active');
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'port-forward:command',
        JSON.stringify({ type: 'tunnel:create', controllerId: 'ctrl1', port: 3000 }),
      );
    });

    it('should throw when controller not found', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(portForwardService.create('ctrl1', 'user1', 3000, 5)).rejects.toThrow(
        'Controller not found',
      );
    });

    it('should throw when controller is not online', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl1', status: 'offline' }),
      } as never);

      await expect(portForwardService.create('ctrl1', 'user1', 3000, 5)).rejects.toThrow(
        'Controller is not online',
      );
    });

    it('should throw when max port forwards exceeded', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl1', status: 'online' }),
      } as never);
      vi.mocked(PortForward.countDocuments).mockResolvedValue(5);

      await expect(portForwardService.create('ctrl1', 'user1', 3000, 5)).rejects.toThrow(
        'Maximum 5 port forwards per controller',
      );
    });

    it('should throw when port is already forwarded', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl1', status: 'online' }),
      } as never);
      vi.mocked(PortForward.countDocuments).mockResolvedValue(1);
      vi.mocked(PortForward.findOne).mockResolvedValue({ _id: 'pf1' } as never);

      await expect(portForwardService.create('ctrl1', 'user1', 3000, 5)).rejects.toThrow(
        'Port already forwarded',
      );
    });
  });

  describe('delete', () => {
    it('should delete a port forward and publish Redis command', async () => {
      vi.mocked(PortForward.deleteOne).mockResolvedValue({ deletedCount: 1 } as never);

      const result = await portForwardService.delete('ctrl1', 'user1', 3000);

      expect(result).toBe(true);
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'port-forward:command',
        JSON.stringify({ type: 'tunnel:close', controllerId: 'ctrl1', port: 3000 }),
      );
    });

    it('should return false when port forward not found', async () => {
      vi.mocked(PortForward.deleteOne).mockResolvedValue({ deletedCount: 0 } as never);

      const result = await portForwardService.delete('ctrl1', 'user1', 3000);

      expect(result).toBe(false);
    });
  });
});
