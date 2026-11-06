import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('../models/controller-workspace.js', () => ({
  ControllerWorkspace: {
    find: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findByIdAndUpdate: vi.fn(),
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

vi.mock('./session.js', () => ({
  sessionService: {
    archiveByWorkspace: vi.fn(),
  },
}));

import { controllerWorkspaceService } from './controller-workspace.js';
import { sessionService } from './session.js';
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

  describe('createFolder', () => {
    it('should create folder via redis pub/sub', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'ctrl-1',
          status: 'online',
        }),
      } as never);

      mockRedisClient.get
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify({ success: true, name: 'new-folder', path: '/home/user/new-folder' }));

      const result = await controllerWorkspaceService.createFolder('ctrl-1', 'user-1', '/home/user', 'new-folder');

      expect(mockRedisClient.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"fs:mkdir"'),
      );
      expect(result.name).toBe('new-folder');
      expect(result.path).toBe('/home/user/new-folder');
    });

    it('should throw when controller not found', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(
        controllerWorkspaceService.createFolder('ctrl-1', 'user-1', '/home/user', 'new-folder'),
      ).rejects.toThrow('Controller not found');
    });

    it('should throw when controller offline', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'ctrl-1',
          status: 'offline',
        }),
      } as never);

      await expect(
        controllerWorkspaceService.createFolder('ctrl-1', 'user-1', '/home/user', 'new-folder'),
      ).rejects.toThrow('Controller is offline');
    });

    it('should throw on mkdir failure', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'ctrl-1',
          status: 'online',
        }),
      } as never);

      mockRedisClient.get
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify({ success: false, error: 'permission denied' }));

      await expect(
        controllerWorkspaceService.createFolder('ctrl-1', 'user-1', '/home/user', 'new-folder'),
      ).rejects.toThrow('permission denied');
    });
  });

  describe('删除/清空工作区连带归档（T-WSARC4）', () => {
    const workspaceDoc = {
      _id: 'ws-1',
      userId: 'user-1',
      controllerId: 'ctrl-1',
      name: 'project',
      path: '/home/user/project',
    };

    it('delete：先连带归档再删除工作区行（顺序断言）', async () => {
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(workspaceDoc),
      } as never);
      vi.mocked(sessionService.archiveByWorkspace).mockResolvedValue(2 as never);
      vi.mocked(ControllerWorkspace.findOneAndDelete).mockResolvedValue(workspaceDoc as never);

      await expect(controllerWorkspaceService.delete('ws-1', 'user-1')).resolves.toBe(true);

      expect(sessionService.archiveByWorkspace).toHaveBeenCalledWith('user-1', workspaceDoc);
      expect(ControllerWorkspace.findOneAndDelete).toHaveBeenCalledWith({
        _id: 'ws-1',
        userId: 'user-1',
      });
      expect(
        vi.mocked(sessionService.archiveByWorkspace).mock.invocationCallOrder[0],
      ).toBeLessThan(
        vi.mocked(ControllerWorkspace.findOneAndDelete).mock.invocationCallOrder[0],
      );
    });

    it('delete：归档失败抛错中止删除（工作区行保留）', async () => {
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(workspaceDoc),
      } as never);
      vi.mocked(sessionService.archiveByWorkspace).mockRejectedValue(new Error('archive failed'));

      await expect(controllerWorkspaceService.delete('ws-1', 'user-1')).rejects.toThrow(
        'archive failed',
      );
      expect(ControllerWorkspace.findOneAndDelete).not.toHaveBeenCalled();
    });

    it('delete：工作区不存在返回 false 且不触发归档', async () => {
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(controllerWorkspaceService.delete('nope', 'user-1')).resolves.toBe(false);
      expect(sessionService.archiveByWorkspace).not.toHaveBeenCalled();
      expect(ControllerWorkspace.findOneAndDelete).not.toHaveBeenCalled();
    });

    it('clear：逐个工作区连带归档，全部成功后才 deleteMany', async () => {
      const second = { ...workspaceDoc, _id: 'ws-2' };
      vi.mocked(ControllerWorkspace.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue([workspaceDoc, second]),
      } as never);
      vi.mocked(sessionService.archiveByWorkspace).mockResolvedValue(1 as never);
      vi.mocked(ControllerWorkspace.deleteMany).mockResolvedValue({ deletedCount: 2 } as never);

      await expect(controllerWorkspaceService.clear('ctrl-1', 'user-1')).resolves.toBe(true);

      expect(sessionService.archiveByWorkspace).toHaveBeenCalledTimes(2);
      expect(sessionService.archiveByWorkspace).toHaveBeenNthCalledWith(1, 'user-1', workspaceDoc);
      expect(sessionService.archiveByWorkspace).toHaveBeenNthCalledWith(2, 'user-1', second);
      expect(ControllerWorkspace.deleteMany).toHaveBeenCalledWith({
        controllerId: 'ctrl-1',
        userId: 'user-1',
      });
      expect(
        vi.mocked(sessionService.archiveByWorkspace).mock.invocationCallOrder[1],
      ).toBeLessThan(vi.mocked(ControllerWorkspace.deleteMany).mock.invocationCallOrder[0]);
    });

    it('clear：任一工作区归档失败即中止（deleteMany 不执行）', async () => {
      vi.mocked(ControllerWorkspace.find).mockReturnValue({
        lean: vi
          .fn()
          .mockResolvedValue([workspaceDoc, { ...workspaceDoc, _id: 'ws-2' }]),
      } as never);
      vi.mocked(sessionService.archiveByWorkspace)
        .mockResolvedValueOnce(1 as never)
        .mockRejectedValueOnce(new Error('archive failed'));

      await expect(controllerWorkspaceService.clear('ctrl-1', 'user-1')).rejects.toThrow(
        'archive failed',
      );
      expect(sessionService.archiveByWorkspace).toHaveBeenCalledTimes(2);
      expect(ControllerWorkspace.deleteMany).not.toHaveBeenCalled();
    });
  });
});
