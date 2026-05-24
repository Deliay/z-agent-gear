import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('../models/controller.js', () => ({
  Controller: {
    findById: vi.fn(),
  },
}));

vi.mock('./session.js', () => ({
  sessionService: {
    getSocketId: vi.fn(),
  },
}));

vi.mock('./acp-session-manager.js', () => ({
  acpSessionManager: {
    setMode: vi.fn(),
    setModel: vi.fn(),
  },
}));

vi.mock('./acp-capability-detector.js', () => ({
  acpCapabilityDetector: {
    detectCapabilities: vi.fn(),
    invalidateCache: vi.fn(),
  },
}));

vi.mock('./acp-session-sync.js', () => ({
  acpSessionSyncService: {
    listSessions: vi.fn(),
    cacheListResult: vi.fn(),
    loadSession: vi.fn(),
    cacheLoadResult: vi.fn(),
  },
}));

vi.mock('./folder-browser.js', () => ({
  folderBrowserService: {
    browse: vi.fn(),
    getHomeDirectory: vi.fn(),
  },
}));

vi.mock('./worktree-service.js', () => ({
  worktreeService: {
    handleAdd: vi.fn(),
    handleRemove: vi.fn(),
    handleStatus: vi.fn(),
    handleCommit: vi.fn(),
  },
}));

vi.mock('./fs-mkdir-service.js', () => ({
  fsMkdirService: {
    handleMkdir: vi.fn(),
  },
}));

import { SessionCommandService } from './session-command.js';
import { getRedisClient } from '../middleware/redis.js';
import { acpSessionManager } from './acp-session-manager.js';
import { acpCapabilityDetector } from './acp-capability-detector.js';
import { worktreeService} from './worktree-service.js';
import { fsMkdirService } from './fs-mkdir-service.js';

function createMockRedis() {
  const messageHandlers: ((channel: string, message: string) => void)[] = [];
  return {
    duplicate: vi.fn().mockReturnThis(),
    subscribe: vi.fn(),
    on: vi.fn((event: string, handler: (channel: string, message: string) => void) => {
      if (event === 'message') {
        messageHandlers.push(handler);
      }
    }),
    _emitMessage: (channel: string, message: string) => {
      messageHandlers.forEach((h) => { h(channel, message); });
    },
  };
}

function createMockIO() {
  return {
    to: vi.fn().mockReturnThis(),
    emit: vi.fn(),
    sockets: {
      sockets: new Map(),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SessionCommandService', () => {
  describe('acp:cache:invalidate command', () => {
    it('should call acpCapabilityDetector.invalidateCache', async () => {
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);

      const service = new SessionCommandService();
      service.start(createMockIO() as never);

      mockRedis._emitMessage('session:command', JSON.stringify({
        type: 'acp:cache:invalidate',
        controllerId: 'ctrl-1',
      }));

      await vi.waitFor(() => {
        expect(acpCapabilityDetector.invalidateCache).toHaveBeenCalledWith('ctrl-1');
      });
    });

    it('should not call invalidateCache without controllerId', async () => {
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);

      const service = new SessionCommandService();
      service.start(createMockIO() as never);

      mockRedis._emitMessage('session:command', JSON.stringify({
        type: 'acp:cache:invalidate',
      }));

      // allow async handlers to run
      await new Promise((r) => setTimeout(r, 50));
      expect(acpCapabilityDetector.invalidateCache).not.toHaveBeenCalled();
    });
  });

  describe('acp:set-model command', () => {
    it('should route acp:set-model to acpSessionManager.setModel', async () => {
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      vi.mocked(acpSessionManager.setModel).mockResolvedValue(true);

      const service = new SessionCommandService();
      service.start(createMockIO() as never);

      mockRedis._emitMessage('session:command', JSON.stringify({
        type: 'acp:set-model',
        sessionId: 'sess-1',
        modelId: 'model-2',
      }));

      await vi.waitFor(() => {
        expect(acpSessionManager.setModel).toHaveBeenCalledWith('sess-1', 'model-2');
      });
    });

    it('should log error when session not found', async () => {
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      vi.mocked(acpSessionManager.setModel).mockResolvedValue(false);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const service = new SessionCommandService();
      service.start(createMockIO() as never);

      mockRedis._emitMessage('session:command', JSON.stringify({
        type: 'acp:set-model',
        sessionId: 'sess-1',
        modelId: 'model-2',
      }));

      await vi.waitFor(() => {
        expect(acpSessionManager.setModel).toHaveBeenCalledWith('sess-1', 'model-2');
        expect(consoleSpy).toHaveBeenCalledWith(
          'ACP set-model failed: session sess-1 not found in active sessions',
        );
      });

      consoleSpy.mockRestore();
    });
  });

  describe('fs:mkdir command', () => {
    it('should route fs:mkdir to fsMkdirService.handleMkdir', async () => {
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);

      const service = new SessionCommandService();
      service.start(createMockIO() as never);

      mockRedis._emitMessage('session:command', JSON.stringify({
        type: 'fs:mkdir',
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        parentPath: '/home/user',
        folderName: 'new-folder',
      }));

      await vi.waitFor(() => {
        expect(fsMkdirService.handleMkdir).toHaveBeenCalledWith('req-1', 'ctrl-1', '/home/user', 'new-folder');
      });
    });
  });

  describe('git:worktree:add command', () => {
    it('should route git:worktree:add to worktreeService.handleAdd', async () => {
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);

      const service = new SessionCommandService();
      service.start(createMockIO() as never);

      mockRedis._emitMessage('session:command', JSON.stringify({
        type: 'git:worktree:add',
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        repoPath: '/repo',
        worktreePath: '/wt',
        branch: 'feat/branch',
      }));

      await vi.waitFor(() => {
        expect(worktreeService.handleAdd).toHaveBeenCalledWith('req-1', 'ctrl-1', '/repo', '/wt', 'feat/branch');
      });
    });
  });

  describe('git:worktree:remove command', () => {
    it('should route git:worktree:remove to worktreeService.handleRemove', async () => {
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);

      const service = new SessionCommandService();
      service.start(createMockIO() as never);

      mockRedis._emitMessage('session:command', JSON.stringify({
        type: 'git:worktree:remove',
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        repoPath: '/repo',
        worktreePath: '/wt',
      }));

      await vi.waitFor(() => {
        expect(worktreeService.handleRemove).toHaveBeenCalledWith('req-1', 'ctrl-1', '/repo', '/wt');
      });
    });
  });

  describe('git:status command', () => {
    it('should route git:status to worktreeService.handleStatus', async () => {
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);

      const service = new SessionCommandService();
      service.start(createMockIO() as never);

      mockRedis._emitMessage('session:command', JSON.stringify({
        type: 'git:status',
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        path: '/wt',
      }));

      await vi.waitFor(() => {
        expect(worktreeService.handleStatus).toHaveBeenCalledWith('req-1', 'ctrl-1', '/wt');
      });
    });
  });

  describe('git:commit command', () => {
    it('should route git:commit to worktreeService.handleCommit', async () => {
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);

      const service = new SessionCommandService();
      service.start(createMockIO() as never);

      mockRedis._emitMessage('session:command', JSON.stringify({
        type: 'git:commit',
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        path: '/wt',
        message: 'chore: stash',
      }));

      await vi.waitFor(() => {
        expect(worktreeService.handleCommit).toHaveBeenCalledWith('req-1', 'ctrl-1', '/wt', 'chore: stash');
      });
    });
  });
});
