import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseImage } from '../models/base-image.js';
import { baseImageService } from './base-image';

vi.mock('../models/base-image.js');

function makeImage(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'img-1' },
    name: 'node-base',
    description: 'Node base image',
    dockerfile: 'FROM node:22-alpine\nRUN echo hi',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    ...overrides,
  };
}

describe('BaseImageService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('list', () => {
    it('T-B1: lists images sorted by updatedAt desc', async () => {
      const lean = vi.fn().mockResolvedValue([makeImage()]);
      (BaseImage.find as any).mockReturnValue({ sort: vi.fn().mockReturnValue({ lean }) });

      const result = await baseImageService.list();

      expect(result).toHaveLength(1);
      expect(result[0].dockerfile).toContain('FROM node');
    });

    it('normalizes missing description to null', async () => {
      const lean = vi.fn().mockResolvedValue([makeImage({ description: undefined })]);
      (BaseImage.find as any).mockReturnValue({ sort: vi.fn().mockReturnValue({ lean }) });

      const result = await baseImageService.list();

      expect(result[0].description).toBeNull();
    });
  });

  describe('get', () => {
    it('T-B1: gets one image by id', async () => {
      (BaseImage.findById as any).mockReturnValue({ lean: vi.fn().mockResolvedValue(makeImage()) });

      const result = await baseImageService.get('img-1');

      expect(result!.name).toBe('node-base');
    });

    it('returns null when image does not exist', async () => {
      (BaseImage.findById as any).mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      expect(await baseImageService.get('missing')).toBeNull();
    });
  });

  describe('create', () => {
    it('T-B1: creates an image preserving the dockerfile text verbatim', async () => {
      const dockerfile = 'FROM node:22-alpine\nRUN npm ci\nCMD ["node"]\n';
      (BaseImage.create as any) = vi.fn().mockResolvedValue({
        ...makeImage({ dockerfile }),
        toObject: () => makeImage({ dockerfile }),
      });

      const result = await baseImageService.create({ name: 'node-base', description: 'Node', dockerfile });

      expect(BaseImage.create).toHaveBeenCalledWith({ name: 'node-base', description: 'Node', dockerfile });
      expect(result.dockerfile).toBe(dockerfile);
    });

    it('rejects an empty name', async () => {
      await expect(baseImageService.create({ name: '   ', dockerfile: 'FROM x' })).rejects.toThrow(
        'Base image name is required',
      );
      expect(BaseImage.create).not.toHaveBeenCalled();
    });

    it('T-B2: propagates duplicate key error (E11000) for resolver mapping', async () => {
      (BaseImage.create as any) = vi.fn().mockRejectedValue(new Error('E11000 duplicate key error'));

      await expect(baseImageService.create({ name: 'node-base', dockerfile: 'FROM x' })).rejects.toThrow('E11000');
    });
  });

  describe('update', () => {
    it('T-B1: updates an image', async () => {
      (BaseImage.findByIdAndUpdate as any) = vi.fn().mockResolvedValue(makeImage({ name: 'renamed' }));

      const result = await baseImageService.update('img-1', {
        name: 'renamed',
        description: 'desc',
        dockerfile: 'FROM y',
      });

      expect(result!.name).toBe('renamed');
      expect(BaseImage.findByIdAndUpdate).toHaveBeenCalledWith(
        'img-1',
        { name: 'renamed', description: 'desc', dockerfile: 'FROM y' },
        { new: true, lean: true },
      );
    });

    it('rejects an empty name', async () => {
      await expect(baseImageService.update('img-1', { name: '', dockerfile: 'FROM y' })).rejects.toThrow(
        'Base image name is required',
      );
    });

    it('returns null when image does not exist', async () => {
      (BaseImage.findByIdAndUpdate as any) = vi.fn().mockResolvedValue(null);

      expect(await baseImageService.update('missing', { name: 'x', dockerfile: 'FROM y' })).toBeNull();
    });
  });

  describe('delete', () => {
    it('T-B1: deletes an image', async () => {
      (BaseImage.deleteOne as any) = vi.fn().mockResolvedValue({ deletedCount: 1 });

      expect(await baseImageService.delete('img-1')).toBe(true);
    });

    it('returns false when image does not exist', async () => {
      (BaseImage.deleteOne as any) = vi.fn().mockResolvedValue({ deletedCount: 0 });

      expect(await baseImageService.delete('missing')).toBe(false);
    });
  });
});
