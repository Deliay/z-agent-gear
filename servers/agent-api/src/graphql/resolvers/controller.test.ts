import { describe, it, expect, vi, beforeEach } from 'vitest';
import { controllerResolvers } from './controller.js';

vi.mock('../../services/controller-key.js', () => ({
  controllerKeyService: {
    create: vi.fn(),
    findAllByUser: vi.fn(),
    rename: vi.fn(),
  },
}));

vi.mock('../../services/controller.js', () => ({
  controllerService: {
    findAllByUser: vi.fn(),
    findById: vi.fn(),
    rename: vi.fn(),
    unbind: vi.fn(),
  },
}));

import { controllerKeyService } from '../../services/controller-key.js';
import { controllerService } from '../../services/controller.js';

const mockContext = {
  currentUser: { id: 'user1', username: 'testuser' },
};

const emptyContext = {
  currentUser: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Controller Resolvers', () => {
  describe('Query.controllerKeys', () => {
    it('should return all keys for authenticated user', async () => {
      const mockKeys = [{ id: 'key1', name: 'Key 1' }];
      vi.mocked(controllerKeyService.findAllByUser).mockResolvedValue(mockKeys);

      const result = await controllerResolvers.Query.controllerKeys(
        {},
        {},
        mockContext,
      );

      expect(result).toEqual(mockKeys);
      expect(controllerKeyService.findAllByUser).toHaveBeenCalledWith('user1');
    });

    it('should throw when not authenticated', async () => {
      await expect(
        controllerResolvers.Query.controllerKeys({}, {}, emptyContext),
      ).rejects.toThrow('Not authenticated');
    });
  });

  describe('Query.controllers', () => {
    it('should return all controllers for authenticated user', async () => {
      const mockControllers = [{ id: 'ctrl1', name: 'My Machine' }];
      vi.mocked(controllerService.findAllByUser).mockResolvedValue(mockControllers);

      const result = await controllerResolvers.Query.controllers(
        {},
        {},
        mockContext,
      );

      expect(result).toEqual(mockControllers);
      expect(controllerService.findAllByUser).toHaveBeenCalledWith('user1');
    });

    it('should throw when not authenticated', async () => {
      await expect(
        controllerResolvers.Query.controllers({}, {}, emptyContext),
      ).rejects.toThrow('Not authenticated');
    });
  });

  describe('Query.controller', () => {
    it('should return a controller by id', async () => {
      const mockController = { id: 'ctrl1', name: 'My Machine' };
      vi.mocked(controllerService.findById).mockResolvedValue(mockController);

      const result = await controllerResolvers.Query.controller(
        {},
        { id: 'ctrl1' },
        mockContext,
      );

      expect(result).toEqual(mockController);
      expect(controllerService.findById).toHaveBeenCalledWith('ctrl1', 'user1');
    });

    it('should throw when not authenticated', async () => {
      await expect(
        controllerResolvers.Query.controller({}, { id: 'ctrl1' }, emptyContext),
      ).rejects.toThrow('Not authenticated');
    });
  });

  describe('Mutation.createControllerKey', () => {
    it('should create a new controller key', async () => {
      const mockResult = { key: { id: 'key1' }, rawKey: 'zag_k_1_abc' };
      vi.mocked(controllerKeyService.create).mockResolvedValue(mockResult);

      const result = await controllerResolvers.Mutation.createControllerKey(
        {},
        { input: { name: 'My Key', type: 'local' } },
        mockContext,
      );

      expect(result).toEqual(mockResult);
      expect(controllerKeyService.create).toHaveBeenCalledWith('user1', {
        name: 'My Key',
        type: 'local',
      });
    });

    it('should throw when not authenticated', async () => {
      await expect(
        controllerResolvers.Mutation.createControllerKey(
          {},
          { input: { name: 'My Key', type: 'local' } },
          emptyContext,
        ),
      ).rejects.toThrow('Not authenticated');
    });
  });

  describe('Mutation.renameControllerKey', () => {
    it('should rename a controller key', async () => {
      const mockResult = { id: 'key1', name: 'New Name' };
      vi.mocked(controllerKeyService.rename).mockResolvedValue(mockResult);

      const result = await controllerResolvers.Mutation.renameControllerKey(
        {},
        { input: { id: 'key1', name: 'New Name' } },
        mockContext,
      );

      expect(result).toEqual(mockResult);
      expect(controllerKeyService.rename).toHaveBeenCalledWith('key1', 'user1', 'New Name');
    });

    it('should throw when key not found', async () => {
      vi.mocked(controllerKeyService.rename).mockResolvedValue(null);

      await expect(
        controllerResolvers.Mutation.renameControllerKey(
          {},
          { input: { id: 'key1', name: 'New Name' } },
          mockContext,
        ),
      ).rejects.toThrow('Key not found');
    });

    it('should throw when not authenticated', async () => {
      await expect(
        controllerResolvers.Mutation.renameControllerKey(
          {},
          { input: { id: 'key1', name: 'New Name' } },
          emptyContext,
        ),
      ).rejects.toThrow('Not authenticated');
    });
  });

  describe('Mutation.renameController', () => {
    it('should rename a controller', async () => {
      const mockResult = { id: 'ctrl1', name: 'New Name' };
      vi.mocked(controllerService.rename).mockResolvedValue(mockResult);

      const result = await controllerResolvers.Mutation.renameController(
        {},
        { input: { id: 'ctrl1', name: 'New Name' } },
        mockContext,
      );

      expect(result).toEqual(mockResult);
      expect(controllerService.rename).toHaveBeenCalledWith('ctrl1', 'user1', 'New Name');
    });

    it('should throw when controller not found', async () => {
      vi.mocked(controllerService.rename).mockResolvedValue(null);

      await expect(
        controllerResolvers.Mutation.renameController(
          {},
          { input: { id: 'ctrl1', name: 'New Name' } },
          mockContext,
        ),
      ).rejects.toThrow('Controller not found');
    });

    it('should throw when not authenticated', async () => {
      await expect(
        controllerResolvers.Mutation.renameController(
          {},
          { input: { id: 'ctrl1', name: 'New Name' } },
          emptyContext,
        ),
      ).rejects.toThrow('Not authenticated');
    });
  });

  describe('Mutation.unbindController', () => {
    it('should unbind a controller', async () => {
      vi.mocked(controllerService.unbind).mockResolvedValue(true);

      const result = await controllerResolvers.Mutation.unbindController(
        {},
        { id: 'ctrl1' },
        mockContext,
      );

      expect(result).toBe(true);
      expect(controllerService.unbind).toHaveBeenCalledWith('ctrl1', 'user1');
    });

    it('should return false when unbind fails', async () => {
      vi.mocked(controllerService.unbind).mockResolvedValue(false);

      const result = await controllerResolvers.Mutation.unbindController(
        {},
        { id: 'ctrl1' },
        mockContext,
      );

      expect(result).toBe(false);
    });

    it('should throw when not authenticated', async () => {
      await expect(
        controllerResolvers.Mutation.unbindController(
          {},
          { id: 'ctrl1' },
          emptyContext,
        ),
      ).rejects.toThrow('Not authenticated');
    });
  });
});
