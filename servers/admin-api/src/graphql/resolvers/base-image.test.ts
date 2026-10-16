import { describe, it, expect, vi, beforeEach } from 'vitest';
import { baseImageResolvers } from './base-image';

vi.mock('../../services/base-image.js', () => ({
  baseImageService: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

import { baseImageService } from '../../services/base-image.js';
import type { AdminAuthContext } from './auth.js';

const good: AdminAuthContext = { currentAdmin: { id: 'a1', username: 'admin', mustChangePassword: false } };
const locked: AdminAuthContext = { currentAdmin: { id: 'a1', username: 'admin', mustChangePassword: true } };
const anon: AdminAuthContext = { currentAdmin: null };

const Query = baseImageResolvers.Query as any;
const Mutation = baseImageResolvers.Mutation as any;

const input = { name: 'node-base', description: 'Node', dockerfile: 'FROM node:22-alpine' };

describe('baseImageResolvers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('queries + guard', () => {
    it('T-A7: rejects anonymous access', async () => {
      await expect(Query.baseImages({}, {}, anon)).rejects.toThrow('Not authenticated');
    });

    it('T-A7: rejects mustChangePassword access', async () => {
      await expect(Query.baseImages({}, {}, locked)).rejects.toThrow('MUST_CHANGE_PASSWORD');
    });

    it('baseImages delegates', async () => {
      (baseImageService.list as any).mockResolvedValue([{ id: 'img-1' }]);
      await expect(Query.baseImages({}, {}, good)).resolves.toEqual([{ id: 'img-1' }]);
    });

    it('baseImage delegates', async () => {
      (baseImageService.get as any).mockResolvedValue({ id: 'img-1' });
      await expect(Query.baseImage({}, { id: 'img-1' }, good)).resolves.toEqual({ id: 'img-1' });
    });
  });

  describe('mutations', () => {
    it('T-B2: createBaseImage maps duplicate name error', async () => {
      (baseImageService.create as any).mockRejectedValue(new Error('E11000 duplicate key error'));
      await expect(Mutation.createBaseImage({}, { input }, good)).rejects.toThrow('Base image name already exists');
    });

    it('createBaseImage returns the created image', async () => {
      (baseImageService.create as any).mockResolvedValue({ id: 'img-1' });
      await expect(Mutation.createBaseImage({}, { input }, good)).resolves.toEqual({ id: 'img-1' });
    });

    it('updateBaseImage throws when image missing', async () => {
      (baseImageService.update as any).mockResolvedValue(null);
      await expect(Mutation.updateBaseImage({}, { id: 'img-1', input }, good)).rejects.toThrow(
        'Base image not found',
      );
    });

    it('T-B2: updateBaseImage maps duplicate name error', async () => {
      (baseImageService.update as any).mockRejectedValue(new Error('E11000 duplicate key error'));
      await expect(Mutation.updateBaseImage({}, { id: 'img-1', input }, good)).rejects.toThrow(
        'Base image name already exists',
      );
    });

    it('updateBaseImage returns the updated image', async () => {
      (baseImageService.update as any).mockResolvedValue({ id: 'img-1', name: 'renamed' });
      await expect(Mutation.updateBaseImage({}, { id: 'img-1', input }, good)).resolves.toEqual({
        id: 'img-1',
        name: 'renamed',
      });
    });

    it('deleteBaseImage delegates', async () => {
      (baseImageService.delete as any).mockResolvedValue(true);
      await expect(Mutation.deleteBaseImage({}, { id: 'img-1' }, good)).resolves.toBe(true);
    });
  });
});
