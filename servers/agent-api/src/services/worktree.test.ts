import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';

vi.mock('../models/session.js', () => ({
  Session: {
    find: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findByIdAndUpdate: vi.fn(),
    findOneAndDelete: vi.fn(),
    deleteOne: vi.fn(),
    create: vi.fn(),
    updateOne: vi.fn(),
  },
}));

vi.mock('../models/acp-message.js', () => ({
  AcpMessage: {
    find: vi.fn(),
    create: vi.fn(),
    deleteMany: vi.fn(),
    countDocuments: vi.fn(),
  },
}));

vi.mock('../models/controller.js', () => ({
  Controller: {
    findOne: vi.fn(),
    findById: vi.fn(),
  },
}));

vi.mock('../models/controller-workspace.js', () => ({
  ControllerWorkspace: {
    findOne: vi.fn(),
  },
}));

vi.mock('../models/mcp-server.js', () => ({
  McpServer: {
    countDocuments: vi.fn(),
  },
}));

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('./mcp-endpoint.js', () => ({
  mcpEndpointService: {
    createEndpoint: vi.fn(),
    revokeEndpoint: vi.fn(),
    reissueEndpoint: vi.fn(),
  },
}));

import { worktreeService } from './worktree.js';
import { sessionService } from './session.js';
import { Session } from '../models/session.js';
import { Controller } from '../models/controller.js';
import { ControllerWorkspace } from '../models/controller-workspace.js';
import { getRedisClient } from '../middleware/redis.js';

const mockRedis = {
  set: vi.fn(),
  del: vi.fn(),
  get: vi.fn(),
  publish: vi.fn(),
};

function oid(id: string) {
  return { toString: () => id } as import('mongoose').Types.ObjectId;
}

function mockSessionDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: oid('sess-1'),
    userId: oid('user-1'),
    controllerId: oid('ctrl-1'),
    controllerName: 'dev-machine',
    acpServerType: 'opencode',
    status: 'running',
    externalSessionId: null,
    cwd: '/worktrees/my-project/feat-1',
    worktreePath: '/worktrees/my-project/feat-1',
    worktreeBranch: 'my-project/feat-1',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    endedAt: null,
    ...overrides,
  };
}

function mockWorkspace() {
  vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
    lean: vi.fn().mockResolvedValue({ _id: oid('ws-1'), name: 'my-project', path: '/home/user/project' }),
  } as never);
}

function mockControllerOffline() {
  vi.mocked(Controller.findById).mockReturnValue({
    lean: vi.fn().mockResolvedValue({ status: 'offline', worktreeDir: '/worktrees' }),
  } as never);
}

function mockSessionFind(docs: unknown[]) {
  vi.mocked(Session.find).mockReturnValue({
    lean: vi.fn().mockResolvedValue(docs),
  } as never);
}

