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
    startSession: vi.fn().mockResolvedValue({ success: true }),
    cancelGeneration: vi.fn(),
    stopSession: vi.fn(),
    setConfigOption: vi.fn(),
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
    deleteHistorySession: vi.fn(),
    cacheDeleteResult: vi.fn(),
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
import { acpSessionSyncService } from './acp-session-sync.js';
import { Controller } from '../models/controller.js';
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
  describe('acp:start command', () => {
    beforeEach(() => {
      const mockController = {
        _id: 'ctrl-1',
        keyId: { toString: () => 'key-1' },
        userId: { toString: () => 'user-1' },
      };
      vi.mocked(Controller.findById).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockController),
      } as never);
    });

    it('should pass mcpEndpoint through to acpSessionManager.startSession', async () => {
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      const { sessionService } = await import('./session.js');
      vi.mocked(sessionService.getSocketId).mockResolvedValue('socket-1');

      const io = createMockIO();
      const socket = { id: 'socket-1', emit: vi.fn() };
      io.sockets.sockets.set('socket-1', socket as never);

      const service = new SessionCommandService();
      service.start(io as never);

      const mcpEndpoint = { url: 'http://gateway/mcp/sess-1', token: 'tok', serverNames: ['github-mcp'] };
      mockRedis._emitMessage('session:command', JSON.stringify({
        type: 'acp:start',
        sessionId: 'sess-1',
        controllerId: 'ctrl-1',
        serverType: 'opencode',
        cwd: '/home/user',
        mcpEndpoint,
      }));

      await vi.waitFor(() => {
        expect(acpSessionManager.startSession).toHaveBeenCalledWith(
          socket,
          'sess-1',
          'ctrl-1',
          'user-1',
          'opencode',
          '/home/user',
          mcpEndpoint,
          undefined,
        );
      });
    });

    it('should pass modeId/modelId through to acpSessionManager.startSession', async () => {
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      const { sessionService } = await import('./session.js');
      vi.mocked(sessionService.getSocketId).mockResolvedValue('socket-1');

      const io = createMockIO();
      const socket = { id: 'socket-1', emit: vi.fn() };
      io.sockets.sockets.set('socket-1', socket as never);

      const service = new SessionCommandService();
      service.start(io as never);

      mockRedis._emitMessage('session:command', JSON.stringify({
        type: 'acp:start',
        sessionId: 'sess-1',
        controllerId: 'ctrl-1',
        serverType: 'opencode',
        cwd: '/home/user',
        modeId: 'code',
        modelId: 'gpt-5',
      }));

      await vi.waitFor(() => {
        expect(acpSessionManager.startSession).toHaveBeenCalledWith(
          socket,
          'sess-1',
          'ctrl-1',
          'user-1',
          'opencode',
          '/home/user',
          undefined,
          { modeId: 'code', modelId: 'gpt-5' },
        );
      });
    });

    it('should call startSession without mcpEndpoint when absent', async () => {
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      const { sessionService } = await import('./session.js');
      vi.mocked(sessionService.getSocketId).mockResolvedValue('socket-1');

      const io = createMockIO();
      const socket = { id: 'socket-1', emit: vi.fn() };
      io.sockets.sockets.set('socket-1', socket as never);

      const service = new SessionCommandService();
      service.start(io as never);

      mockRedis._emitMessage('session:command', JSON.stringify({
        type: 'acp:start',
        sessionId: 'sess-1',
        controllerId: 'ctrl-1',
        serverType: 'opencode',
        cwd: '/home/user',
      }));

      await vi.waitFor(() => {
        expect(acpSessionManager.startSession).toHaveBeenCalledWith(
          socket,
          'sess-1',
          'ctrl-1',
          'user-1',
          'opencode',
          '/home/user',
          undefined,
          undefined,
        );
      });
    });
  });

  describe('acp:start / acp:stop 同会话串行化', () => {
    beforeEach(() => {
      const mockController = {
        _id: 'ctrl-1',
        keyId: { toString: () => 'key-1' },
        userId: { toString: () => 'user-1' },
      };
      vi.mocked(Controller.findById).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockController),
      } as never);
    });

    it('acp:stop 必须等待同会话在途的 acp:start 处理完成后才调用 stopSession', async () => {
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      const { sessionService } = await import('./session.js');
      vi.mocked(sessionService.getSocketId).mockResolvedValue('socket-1');

      const io = createMockIO();
      const socket = { id: 'socket-1', emit: vi.fn() };
      io.sockets.sockets.set('socket-1', socket as never);

      // start 挂起，模拟 harness 慢启动
      let resolveStart!: (value: { success: boolean }) => void;
      vi.mocked(acpSessionManager.startSession).mockReturnValue(
        new Promise((resolve) => { resolveStart = resolve; }),
      );

      const service = new SessionCommandService();
      service.start(io as never);

      mockRedis._emitMessage('session:command', JSON.stringify({
        type: 'acp:start',
        sessionId: 'sess-1',
        controllerId: 'ctrl-1',
        serverType: 'opencode',
        cwd: '/home/user',
      }));
      await vi.waitFor(() => {
        expect(acpSessionManager.startSession).toHaveBeenCalled();
      });

      // start 未结算时 stop 到达：不得立即调用 stopSession
      // （否则 manager 内 sessions Map 未命中，stop 被吞，进程泄漏）
      mockRedis._emitMessage('session:command', JSON.stringify({
        type: 'acp:stop',
        sessionId: 'sess-1',
        reason: 'user_delete',
      }));
      await new Promise((r) => setTimeout(r, 50));
      expect(acpSessionManager.stopSession).not.toHaveBeenCalled();

      // start 结算后，stop 按序执行
      resolveStart({ success: true });
      await vi.waitFor(() => {
        expect(acpSessionManager.stopSession).toHaveBeenCalledWith('sess-1', 'user_delete');
      });
    });
  });

  describe('acp:list-sessions command', () => {
    beforeEach(() => {
      const mockController = {
        _id: 'ctrl-1',
        keyId: { toString: () => 'key-1' },
        userId: { toString: () => 'user-1' },
      };
      vi.mocked(Controller.findById).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockController),
      } as never);
    });

    it('should pass serverType from Redis command to acpSessionSyncService', async () => {
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      vi.mocked(acpSessionSyncService.listSessions).mockResolvedValue({ success: true, sessions: [] });
      const { sessionService } = await import('./session.js');
      vi.mocked(sessionService.getSocketId).mockResolvedValue('socket-1');

      const io = createMockIO();
      io.sockets.sockets.set('socket-1', { id: 'socket-1', emit: vi.fn() } as never);

      const service = new SessionCommandService();
      service.start(io as never);

      mockRedis._emitMessage('session:command', JSON.stringify({
        type: 'acp:list-sessions',
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        serverType: 'claude_code',
        cwd: '/home/user',
      }));

      await vi.waitFor(() => {
        expect(acpSessionSyncService.listSessions).toHaveBeenCalledWith(
          expect.anything(),
          'claude_code',
          '/home/user',
        );
      });
    });

    it('should default to opencode when serverType not provided', async () => {
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      vi.mocked(acpSessionSyncService.listSessions).mockResolvedValue({ success: true, sessions: [] });
      const { sessionService } = await import('./session.js');
      vi.mocked(sessionService.getSocketId).mockResolvedValue('socket-1');

      const io = createMockIO();
      io.sockets.sockets.set('socket-1', { id: 'socket-1', emit: vi.fn() } as never);

      const service = new SessionCommandService();
      service.start(io as never);

      mockRedis._emitMessage('session:command', JSON.stringify({
        type: 'acp:list-sessions',
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        cwd: '/home/user',
      }));

      await vi.waitFor(() => {
        expect(acpSessionSyncService.listSessions).toHaveBeenCalledWith(
          expect.anything(),
          'opencode',
          '/home/user',
        );
      });
    });
  });

  describe('acp:delete-history-session command', () => {
    beforeEach(() => {
      const mockController = {
        _id: 'ctrl-1',
        keyId: { toString: () => 'key-1' },
        userId: { toString: () => 'user-1' },
      };
      vi.mocked(Controller.findById).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockController),
      } as never);
    });

    it('should forward delete-history-session command to acpSessionSyncService', async () => {
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      vi.mocked(acpSessionSyncService.deleteHistorySession).mockResolvedValue({ success: true, supported: true });
      const { sessionService } = await import('./session.js');
      vi.mocked(sessionService.getSocketId).mockResolvedValue('socket-1');

      const io = createMockIO();
      io.sockets.sockets.set('socket-1', { id: 'socket-1', emit: vi.fn() } as never);

      const service = new SessionCommandService();
      service.start(io as never);

      mockRedis._emitMessage('session:command', JSON.stringify({
        type: 'acp:delete-history-session',
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        sessionId: 'db-id-1',
        externalSessionId: 'ext-1',
        serverType: 'claude_code',
        cwd: '/home/user',
      }));

      await vi.waitFor(() => {
        expect(acpSessionSyncService.deleteHistorySession).toHaveBeenCalledWith(
          expect.anything(),
          'claude_code',
          'db-id-1',
          'ext-1',
          '/home/user',
        );
        expect(acpSessionSyncService.cacheDeleteResult).toHaveBeenCalledWith('req-1', { success: true, supported: true });
      });
    });

    it('should cache failure result when controller not found', async () => {
      vi.mocked(Controller.findById).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);

      const service = new SessionCommandService();
      service.start(createMockIO() as never);

      mockRedis._emitMessage('session:command', JSON.stringify({
        type: 'acp:delete-history-session',
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        sessionId: 'db-id-1',
        externalSessionId: 'ext-1',
        cwd: '/home/user',
      }));

      await vi.waitFor(() => {
        expect(acpSessionSyncService.cacheDeleteResult).toHaveBeenCalledWith('req-1', {
          success: false,
          supported: false,
          error: 'Controller not found',
        });
      });
      expect(acpSessionSyncService.deleteHistorySession).not.toHaveBeenCalled();
    });

    it('should cache failure result when controller offline', async () => {
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      const { sessionService } = await import('./session.js');
      vi.mocked(sessionService.getSocketId).mockResolvedValue(null);

      const service = new SessionCommandService();
      service.start(createMockIO() as never);

      mockRedis._emitMessage('session:command', JSON.stringify({
        type: 'acp:delete-history-session',
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        sessionId: 'db-id-1',
        externalSessionId: 'ext-1',
        cwd: '/home/user',
      }));

      await vi.waitFor(() => {
        expect(acpSessionSyncService.cacheDeleteResult).toHaveBeenCalledWith('req-1', {
          success: false,
          supported: false,
          error: 'Controller offline',
        });
      });
      expect(acpSessionSyncService.deleteHistorySession).not.toHaveBeenCalled();
    });

    it('should cache failure result when controller socket missing', async () => {
      const mockRedis = createMockRedis();
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      const { sessionService } = await import('./session.js');
      vi.mocked(sessionService.getSocketId).mockResolvedValue('socket-1');

      const service = new SessionCommandService();
      service.start(createMockIO() as never);

      mockRedis._emitMessage('session:command', JSON.stringify({
        type: 'acp:delete-history-session',
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        sessionId: 'db-id-1',
        externalSessionId: 'ext-1',
        cwd: '/home/user',
      }));

      await vi.waitFor(() => {
        expect(acpSessionSyncService.cacheDeleteResult).toHaveBeenCalledWith('req-1', {
          success: false,
          supported: false,
          error: 'Controller socket not found',
        });
      });
      expect(acpSessionSyncService.deleteHistorySession).not.toHaveBeenCalled();
    });
  });

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
        expect(worktreeService.handleRemove).toHaveBeenCalledWith('req-1', 'ctrl-1', '/repo', '/wt', false);
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
