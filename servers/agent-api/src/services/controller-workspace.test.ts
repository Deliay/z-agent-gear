import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('../models/controller-workspace.js', () => ({
  ControllerWorkspace: {
    find: vi.fn(),
    findOne: vi.fn(),
    findOneAndDelete: vi.fn(),
    countDocuments: vi.fn(),
    deleteMany: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock('../models/controller.js', () => ({
  Controller: {
    findOne: vi.fn(),
  },
}));

import { controllerWorkspaceService } from './controller-workspace.js';
import { ControllerWorkspace } from '../models/controller-workspace.js';
import { Controller } from '../models/controller.js';
import { getRedisClient } from '../middleware/redis.js';

describe('ControllerWorkspaceService', () => {
  let mockRedisClient: {
    publish: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();

    mockRedisClient = {
      publish: vi.fn().mockResolvedValue(1),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
    };
    vi.mocked(getRedisClient).mockReturnValue(mockRedisClient as never);
  });

  describe('setDefaultBranch', () => {
    it('should update defaultBranch and return workspace', async () => {
      const mockSave = vi.fn().mockResolvedValue(undefined);
      const mockWorkspace = {
        _id: 'ws-1',
        userId: 'user-1',
        controllerId: 'ctrl-1',
        name: 'Project',
        path: '/home/project',
        isEnabled: true,
        defaultBranch: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        save: mockSave,
        toObject: vi.fn().mockReturnThis(),
      };
      vi.mocked(ControllerWorkspace.findOne).mockResolvedValue(mockWorkspace as never);

      const result = await controllerWorkspaceService.setDefaultBranch('ws-1', 'user-1', 'main');

      expect(mockSave).toHaveBeenCalled();
      expect(mockWorkspace.defaultBranch).toBe('main');
      expect(result.defaultBranch).toBe('main');
    });

    it('should throw when workspace not found', async () => {
      vi.mocked(ControllerWorkspace.findOne).mockResolvedValue(null);

      await expect(
        controllerWorkspaceService.setDefaultBranch('ws-1', 'user-1', 'main'),
      ).rejects.toThrow('Workspace not found');
    });
  });

  describe('detectGitRepo', () => {
    it('should detect git repo via redis pub/sub', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'ctrl-1',
          userId: 'user-1',
          status: 'online',
        }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'ws-1',
          userId: 'user-1',
          controllerId: 'ctrl-1',
          path: '/home/project',
        }),
      } as never);

      const gitResult = {
        isGitRepo: true,
        currentBranch: 'main',
        branches: ['main', 'develop'],
        defaultBranch: 'main',
      };

      // First get returns null (cache miss), then returns result
      mockRedisClient.get
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify(gitResult));

      const result = await controllerWorkspaceService.detectGitRepo('ctrl-1', 'ws-1', 'user-1');

      expect(mockRedisClient.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"git:check"'),
      );
      expect(result).toEqual(gitResult);
    });

    it('should return cached result if available', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'ctrl-1',
          status: 'online',
        }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'ws-1',
          path: '/home/project',
        }),
      } as never);

      const cachedResult = {
        isGitRepo: true,
        currentBranch: 'main',
        branches: ['main'],
        defaultBranch: 'main',
      };
      mockRedisClient.get.mockResolvedValueOnce(JSON.stringify(cachedResult));

      const result = await controllerWorkspaceService.detectGitRepo('ctrl-1', 'ws-1', 'user-1');

      expect(mockRedisClient.publish).not.toHaveBeenCalled();
      expect(result).toEqual(cachedResult);
    });

    it('should throw when controller offline', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'ctrl-1',
          status: 'offline',
        }),
      } as never);

      await expect(
        controllerWorkspaceService.detectGitRepo('ctrl-1', 'ws-1', 'user-1'),
      ).rejects.toThrow('Controller is offline');
    });

    it('should throw when controller not found in detectGitRepo', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(
        controllerWorkspaceService.detectGitRepo('ctrl-1', 'ws-1', 'user-1'),
      ).rejects.toThrow('Controller not found');
    });

    it('should throw when workspace not found in detectGitRepo', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'ctrl-1',
          status: 'online',
        }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(
        controllerWorkspaceService.detectGitRepo('ctrl-1', 'ws-1', 'user-1'),
      ).rejects.toThrow('Workspace not found');
    });

    it('should throw timeout when no result after polling', async () => {
      vi.useFakeTimers();

      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'ctrl-1',
          status: 'online',
        }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'ws-1',
          path: '/home/project',
        }),
      } as never);
      mockRedisClient.get.mockResolvedValue(null);

      const promise = controllerWorkspaceService.detectGitRepo('ctrl-1', 'ws-1', 'user-1');
      promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(30000);

      await expect(promise).rejects.toThrow('Git detection timeout');

      vi.useRealTimers();
    });
  });

  describe('initGitRepo', () => {
    it('should init git repo via redis pub/sub', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'ctrl-1',
          status: 'online',
        }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'ws-1',
          path: '/home/project',
        }),
      } as never);

      // First get returns null (waiting), then returns success
      mockRedisClient.get
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify({ success: true }));

      const result = await controllerWorkspaceService.initGitRepo('ctrl-1', 'ws-1', 'user-1');

      expect(mockRedisClient.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"git:init"'),
      );
      expect(result).toBe(true);
    });

    it('should invalidate branches cache after successful init', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'ctrl-1',
          status: 'online',
        }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'ws-1',
          path: '/home/project',
        }),
      } as never);

      mockRedisClient.get
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify({ success: true }));

      await controllerWorkspaceService.initGitRepo('ctrl-1', 'ws-1', 'user-1');

      expect(mockRedisClient.del).toHaveBeenCalledWith(
        expect.stringContaining('git:branches:'),
      );
    });

    it('should throw when init fails', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'ctrl-1',
          status: 'online',
        }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'ws-1',
          path: '/home/project',
        }),
      } as never);

      mockRedisClient.get
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify({ success: false, error: 'permission denied' }));

      await expect(
        controllerWorkspaceService.initGitRepo('ctrl-1', 'ws-1', 'user-1'),
      ).rejects.toThrow('permission denied');
    });

    it('should throw when controller not found in initGitRepo', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(
        controllerWorkspaceService.initGitRepo('ctrl-1', 'ws-1', 'user-1'),
      ).rejects.toThrow('Controller not found');
    });

    it('should throw when controller offline in initGitRepo', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'ctrl-1',
          status: 'offline',
        }),
      } as never);

      await expect(
        controllerWorkspaceService.initGitRepo('ctrl-1', 'ws-1', 'user-1'),
      ).rejects.toThrow('Controller is offline');
    });

    it('should throw when workspace not found in initGitRepo', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'ctrl-1',
          status: 'online',
        }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(
        controllerWorkspaceService.initGitRepo('ctrl-1', 'ws-1', 'user-1'),
      ).rejects.toThrow('Workspace not found');
    });
  });
});