describe('WorktreeService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
    mockRedis.publish.mockResolvedValue(1);
  });

  describe('list', () => {
    it('should map sessions with ISO date strings (no raw Date objects)', async () => {
      mockWorkspace();
      mockControllerOffline();
      mockSessionFind([mockSessionDoc()]);

      const result = await worktreeService.list('ctrl-1', 'ws-1', 'user-1');

      expect(result).toHaveLength(1);
      expect(result[0].sessions).toHaveLength(1);
      const s = result[0].sessions[0] as Record<string, unknown>;
      expect(s.id).toBe('sess-1');
      expect(typeof s.createdAt).toBe('string');
      expect(typeof s.updatedAt).toBe('string');
      expect(s.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(s.updatedAt).toBe('2026-01-02T00:00:00.000Z');
    });

    it('should exclude ended sessions from grouping', async () => {
      mockWorkspace();
      mockControllerOffline();
      mockSessionFind([]);

      await worktreeService.list('ctrl-1', 'ws-1', 'user-1');

      expect(Session.find).toHaveBeenCalledWith(expect.objectContaining({
        status: { $ne: 'ended' },
      }));
    });

    it('should exclude sessions whose worktree path belongs to another workspace', async () => {
      mockWorkspace();
      mockControllerOffline();
      mockSessionFind([
        mockSessionDoc({ _id: oid('sess-mine'), worktreePath: '/worktrees/my-project/feat-1' }),
        mockSessionDoc({ _id: oid('sess-other'), worktreePath: '/worktrees/other-project/feat-9' }),
      ]);

      const result = await worktreeService.list('ctrl-1', 'ws-1', 'user-1');

      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('/worktrees/my-project/feat-1');
      expect(result[0].sessionCount).toBe(1);
      expect((result[0].sessions[0] as Record<string, unknown>).id).toBe('sess-mine');
    });

    it('should include sessions on controller-reported git worktree paths even outside the worktreeDir prefix', async () => {
      mockWorkspace();
      vi.mocked(Controller.findById).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ status: 'online', worktreeDir: '/worktrees' }),
      } as never);
      mockRedis.get.mockImplementation(async (key: string) => {
        if (key.startsWith('git:worktree:list:')) {
          return JSON.stringify({ success: true, worktrees: [{ path: '/elsewhere/repo-copy', branch: 'feat-x' }] });
        }
        return null;
      });
      mockSessionFind([
        mockSessionDoc({ _id: oid('sess-git'), worktreePath: '/elsewhere/repo-copy' }),
        mockSessionDoc({ _id: oid('sess-other'), worktreePath: '/worktrees/other-project/feat-9' }),
      ]);

      const result = await worktreeService.list('ctrl-1', 'ws-1', 'user-1');

      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('/elsewhere/repo-copy');
      expect(result[0].branch).toBe('feat-x');
      expect(result[0].sessionCount).toBe(1);
    });
  });

  describe('deleteWorktree', () => {
    function mockControllerOnlineWithWorktrees(paths: string[]) {
      vi.mocked(Controller.findById).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ status: 'online', worktreeDir: '/worktrees' }),
      } as never);
      mockRedis.get.mockImplementation(async (key: string) => {
        if (key.startsWith('git:worktree:list:')) {
          return JSON.stringify({ success: true, worktrees: paths.map((p) => ({ path: p, branch: 'b' })) });
        }
        return null;
      });
    }

    it('should reject a worktreePath outside the workspace worktree scope with BAD_USER_INPUT', async () => {
      mockWorkspace();
      mockControllerOnlineWithWorktrees(['/worktrees/my-project/feat-1']);
      mockSessionFind([]);

      const err = await worktreeService
        .deleteWorktree('ctrl-1', 'ws-1', '/home/user/Documents', 'user-1')
        .catch((e) => e);

      expect(err).toBeInstanceOf(GraphQLError);
      expect((err as GraphQLError).extensions.code).toBe('BAD_USER_INPUT');
      expect(mockRedis.publish).not.toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"git:worktree:remove"'),
      );
      expect(mockRedis.publish).not.toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"fs:remove-dir"'),
      );
    });

    it('should clear removeError and report success when fs fallback removes the directory', async () => {
      mockWorkspace();
      mockControllerOnlineWithWorktrees(['/worktrees/my-project/feat-1']);
      mockRedis.get.mockImplementation(async (key: string) => {
        if (key.startsWith('git:worktree:list:')) {
          return JSON.stringify({ success: true, worktrees: [{ path: '/worktrees/my-project/feat-1', branch: 'b' }] });
        }
        if (key.startsWith('git:worktree:remove:')) {
          return JSON.stringify({ success: false, error: 'branch is checked out' });
        }
        if (key.startsWith('fs:remove-dir:')) {
          return JSON.stringify({ success: true });
        }
        return null;
      });
      mockSessionFind([]);

      const result = await worktreeService.deleteWorktree('ctrl-1', 'ws-1', '/worktrees/my-project/feat-1', 'user-1');

      expect(result.success).toBe(true);
      expect(result.error).toBeNull();
    });

    it('should report failure when both git remove and fs fallback fail', async () => {
      mockWorkspace();
      mockControllerOnlineWithWorktrees(['/worktrees/my-project/feat-1']);
      mockRedis.get.mockImplementation(async (key: string) => {
        if (key.startsWith('git:worktree:list:')) {
          return JSON.stringify({ success: true, worktrees: [{ path: '/worktrees/my-project/feat-1', branch: 'b' }] });
        }
        if (key.startsWith('git:worktree:remove:')) {
          return JSON.stringify({ success: false, error: 'branch is checked out' });
        }
        if (key.startsWith('fs:remove-dir:')) {
          return JSON.stringify({ success: false, error: 'permission denied' });
        }
        return null;
      });
      mockSessionFind([]);

      const result = await worktreeService.deleteWorktree('ctrl-1', 'ws-1', '/worktrees/my-project/feat-1', 'user-1');

      expect(result.success).toBe(false);
      expect(result.error).not.toBeNull();
    });

    it('should terminate sessions at the worktree path before removal', async () => {
      mockWorkspace();
      mockControllerOnlineWithWorktrees(['/worktrees/my-project/feat-1']);
      mockRedis.get.mockImplementation(async (key: string) => {
        if (key.startsWith('git:worktree:list:')) {
          return JSON.stringify({ success: true, worktrees: [{ path: '/worktrees/my-project/feat-1', branch: 'b' }] });
        }
        if (key.startsWith('git:worktree:remove:')) {
          return JSON.stringify({ success: true });
        }
        return null;
      });
      mockSessionFind([mockSessionDoc()]);
      const deleteSpy = vi.spyOn(sessionService, 'delete').mockResolvedValue(true);

      const result = await worktreeService.deleteWorktree('ctrl-1', 'ws-1', '/worktrees/my-project/feat-1', 'user-1');

      expect(deleteSpy).toHaveBeenCalledWith('sess-1', 'user-1');
      expect(result.closedSessionIds).toEqual(['sess-1']);
      expect(result.success).toBe(true);
      deleteSpy.mockRestore();
    });
  });
});
