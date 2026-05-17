import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/controller-key.js', () => ({
  ControllerKey: {
    create: vi.fn(),
    find: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findOne: vi.fn(),
  },
}));

vi.mock('../models/controller.js', () => ({
  Controller: {},
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

import { controllerKeyService } from '../services/controller-key.js';
import { ControllerKey } from '../models/controller-key.js';
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
      vi.mocked(ControllerKey.create).mockResolvedValue(mockKeyDoc as never);

      const result = await controllerKeyService.create('507f1f77bcf86cd799439011', { name: 'My Key', type: 'local' });

      expect(result.rawKey).toMatch(/^zag_k_1_/);
      expect(result.key).toBeDefined();
      expect(ControllerKey.create).toHaveBeenCalled();
    });
  });

  describe('findAllByUser', () => {
    it('should return all keys for a user', async () => {
      const mockKeys = [
        {
          _id: { toString: () => 'key1' },
          name: 'Key 1',
          type: 'local',
          keyPrefix: 'zag_k_1',
          status: 'active',
          lastUsedAt: null,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        },
      ];

      vi.mocked(ControllerKey.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue(mockKeys),
      } as never);

      const result = await controllerKeyService.findAllByUser('user1');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Key 1');
    });
  });

  describe('revoke', () => {
    it('should revoke an active key', async () => {
      vi.mocked(ControllerKey.findOneAndUpdate).mockResolvedValue({} as never);

      const result = await controllerKeyService.revoke('key1', 'user1');

      expect(result).toBe(true);
      expect(ControllerKey.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'key1', userId: 'user1', status: 'active' },
        { status: 'revoked' },
      );
    });

    it('should return false when key not found', async () => {
      vi.mocked(ControllerKey.findOneAndUpdate).mockResolvedValue(null as never);

      const result = await controllerKeyService.revoke('key1', 'user1');

      expect(result).toBe(false);
    });
  });
});
