import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/controller.js', () => ({
  Controller: {
    find: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
  },
}));

vi.mock('../models/controller-key.js', () => ({
  ControllerKey: {
    deleteOne: vi.fn(),
  },
}));

vi.mock('../services/key-cache.js', () => ({
  evictKeyById: vi.fn(),
}));

vi.mock('./command.js', () => ({
  commandService: {
    sendShutdown: vi.fn(),
  },
}));

import { controllerService } from '../services/controller.js';
import { Controller } from '../models/controller.js';
import { ControllerKey } from '../models/controller-key.js';
import { evictKeyById } from '../services/key-cache.js';
import { commandService } from './command.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ControllerService', () => {
  describe('findAllByUser', () => {
    it('should return all controllers for a user', async () => {
      const mockControllers = [
        {
          _id: { toString: () => 'ctrl1' },
          name: 'My Machine',
          hostname: 'dev-machine',
          type: 'local',
          status: 'online',
          keyId: { toString: () => 'key1' },
          version: '1.0.0',
          lastHeartbeatAt: new Date(),
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        },
      ];

      vi.mocked(Controller.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue(mockControllers),
      } as never);

      const result = await controllerService.findAllByUser('user1');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('My Machine');
    });
  });

  describe('rename', () => {
    it('should rename a controller', async () => {
      vi.mocked(Controller.findOneAndUpdate).mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: { toString: () => 'ctrl1' },
          name: 'New Name',
          hostname: 'dev-machine',
          type: 'local',
          status: 'online',
          keyId: { toString: () => 'key1' },
          version: '1.0.0',
          lastHeartbeatAt: null,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        }),
      } as never);

      const result = await controllerService.rename('ctrl1', 'user1', 'New Name');

      expect(result).toBeDefined();
      expect(result?.name).toBe('New Name');
    });

    it('should return null when controller not found', async () => {
      vi.mocked(Controller.findOneAndUpdate).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      const result = await controllerService.rename('ctrl1', 'user1', 'New Name');

      expect(result).toBeNull();
    });
  });

  describe('unbind', () => {
    it('should delete key and controller, send shutdown, and evict cache', async () => {
      vi.mocked(Controller.findOne).mockResolvedValue({
        keyId: { toString: () => 'key1' },
      } as never);
      vi.mocked(commandService.sendShutdown).mockResolvedValue();
      vi.mocked(evictKeyById).mockResolvedValue(true);
      vi.mocked(ControllerKey.deleteOne).mockResolvedValue({} as never);
      vi.mocked(Controller.deleteOne).mockResolvedValue({} as never);

      const result = await controllerService.unbind('ctrl1', 'user1');

      expect(result).toBe(true);
      expect(commandService.sendShutdown).toHaveBeenCalledWith('key1');
      expect(evictKeyById).toHaveBeenCalledWith('key1');
      expect(ControllerKey.deleteOne).toHaveBeenCalledWith({ _id: 'key1' });
      expect(Controller.deleteOne).toHaveBeenCalledWith({ _id: 'ctrl1' });
    });

    it('should return false when controller not found', async () => {
      vi.mocked(Controller.findOne).mockResolvedValue(null as never);

      const result = await controllerService.unbind('ctrl1', 'user1');

      expect(result).toBe(false);
    });
  });

  describe('setWorktreeDir', () => {
    it('should set worktreeDir and return controller', async () => {
      vi.mocked(Controller.findOneAndUpdate).mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: { toString: () => 'ctrl1' },
          name: 'My Machine',
          hostname: 'dev-machine',
          type: 'local',
          status: 'online',
          keyId: { toString: () => 'key1' },
          worktreeDir: '/custom/worktrees',
          version: '1.0.0',
          lastHeartbeatAt: null,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        }),
      } as never);

      const result = await controllerService.setWorktreeDir('ctrl1', 'user1', '/custom/worktrees');

      expect(result).toBeDefined();
      expect(result?.worktreeDir).toBe('/custom/worktrees');
      expect(Controller.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'ctrl1', userId: 'user1' },
        { worktreeDir: '/custom/worktrees' },
        { new: true },
      );
    });

    it('should return null when controller not found', async () => {
      vi.mocked(Controller.findOneAndUpdate).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      const result = await controllerService.setWorktreeDir('ctrl1', 'user1', '/custom/worktrees');
      expect(result).toBeNull();
    });
  });
});
