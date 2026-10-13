import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/controller-key.js', () => ({
  ControllerKey: {
    create: vi.fn(),
    find: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findOneAndDelete: vi.fn(),
    deleteOne: vi.fn(),
  },
}));

vi.mock('../models/controller.js', () => ({
  Controller: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock('../services/key-cache.js', () => ({
  cacheKey: vi.fn(),
  evictKeyById: vi.fn(),
  getRawKeyById: vi.fn(),
}));

vi.mock('bcryptjs', () => ({
  default: {
    hash: vi.fn(),
    compare: vi.fn(),
  },
}));

vi.mock('crypto', () => ({
  default: {
    randomBytes: vi.fn(),
  },
}));

vi.mock('mongoose', () => ({
  default: {
    Types: {
      ObjectId: class ObjectId {
        constructor(public id: string) {}
        toString() { return this.id; }
      },
    },
  },
}));

vi.mock('../services/command.js', () => ({
  commandService: {
    sendShutdown: vi.fn(),
  },
}));

import { controllerKeyService } from '../services/controller-key.js';
import { ControllerKey } from '../models/controller-key.js';
import { Controller } from '../models/controller.js';
import { evictKeyById, getRawKeyById } from '../services/key-cache.js';
import { commandService } from '../services/command.js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ControllerKeyService', () => {
  describe('create', () => {
    it('should create a new controller key', async () => {
      const mockKeyDoc = {
        _id: { toString: () => 'key123' },
        name: 'My Key',
        type: 'local',
        keyPrefix: 'zag_k_1',
        status: 'active',
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
        toObject: () => ({
          _id: { toString: () => 'key123' },
          name: 'My Key',
          type: 'local',
          keyPrefix: 'zag_k_1',
          status: 'active',
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        }),
      };

      vi.mocked(crypto.randomBytes).mockReturnValue(Buffer.from('a1b2c3d4e5f6') as never);
      vi.mocked(bcrypt.hash).mockResolvedValue('hashed-key' as never);
      vi.mocked(ControllerKey.findOne).mockResolvedValue(null);
      vi.mocked(ControllerKey.create).mockResolvedValue(mockKeyDoc as never);

      const result = await controllerKeyService.create('507f1f77bcf86cd799439011', { name: 'My Key', type: 'local' });

      expect(result.rawKey).toMatch(/^zag_k_1_/);
      expect(result.key).toBeDefined();
      expect(ControllerKey.create).toHaveBeenCalled();
    });

    it('should delete existing unbound key before creating new one', async () => {
      const existingUnboundKey = {
        _id: { toString: () => 'old-key' },
        boundControllerId: null,
      };

      vi.mocked(ControllerKey.findOne).mockResolvedValue(existingUnboundKey as never);
      vi.mocked(evictKeyById).mockResolvedValue();
      vi.mocked(ControllerKey.deleteOne).mockResolvedValue({} as never);

      const mockKeyDoc = {
        _id: { toString: () => 'new-key' },
        name: 'New Key',
        type: 'local',
        keyPrefix: 'zag_k_1',
        status: 'active',
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
        toObject: () => ({
          _id: { toString: () => 'new-key' },
          name: 'New Key',
          type: 'local',
          keyPrefix: 'zag_k_1',
          status: 'active',
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        }),
      };

      vi.mocked(crypto.randomBytes).mockReturnValue(Buffer.from('a1b2c3d4e5f6') as never);
      vi.mocked(bcrypt.hash).mockResolvedValue('hashed-key' as never);
      vi.mocked(ControllerKey.create).mockResolvedValue(mockKeyDoc as never);

      const result = await controllerKeyService.create('user1', { name: 'New Key', type: 'local' });

      expect(evictKeyById).toHaveBeenCalledWith('old-key');
      expect(ControllerKey.deleteOne).toHaveBeenCalled();
      expect(result.rawKey).toMatch(/^zag_k_1_/);
    });
  });

  describe('findAllByUser', () => {
    it('should return unbound keys with rawKey', async () => {
      const mockKeys = [
        {
          _id: { toString: () => 'key1' },
          name: 'Key 1',
          type: 'local',
          keyPrefix: 'zag_k_1',
          status: 'active',
          boundControllerId: null,
          lastUsedAt: null,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        },
      ];

      vi.mocked(ControllerKey.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue(mockKeys),
      } as never);
      vi.mocked(getRawKeyById).mockResolvedValue('zag_k_1_abc123');

      const result = await controllerKeyService.findAllByUser('user1');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Key 1');
      expect(result[0].rawKey).toBe('zag_k_1_abc123');
      expect(ControllerKey.find).toHaveBeenCalledWith({ userId: 'user1', boundControllerId: null });
    });
  });

  describe('delete', () => {
    it('should delete a key and evict from cache', async () => {
      vi.mocked(ControllerKey.findOneAndDelete).mockResolvedValue({} as never);
      vi.mocked(evictKeyById).mockResolvedValue();

      const result = await controllerKeyService.delete('key1', 'user1');

      expect(result).toBe(true);
      expect(ControllerKey.findOneAndDelete).toHaveBeenCalledWith({ _id: 'key1', userId: 'user1' });
      expect(evictKeyById).toHaveBeenCalledWith('key1');
    });

    it('should return false when key not found', async () => {
      vi.mocked(ControllerKey.findOneAndDelete).mockResolvedValue(null as never);

      const result = await controllerKeyService.delete('key1', 'user1');

      expect(result).toBe(false);
    });
  });

  describe('regenerate', () => {
    it('should regenerate a controller key', async () => {
      const mockController = {
        _id: { toString: () => 'ctrl1' },
        keyId: { toString: () => 'key1' },
        userId: 'user1',
      };

      const mockExistingKey = {
        _id: { toString: () => 'key1' },
        name: 'My Key',
        type: 'local',
        keyPrefix: 'zag_k_1',
        status: 'active',
        boundControllerId: 'ctrl1',
        lastUsedAt: null,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      };

      const mockUpdatedKey = {
        _id: { toString: () => 'key1' },
        name: 'My Key',
        type: 'local',
        keyPrefix: 'zag_k_1_abc',
        status: 'active',
        boundControllerId: 'ctrl1',
        lastUsedAt: new Date(),
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date(),
      };

      vi.mocked(Controller.findOne).mockResolvedValue(mockController as never);
      vi.mocked(ControllerKey.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockExistingKey),
      } as never);
      vi.mocked(crypto.randomBytes).mockReturnValue(Buffer.from('a1b2c3d4e5f6') as never);
      vi.mocked(bcrypt.hash).mockResolvedValue('hashed-key' as never);
      vi.mocked(ControllerKey.findOneAndUpdate).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockUpdatedKey),
      } as never);
      vi.mocked(Controller.findOneAndUpdate).mockResolvedValue({} as never);
      vi.mocked(evictKeyById).mockResolvedValue();
      vi.mocked(commandService.sendShutdown).mockResolvedValue();

      const result = await controllerKeyService.regenerate('ctrl1', 'user1');

      expect(result).toBeDefined();
      expect(result?.rawKey).toMatch(/^zag_k_1_/);
      expect(evictKeyById).toHaveBeenCalledWith('key1');
      expect(commandService.sendShutdown).toHaveBeenCalledWith('key1');
    });

    it('should return null when controller not found', async () => {
      vi.mocked(Controller.findOne).mockResolvedValue(null as never);

      const result = await controllerKeyService.regenerate('ctrl1', 'user1');

      expect(result).toBeNull();
    });

    it('should return null when key not found', async () => {
      const mockController = {
        _id: { toString: () => 'ctrl1' },
        keyId: { toString: () => 'key1' },
        userId: 'user1',
      };

      vi.mocked(Controller.findOne).mockResolvedValue(mockController as never);
      vi.mocked(ControllerKey.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      const result = await controllerKeyService.regenerate('ctrl1', 'user1');

      expect(result).toBeNull();
    });
  });
});
