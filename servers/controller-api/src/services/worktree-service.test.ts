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

import { WorktreeService } from './worktree-service.js';
import { getRedisClient } from '../middleware/redis.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';

function createMockSocket() {
  return { emit: vi.fn() };
}

function createMockIO() {
  return {
    sockets: {
      sockets: new Map<string, ReturnType<typeof createMockSocket>>(),
    },
  };
}

describe('WorktreeService', () => {
  let mockSocket: ReturnType<typeof createMockSocket>;
  let mockIO: ReturnType<typeof createMockIO>;
  let mockRedisClient: { set: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    mockSocket = createMockSocket();
    mockIO = createMockIO();
    mockIO.sockets.sockets.set('socket-123', mockSocket);

    mockRedisClient = {
      set: vi.fn().mockResolvedValue('OK'),
    };
    vi.mocked(getRedisClient).mockReturnValue(mockRedisClient as never);
    vi.mocked(Controller.findById).mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'ctrl-1',
        keyId: { toString: () => 'key-1' },
      }),
    } as never);
    vi.mocked(sessionService.getSocketId).mockResolvedValue('socket-123');
  });

  describe('start', () => {
    it('should store IO reference', () => {
      const service = new WorktreeService();
      service.start(mockIO as never);
      expect((service as any).io).toBe(mockIO);
    });
  });

  describe('handleAdd', () => {
    it('should emit git:worktree:add to controller socket', async () => {
      const service = new WorktreeService();
      service.start(mockIO as never);

      await service.handleAdd('req-1', 'ctrl-1', '/repo', '/wt', 'feat/branch');

      expect(mockSocket.emit).toHaveBeenCalledWith('git:worktree:add', {
        requestId: 'req-1',
        repoPath: '/repo',
        worktreePath: '/wt',
        branch: 'feat/branch',
      });
    });

    it('should pass committer through to controller socket', async () => {
      const service = new WorktreeService();
      service.start(mockIO as never);

      const committer = { name: 'Deliay', email: 'admin@remiliascarlet.com' };
      await service.handleAdd('req-1', 'ctrl-1', '/repo', '/wt', 'feat/branch', committer);

      expect(mockSocket.emit).toHaveBeenCalledWith('git:worktree:add', {
        requestId: 'req-1',
        repoPath: '/repo',
        worktreePath: '/wt',
        branch: 'feat/branch',
        committer,
      });
    });

    it('T-CB-C2: should pass committer co-author fields through to controller socket', async () => {
      const service = new WorktreeService();
      service.start(mockIO as never);

      const committer = {
        name: 'Deliay',
        email: 'admin@remiliascarlet.com',
        coAuthorName: 'zag-bot[bot]',
        coAuthorEmail: '123456+zag-bot[bot]@users.noreply.github.com',
      };
      await service.handleAdd('req-1', 'ctrl-1', '/repo', '/wt', 'feat/branch', committer);

      expect(mockSocket.emit).toHaveBeenCalledWith('git:worktree:add', {
        requestId: 'req-1',
        repoPath: '/repo',
        worktreePath: '/wt',
        branch: 'feat/branch',
        committer,
      });
    });

    it('should omit committer key when committer is undefined', async () => {
      const service = new WorktreeService();
      service.start(mockIO as never);

      await service.handleAdd('req-1', 'ctrl-1', '/repo', '/wt', 'feat/branch', undefined);

      const payload = vi.mocked(mockSocket.emit).mock.calls[0][1] as Record<string, unknown>;
      expect(payload).not.toHaveProperty('committer');
    });
  });

  describe('handleRemove', () => {
    it('should emit git:worktree:remove to controller socket', async () => {
      const service = new WorktreeService();
      service.start(mockIO as never);

      await service.handleRemove('req-1', 'ctrl-1', '/repo', '/wt');

      expect(mockSocket.emit).toHaveBeenCalledWith('git:worktree:remove', {
        requestId: 'req-1',
        repoPath: '/repo',
        worktreePath: '/wt',
      });
    });
  });

  describe('handleStatus', () => {
    it('should emit git:status to controller socket', async () => {
      const service = new WorktreeService();
      service.start(mockIO as never);

      await service.handleStatus('req-1', 'ctrl-1', '/wt');

      expect(mockSocket.emit).toHaveBeenCalledWith('git:status', {
        requestId: 'req-1',
        path: '/wt',
      });
    });
  });

  describe('handleCommit', () => {
    it('should emit git:commit to controller socket', async () => {
      const service = new WorktreeService();
      service.start(mockIO as never);

      await service.handleCommit('req-1', 'ctrl-1', '/wt', 'feat: msg');

      expect(mockSocket.emit).toHaveBeenCalledWith('git:commit', {
        requestId: 'req-1',
        path: '/wt',
        message: 'feat: msg',
      });
    });
  });

  describe('handleAddResult', () => {
    it('should store result in Redis with TTL 60', async () => {
      const service = new WorktreeService();
      const result = { success: true, worktreePath: '/wt', branch: 'feat' };

      await service.handleAddResult('req-1', result);

      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'git:worktree:add:req-1',
        JSON.stringify(result),
        'EX',
        60,
      );
    });
  });

  describe('handleRemoveResult', () => {
    it('should store result in Redis with TTL 60', async () => {
      const service = new WorktreeService();
      await service.handleRemoveResult('req-1', { success: true });
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'git:worktree:remove:req-1',
        JSON.stringify({ success: true }),
        'EX',
        60,
      );
    });
  });

  describe('handleStatusResult', () => {
    it('should store result in Redis with TTL 60', async () => {
      const service = new WorktreeService();
      await service.handleStatusResult('req-1', { isClean: true });
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'git:status:req-1',
        JSON.stringify({ isClean: true }),
        'EX',
        60,
      );
    });
  });

  describe('handleCommitResult', () => {
    it('should store result in Redis with TTL 60', async () => {
      const service = new WorktreeService();
      await service.handleCommitResult('req-1', { success: true, commitHash: 'abc' });
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'git:commit:req-1',
        JSON.stringify({ success: true, commitHash: 'abc' }),
        'EX',
        60,
      );
    });
  });
});