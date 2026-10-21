import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/controller-key.js', () => ({
  ControllerKey: {
    create: vi.fn(),
    findOne: vi.fn(),
    findOneAndDelete: vi.fn(),
  },
}));

vi.mock('../models/controller.js', () => ({
  Controller: { findOne: vi.fn(), findOneAndUpdate: vi.fn() },
}));

vi.mock('../services/key-cache.js', () => ({
  cacheKey: vi.fn(),
  evictKeyById: vi.fn(),
  getRawKeyById: vi.fn(),
}));

vi.mock('../services/command.js', () => ({
  commandService: { sendShutdown: vi.fn() },
}));

import { ControllerKeyService } from './controller-key.js';
import { ControllerKey } from '../models/controller-key.js';
import { cacheKey } from '../services/key-cache.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ControllerKeyService.createForCloudHost', () => {
  it('binds a cloud key without deleting existing unbound keys', async () => {
    vi.mocked(ControllerKey.create).mockResolvedValue({
      _id: { toString: () => 'key-1' },
      name: 'my-cloud',
      type: 'cloud',
      keyPrefix: 'zag_k_1',
      status: 'active',
      lastUsedAt: null,
      createdAt: new Date('2026-10-20'),
      updatedAt: new Date('2026-10-20'),
      toObject() {
        return this;
      },
    } as never);

    const service = new ControllerKeyService();
    const result = await service.createForCloudHost(
      '507f1f77bcf86cd799439011',
      '507f1f77bcf86cd799439012',
      'my-cloud',
    );

    expect(result.rawKey.startsWith('zag_k_1_')).toBe(true);
    expect(ControllerKey.findOne).not.toHaveBeenCalled();
    expect(ControllerKey.findOneAndDelete).not.toHaveBeenCalled();
    const created = vi.mocked(ControllerKey.create).mock.calls[0][0] as Record<string, unknown>;
    expect(created).toMatchObject({ type: 'cloud', name: 'my-cloud', status: 'active' });
    expect(String(created.boundControllerId)).toContain('507f1f77bcf86cd799439012');
    expect(cacheKey).toHaveBeenCalledWith(
      result.rawKey,
      expect.objectContaining({ keyId: 'key-1', type: 'cloud' }),
    );
  });
});
