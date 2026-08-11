import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/session.js', () => ({
  Session: {
    find: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findByIdAndUpdate: vi.fn(),
    findOneAndDelete: vi.fn(),
    create: vi.fn(),
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

import { sessionService } from './session.js';
import { Session } from '../models/session.js';
import { AcpMessage } from '../models/acp-message.js';
import { Controller } from '../models/controller.js';
import { ControllerWorkspace } from '../models/controller-workspace.js';
import { McpServer } from '../models/mcp-server.js';
import { getRedisClient } from '../middleware/redis.js';
import { mcpEndpointService } from './mcp-endpoint.js';

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
    status: 'creating',
    externalSessionId: null,
    cwd: '/home/user/project',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    endedAt: null,
    toObject() { return { ...this }; },
    ...overrides,
  };
}

function mockMessageDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: oid('msg-1'),
    sessionId: oid('sess-1'),
    direction: 'input',
    type: 'text',
    content: 'Hello',
    metadata: null,
    createdAt: new Date('2026-01-01'),
    toObject() { return { ...this }; },
    ...overrides,
  };
}

describe('SessionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
  });

  describe('findAllByUser', () => {
    it('should return mapped sessions for user', async () => {
      const docs = [mockSessionDoc(), mockSessionDoc({ _id: oid('sess-2') })];
      vi.mocked(Session.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(docs),
        }),
      } as never);

      const result = await sessionService.findAllByUser('user-1');

      expect(Session.find).toHaveBeenCalledWith({ userId: 'user-1', workflowInstanceId: null });
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('sess-1');
    });

    it('should return empty array when no sessions', async () => {
      vi.mocked(Session.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      } as never);

      const result = await sessionService.findAllByUser('user-1');
      expect(result).toEqual([]);
    });
  });

  describe('findById', () => {
    it('should return mapped session when found', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc()),
      } as never);

      const result = await sessionService.findById('sess-1', 'user-1');

      expect(Session.findOne).toHaveBeenCalledWith({ _id: 'sess-1', userId: 'user-1' });
      expect(result).not.toBeNull();
      expect(result!.id).toBe('sess-1');
      expect(result!.controllerName).toBe('dev-machine');
    });

    it('should return null when not found', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      const result = await sessionService.findById('sess-1', 'user-1');
      expect(result).toBeNull();
    });

    it('should null out authMethod kind values outside the enum', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({
          authMethods: [
            { id: 'a', kind: 'env_var', description: 'token' },
            { id: 'b', kind: 'oauth' },
            { id: 'c', kind: null },
            { id: 'd' },
          ],
        })),
      } as never);

      const result = await sessionService.findById('sess-1', 'user-1');

      const authMethods = result!.authMethods as Array<Record<string, unknown>>;
      expect(authMethods).toHaveLength(4);
      expect(authMethods[0].kind).toBe('env_var');
      expect(authMethods[1].kind).toBeNull();
      expect(authMethods[2].kind).toBeNull();
      expect(authMethods[3].kind).toBeNull();
    });

    it('should default authMethods to empty array when missing', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc()),
      } as never);

      const result = await sessionService.findById('sess-1', 'user-1');
      expect(result!.authMethods).toEqual([]);
    });
  });

  describe('create', () => {
    it('should create session with controller name and workspace path', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'my-server' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(Session.create).mockResolvedValue(mockSessionDoc({ controllerName: 'my-server' }) as never);

      const result = await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
      });

      expect(Controller.findOne).toHaveBeenCalledWith({ _id: 'ctrl-1', userId: 'user-1' });
      expect(ControllerWorkspace.findOne).toHaveBeenCalledWith({ _id: 'ws-1', userId: 'user-1', controllerId: 'ctrl-1' });
      expect(Session.create).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user-1',
        controllerId: 'ctrl-1',
        controllerName: 'my-server',
        acpServerType: 'opencode',
        status: 'creating',
        cwd: '/home/user/project',
      }));
      expect(result.id).toBe('sess-1');
    });

    it('should throw when controller not found', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
      })).rejects.toThrow('Controller not found');
    });

    it('should throw when workspace not found', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'my-server' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
      })).rejects.toThrow('Workspace not found');
    });

    it('should create session with worktree when enableWorktree is true', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'my-server', worktreeDir: '/worktrees' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project', name: 'my-project' }),
      } as never);

      mockRedis.publish.mockResolvedValue(1);
      mockRedis.get
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify({ success: true, worktreePath: '/worktrees/my-project/feat-123', branch: 'my-project/feat-123' }));

      vi.mocked(Session.create).mockResolvedValue(mockSessionDoc({
        controllerName: 'my-server',
        cwd: '/worktrees/my-project/feat-123',
        worktreePath: '/worktrees/my-project/feat-123',
        worktreeBranch: 'my-project/feat-123',
      }) as never);

      const result = await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        enableWorktree: true,
        worktreeBranchSuffix: 'feat-123',
      });

      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"git:worktree:add"'),
      );
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"acp:start"'),
      );
      expect(Session.create).toHaveBeenCalledWith(expect.objectContaining({
        worktreePath: '/worktrees/my-project/feat-123',
        worktreeBranch: 'my-project/feat-123',
      }));
      expect(result.cwd).toBe('/worktrees/my-project/feat-123');
    });

    it('should throw on worktree add failure', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'my-server' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project', name: 'my-project' }),
      } as never);

      mockRedis.publish.mockResolvedValue(1);
      mockRedis.get
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify({ success: false, error: 'branch already exists' }));

      await expect(sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        enableWorktree: true,
        worktreeBranchSuffix: 'feat-123',
      })).rejects.toThrow('WORKTREE_ADD_FAILED');
    });

    it('should throw timeout when no worktree add result', async () => {
      vi.useFakeTimers();

      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'my-server' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project', name: 'my-project' }),
      } as never);

      mockRedis.publish.mockResolvedValue(1);
      mockRedis.get.mockResolvedValue(null); // never returns result

      const promise = sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        enableWorktree: true,
        worktreeBranchSuffix: 'feat-123',
      });
      promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(31000);

      await expect(promise).rejects.toThrow('WORKTREE_ADD_FAILED: Timeout');

      vi.useRealTimers();
    });

    it('should include modeId/modelId in acp:start command when provided', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'my-server' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(Session.create).mockResolvedValue(mockSessionDoc() as never);

      await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        modeId: 'code',
        modelId: 'gpt-5',
      });

      const startCall = mockRedis.publish.mock.calls.find((c) => String(c[1]).includes('"type":"acp:start"'));
      expect(startCall).toBeDefined();
      expect(String(startCall?.[1])).toContain('"modeId":"code"');
      expect(String(startCall?.[1])).toContain('"modelId":"gpt-5"');
    });

    it('should omit modeId/modelId from acp:start command when absent', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'my-server' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(Session.create).mockResolvedValue(mockSessionDoc() as never);

      await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
      });

      const startCall = mockRedis.publish.mock.calls.find((c) => String(c[1]).includes('"type":"acp:start"'));
      expect(String(startCall?.[1])).not.toContain('modeId');
      expect(String(startCall?.[1])).not.toContain('modelId');
    });

    it('should issue MCP endpoint and include it in acp:start when mcpServerIds provided', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'my-server' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(Session.create).mockResolvedValue(mockSessionDoc() as never);
      vi.mocked(McpServer.countDocuments).mockResolvedValue(1 as never);
      vi.mocked(mcpEndpointService.createEndpoint).mockResolvedValue({
        url: 'http://gateway/mcp/sess-1',
        token: 'mcp-token',
        serverNames: ['fluentui-mcp'],
      });

      await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        mcpServerIds: ['server-1'],
      });

      expect(mcpEndpointService.createEndpoint).toHaveBeenCalledWith('sess-1', 'user-1', ['server-1'], undefined);
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"acp:start"'),
      );
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"mcpEndpoint":{"url":"http://gateway/mcp/sess-1","token":"mcp-token","serverNames":["fluentui-mcp"]}'),
      );
    });

    it('should not issue MCP endpoint when mcpServerIds is empty', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'my-server' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(Session.create).mockResolvedValue(mockSessionDoc() as never);

      await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
      });

      expect(mcpEndpointService.createEndpoint).not.toHaveBeenCalled();
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"acp:start"'),
      );
      const startCall = mockRedis.publish.mock.calls.find((c) => String(c[1]).includes('"type":"acp:start"'));
      expect(String(startCall?.[1])).not.toContain('mcpEndpoint');
    });

    it('should continue session creation when MCP endpoint issuance fails', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'my-server' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(Session.create).mockResolvedValue(mockSessionDoc() as never);
      vi.mocked(McpServer.countDocuments).mockResolvedValue(1 as never);
      vi.mocked(mcpEndpointService.createEndpoint).mockRejectedValue(new Error('SERVER_NOT_FOUND'));

      const result = await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        mcpServerIds: ['server-1'],
      });

      expect(result.id).toBe('sess-1');
    });

    it('should fail session creation when selected MCP servers are invalid or disabled', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'my-server' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      // Only 1 of the 2 requested servers is selectable
      vi.mocked(McpServer.countDocuments).mockResolvedValue(1 as never);

      await expect(
        sessionService.create('user-1', {
          controllerId: 'ctrl-1',
          acpServerType: 'opencode',
          workspaceId: 'ws-1',
          mcpServerIds: ['server-1', 'server-2'],
        }),
      ).rejects.toThrow('MCP_SERVER_NOT_FOUND');

      expect(Session.create).not.toHaveBeenCalled();
      expect(mcpEndpointService.createEndpoint).not.toHaveBeenCalled();
    });
  });

  describe('updateStatus', () => {
    it('should update status and set Redis cache', async () => {
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue(mockSessionDoc({ status: 'running' }) as never);

      const result = await sessionService.updateStatus('sess-1', 'user-1', 'running');

      expect(result).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith('session:sess-1:status', 'running');
    });

    it('should delete Redis cache when ended', async () => {
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue(mockSessionDoc({ status: 'ended' }) as never);

      await sessionService.updateStatus('sess-1', 'user-1', 'ended');

      expect(mockRedis.del).toHaveBeenCalledWith('session:sess-1:status');
    });

    it('should save externalSessionId when provided', async () => {
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue(mockSessionDoc() as never);

      await sessionService.updateStatus('sess-1', 'user-1', 'running', 'ext-123');

      expect(Session.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'sess-1', userId: 'user-1' },
        expect.objectContaining({ externalSessionId: 'ext-123' }),
        { new: true },
      );
    });

    it('should return false when session not found', async () => {
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue(null);

      const result = await sessionService.updateStatus('sess-1', 'user-1', 'running');
      expect(result).toBe(false);
    });
  });

  describe('close', () => {
    it('should delegate to updateStatus with ended', async () => {
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue(mockSessionDoc({ status: 'ended' }) as never);

      const result = await sessionService.close('sess-1', 'user-1');
      expect(result).toBe(true);
    });

    it('should revoke MCP endpoint on close', async () => {
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue(mockSessionDoc({ status: 'ended' }) as never);

      await sessionService.close('sess-1', 'user-1');

      expect(mcpEndpointService.revokeEndpoint).toHaveBeenCalledWith('sess-1');
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"acp:stop"'),
      );
    });
  });

  describe('delete', () => {
    it('should delete session, messages, and Redis cache', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc()),
      } as never);
      vi.mocked(Session.findOneAndDelete).mockResolvedValue(mockSessionDoc() as never);
      vi.mocked(AcpMessage.deleteMany).mockResolvedValue(undefined as never);

      const result = await sessionService.delete('sess-1', 'user-1');

      expect(result).toBe(true);
      expect(AcpMessage.deleteMany).toHaveBeenCalledWith({ sessionId: 'sess-1' });
      expect(mockRedis.del).toHaveBeenCalledWith('session:sess-1:status');
      expect(mcpEndpointService.revokeEndpoint).toHaveBeenCalledWith('sess-1');
    });

    it('should return false when session not found', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);
      vi.mocked(Session.findOneAndDelete).mockResolvedValue(null);

      const result = await sessionService.delete('sess-1', 'user-1');
      expect(result).toBe(false);
    });

    it('should clean up worktree on delete when worktreePath is set and clean', async () => {
      const sessionDoc = mockSessionDoc({ worktreePath: '/worktrees/project/branch', worktreeBranch: 'project/branch' });
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(sessionDoc),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(Session.findOneAndDelete).mockResolvedValue(mockSessionDoc() as never);
      vi.mocked(AcpMessage.deleteMany).mockResolvedValue(undefined as never);

      // Return results immediately to avoid waiting
      mockRedis.get
        .mockResolvedValueOnce(JSON.stringify({ isClean: true })) // status → clean
        .mockResolvedValueOnce(JSON.stringify({ success: true })); // remove → success

      const result = await sessionService.delete('sess-1', 'user-1');

      expect(result).toBe(true);
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"git:status"'),
      );
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"git:worktree:remove"'),
      );
    });

    it('should commit dirty worktree before removal on delete', async () => {
      const sessionDoc = mockSessionDoc({ worktreePath: '/worktrees/project/branch', worktreeBranch: 'project/branch' });
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(sessionDoc),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(Session.findOneAndDelete).mockResolvedValue(mockSessionDoc() as never);
      vi.mocked(AcpMessage.deleteMany).mockResolvedValue(undefined as never);

      mockRedis.get
        .mockResolvedValueOnce(JSON.stringify({ isClean: false })) // dirty
        .mockResolvedValueOnce(JSON.stringify({ success: true, commitHash: 'abc123' })) // commit
        .mockResolvedValueOnce(JSON.stringify({ success: true })); // remove

      const result = await sessionService.delete('sess-1', 'user-1');

      expect(result).toBe(true);
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"git:commit"'),
      );
    });

    it('should throw error when worktree removal fails', async () => {
      const sessionDoc = mockSessionDoc({ worktreePath: '/worktrees/project/branch', worktreeBranch: 'project/branch' });
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(sessionDoc),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);

      mockRedis.get
        .mockResolvedValueOnce(JSON.stringify({ isClean: true })) // clean, skip commit
        .mockResolvedValueOnce(JSON.stringify({ success: false, error: 'worktree not found' })); // remove fails

      await expect(sessionService.delete('sess-1', 'user-1')).rejects.toThrow('WORKTREE_REMOVE_FAILED');
    });

    it('should not throw error when worktree removal fails with "is not a working tree"', async () => {
      const sessionDoc = mockSessionDoc({ worktreePath: '/worktrees/project/branch', worktreeBranch: 'project/branch' });
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(sessionDoc),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(Session.findOneAndDelete).mockResolvedValue(mockSessionDoc() as never);
      vi.mocked(AcpMessage.deleteMany).mockResolvedValue(undefined as never);

      mockRedis.get
        .mockResolvedValueOnce(JSON.stringify({ isClean: true })) // clean, skip commit
        .mockResolvedValueOnce(JSON.stringify({ success: false, error: "fatal: '/path/to/worktree' is not a working tree" })); // remove fails with "is not a working tree"

      const result = await sessionService.delete('sess-1', 'user-1');
      expect(result).toBe(true);
    });
  });

  describe('getMessages', () => {
    it('should return mapped messages when no usage_update to filter', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc()),
      } as never);

      const queryLean = vi.fn().mockResolvedValue([mockMessageDoc()]);
      const queryLimitChain = { lean: queryLean };
      const querySortChain = { limit: vi.fn().mockReturnValue(queryLimitChain) };
      const queryFind = { sort: vi.fn().mockReturnValue(querySortChain) };

      vi.mocked(AcpMessage.find).mockReturnValue(queryFind as never);

      const result = await sessionService.getMessages('sess-1', 'user-1', { limit: 10 });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('msg-1');
      expect(result[0].content).toBe('Hello');
    });

    it('should throw when session not found', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(sessionService.getMessages('sess-1', 'user-1')).rejects.toThrow('Session not found');
    });

    it('should return recent 25 messages by default', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc()),
      } as never);

      const mockMessages = Array.from({ length: 25 }, (_, i) => 
        mockMessageDoc({ _id: oid(`msg-${i + 1}`) })
      );

      const queryLean = vi.fn().mockResolvedValue(mockMessages);
      const queryLimitChain = { lean: queryLean };
      const querySortChain = { limit: vi.fn().mockReturnValue(queryLimitChain) };
      const queryFind = { sort: vi.fn().mockReturnValue(querySortChain) };

      vi.mocked(AcpMessage.find).mockReturnValue(queryFind as never);

      const result = await sessionService.getMessages('sess-1', 'user-1');

      expect(AcpMessage.find).toHaveBeenCalledWith({ sessionId: 'sess-1' });
      expect(result).toHaveLength(25);
    });

    it('should return all messages when total is less than 25', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc()),
      } as never);

      const mockMessages = Array.from({ length: 10 }, (_, i) => 
        mockMessageDoc({ _id: oid(`msg-${i + 1}`) })
      );

      const queryLean = vi.fn().mockResolvedValue(mockMessages.reverse());
      const queryLimitChain = { lean: queryLean };
      const querySortChain = { limit: vi.fn().mockReturnValue(queryLimitChain) };
      const queryFind = { sort: vi.fn().mockReturnValue(querySortChain) };

      vi.mocked(AcpMessage.find).mockReturnValue(queryFind as never);

      const result = await sessionService.getMessages('sess-1', 'user-1');

      expect(result).toHaveLength(10);
    });

    it('should support before cursor for pagination', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc()),
      } as never);

      const mockMessages = Array.from({ length: 25 }, (_, i) => 
        mockMessageDoc({ _id: oid(`msg-${i + 1}`) })
      );

      const queryLean = vi.fn().mockResolvedValue(mockMessages);
      const queryLimitChain = { lean: queryLean };
      const querySortChain = { limit: vi.fn().mockReturnValue(queryLimitChain) };
      const queryFind = { sort: vi.fn().mockReturnValue(querySortChain) };

      vi.mocked(AcpMessage.find).mockReturnValue(queryFind as never);

      // 使用有效的ObjectId格式
      const beforeId = '507f1f77bcf86cd799439011';
      const result = await sessionService.getMessages('sess-1', 'user-1', { before: beforeId });

      expect(AcpMessage.find).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        _id: { $lt: expect.any(Object) },
      });
      expect(result).toHaveLength(25);
    });

    it('should clamp limit to 100 when exceeds maximum', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc()),
      } as never);

      const mockMessages = Array.from({ length: 100 }, (_, i) => 
        mockMessageDoc({ _id: oid(`msg-${i + 1}`) })
      );

      const queryLean = vi.fn().mockResolvedValue(mockMessages.reverse());
      const queryLimitChain = { lean: queryLean };
      const querySortChain = { limit: vi.fn().mockReturnValue(queryLimitChain) };
      const queryFind = { sort: vi.fn().mockReturnValue(querySortChain) };

      vi.mocked(AcpMessage.find).mockReturnValue(queryFind as never);

      const result = await sessionService.getMessages('sess-1', 'user-1', { limit: 200 });

      expect(result).toHaveLength(100);
    });

    it('should ignore invalid before cursor', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc()),
      } as never);

      const mockMessages = Array.from({ length: 25 }, (_, i) => 
        mockMessageDoc({ _id: oid(`msg-${i + 1}`) })
      );

      const queryLean = vi.fn().mockResolvedValue(mockMessages.reverse());
      const queryLimitChain = { lean: queryLean };
      const querySortChain = { limit: vi.fn().mockReturnValue(queryLimitChain) };
      const queryFind = { sort: vi.fn().mockReturnValue(querySortChain) };

      vi.mocked(AcpMessage.find).mockReturnValue(queryFind as never);

      const result = await sessionService.getMessages('sess-1', 'user-1', { before: 'invalid-id' });

      expect(AcpMessage.find).toHaveBeenCalledWith({ sessionId: 'sess-1' });
      expect(result).toHaveLength(25);
    });

    it('should return empty array for empty session', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc()),
      } as never);

      const queryLean = vi.fn().mockResolvedValue([]);
      const queryLimitChain = { lean: queryLean };
      const querySortChain = { limit: vi.fn().mockReturnValue(queryLimitChain) };
      const queryFind = { sort: vi.fn().mockReturnValue(querySortChain) };

      vi.mocked(AcpMessage.find).mockReturnValue(queryFind as never);

      const result = await sessionService.getMessages('sess-1', 'user-1');

      expect(result).toEqual([]);
    });

    it('should return messages in ascending order', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc()),
      } as never);

      const mockMessages = [
        mockMessageDoc({ _id: oid('msg-3') }),
        mockMessageDoc({ _id: oid('msg-2') }),
        mockMessageDoc({ _id: oid('msg-1') }),
      ];

      const queryLean = vi.fn().mockResolvedValue(mockMessages);
      const queryLimitChain = { lean: queryLean };
      const querySortChain = { limit: vi.fn().mockReturnValue(queryLimitChain) };
      const queryFind = { sort: vi.fn().mockReturnValue(querySortChain) };

      vi.mocked(AcpMessage.find).mockReturnValue(queryFind as never);

      const result = await sessionService.getMessages('sess-1', 'user-1');

      expect(result[0].id).toBe('msg-1');
      expect(result[1].id).toBe('msg-2');
      expect(result[2].id).toBe('msg-3');
    });
  });

  describe('addMessage', () => {
    it('should create message and publish to Redis', async () => {
      vi.mocked(AcpMessage.create).mockResolvedValue(mockMessageDoc() as never);
      vi.mocked(AcpMessage.countDocuments).mockResolvedValue(1);
      vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);

      const result = await sessionService.addMessage('sess-1', {
        direction: 'input',
        type: 'text',
        content: '{"msg":"Hello"}',
      });

      expect(AcpMessage.create).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess-1',
        direction: 'input',
        type: 'text',
        content: { msg: 'Hello' },
      }));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:message', expect.any(String));
      expect(result.content).toBe('Hello');
    });
  });

  describe('getAcpCapabilities', () => {
    it('should return cached capabilities from Redis', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'ctrl' }),
      } as never);
      vi.mocked(mockRedis.get).mockResolvedValue(JSON.stringify({
        servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
        checkedAt: new Date().toISOString(),
      }));

      const result = await sessionService.getAcpCapabilities('ctrl-1', 'user-1');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(expect.objectContaining({ type: 'opencode', available: true }));
      expect(result[0].checkedAt).toBeDefined();
      expect(typeof result[0].checkedAt).toBe('string');
    });

    it('should return empty array when no cache', async () => {
      vi.useFakeTimers();
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'ctrl' }),
      } as never);
      vi.mocked(mockRedis.get).mockResolvedValue(null);
      vi.mocked(mockRedis.publish).mockResolvedValue(1);

      const promise = sessionService.getAcpCapabilities('ctrl-1', 'user-1');
      // Advance through all polling intervals
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(500);
      }
      const result = await promise;

      expect(result).toEqual([]);
      vi.useRealTimers();
    });

    it('should throw when controller not found', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(sessionService.getAcpCapabilities('ctrl-1', 'user-1')).rejects.toThrow('Controller not found');
    });
  });

  describe('refreshAcpCapabilities', () => {
    it('should throw when controller not found', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      await expect(
        sessionService.refreshAcpCapabilities('ctrl-1', 'user-1'),
      ).rejects.toThrow('Controller not found');
    });

    it('should delete cache and publish invalidate', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'ctrl' }),
      } as never);
      vi.mocked(mockRedis.get).mockResolvedValue(JSON.stringify({
        servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
        checkedAt: new Date().toISOString(),
      }));

      const result = await sessionService.refreshAcpCapabilities('ctrl-1', 'user-1');

      expect(mockRedis.del).toHaveBeenCalledWith('acp:capability:ctrl-1');
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"acp:cache:invalidate"'),
      );
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"controllerId":"ctrl-1"'),
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('opencode');
    });

    it('should return empty array when refresh produces no data', async () => {
      vi.useFakeTimers();
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'ctrl' }),
      } as never);
      vi.mocked(mockRedis.get).mockResolvedValue(null);
      vi.mocked(mockRedis.publish).mockResolvedValue(1);

      const promise = sessionService.refreshAcpCapabilities('ctrl-1', 'user-1');
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(500);
      }
      const result = await promise;

      expect(mockRedis.del).toHaveBeenCalledWith('acp:capability:ctrl-1');
      expect(result).toEqual([]);
      vi.useRealTimers();
    });
  });

  describe('resume', () => {
    it('should return error when session not found', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      const result = await sessionService.resume('sess-1', 'user-1');

      expect(result).toEqual({ success: false, status: 'ended', error: 'Session not found' });
    });

    it('should return error when session is not ended', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'running' })),
      } as never);

      const result = await sessionService.resume('sess-1', 'user-1');

      expect(result).toEqual({ success: false, status: 'running', error: 'Session is not ended' });
    });

    it('should return error when session is creating', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'creating' })),
      } as never);

      const result = await sessionService.resume('sess-1', 'user-1');

      expect(result).toEqual({ success: false, status: 'creating', error: 'Session is not ended' });
    });

    it('should publish acp:resume and return connecting for disconnected session', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(
          mockSessionDoc({ status: 'disconnected', externalSessionId: 'ext-123' }),
        ),
      } as never);

      const result = await sessionService.resume('sess-1', 'user-1');

      expect(result).toEqual({ success: true, status: 'connecting' });
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"type":"acp:resume"'));
    });

    it('should publish acp:resume and return connecting for ended session', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(
          mockSessionDoc({ status: 'ended', externalSessionId: 'ext-123' }),
        ),
      } as never);

      const result = await sessionService.resume('sess-1', 'user-1');

      expect(result).toEqual({ success: true, status: 'connecting' });
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"type":"acp:resume"'));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"sessionId":"sess-1"'));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"externalSessionId":"ext-123"'));
    });

    it('should publish acp:resume even without externalSessionId', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(
          mockSessionDoc({ status: 'ended', externalSessionId: null }),
        ),
      } as never);

      const result = await sessionService.resume('sess-1', 'user-1');

      expect(result).toEqual({ success: true, status: 'connecting' });
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"externalSessionId":""'));
    });

    it('should reissue MCP endpoint and include in acp:resume', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(
          mockSessionDoc({ status: 'ended', externalSessionId: 'ext-123' }),
        ),
      } as never);
      vi.mocked(mcpEndpointService.reissueEndpoint).mockResolvedValue({
        url: 'http://gateway/mcp/sess-1',
        token: 'new-mcp-token',
        serverNames: ['fluentui-mcp'],
      });

      await sessionService.resume('sess-1', 'user-1');

      expect(mcpEndpointService.reissueEndpoint).toHaveBeenCalledWith('sess-1', 'user-1');
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"mcpEndpoint":{"url":"http://gateway/mcp/sess-1","token":"new-mcp-token","serverNames":["fluentui-mcp"]}'),
      );
    });

    it('should resume without mcpEndpoint when no endpoint to reissue', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(
          mockSessionDoc({ status: 'ended', externalSessionId: 'ext-123' }),
        ),
      } as never);
      vi.mocked(mcpEndpointService.reissueEndpoint).mockResolvedValue(null);

      await sessionService.resume('sess-1', 'user-1');

      expect(mcpEndpointService.reissueEndpoint).toHaveBeenCalledWith('sess-1', 'user-1');
      const resumeCall = mockRedis.publish.mock.calls.find((c) => String(c[1]).includes('"type":"acp:resume"'));
      expect(String(resumeCall?.[1])).not.toContain('mcpEndpoint');
    });
  });

  describe('setMode', () => {
    it('should return false when session not found', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      const result = await sessionService.setMode('sess-1', 'user-1', 'mode-1');

      expect(result).toBe(false);
    });

    it('should return false when session status is not idling', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'running' })),
      } as never);

      const result = await sessionService.setMode('sess-1', 'user-1', 'mode-1');

      expect(result).toBe(false);
    });

    it('should publish acp:set-mode when session is idling', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'idling' })),
      } as never);

      const result = await sessionService.setMode('sess-1', 'user-1', 'mode-1');

      expect(result).toBe(true);
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"type":"acp:set-mode"'));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"sessionId":"sess-1"'));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"modeId":"mode-1"'));
    });

    it('should return false when connecting', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'connecting' })),
      } as never);

      const result = await sessionService.setMode('sess-1', 'user-1', 'mode-1');

      expect(result).toBe(false);
    });
  });

  describe('setModel', () => {
    it('should return false when session not found', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      const result = await sessionService.setModel('sess-1', 'user-1', 'model-1');

      expect(result).toBe(false);
    });

    it('should return false when session status is not idling', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'running' })),
      } as never);

      const result = await sessionService.setModel('sess-1', 'user-1', 'model-1');

      expect(result).toBe(false);
    });

    it('should publish acp:set-model when session is idling', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'idling' })),
      } as never);

      const result = await sessionService.setModel('sess-1', 'user-1', 'model-1');

      expect(result).toBe(true);
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"type":"acp:set-model"'));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"sessionId":"sess-1"'));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"modelId":"model-1"'));
    });

    it('should return false when connecting', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'connecting' })),
      } as never);

      const result = await sessionService.setModel('sess-1', 'user-1', 'model-1');

      expect(result).toBe(false);
    });
  });

  describe('setConfigOption', () => {
    it('should return false when session not found', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);

      const result = await sessionService.setConfigOption('sess-1', 'user-1', 'model', 'model-1');

      expect(result).toBe(false);
    });

    it('should return false when session status is not idling', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'running', configOptions: [{ id: 'model' }] })),
      } as never);

      const result = await sessionService.setConfigOption('sess-1', 'user-1', 'model', 'model-1');

      expect(result).toBe(false);
    });

    it('should return false and not publish when session has empty configOptions', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'idling', configOptions: [] })),
      } as never);

      const result = await sessionService.setConfigOption('sess-1', 'user-1', 'model', 'model-1');

      expect(result).toBe(false);
      expect(mockRedis.publish).not.toHaveBeenCalled();
    });

    it('should return false and not publish when session has no configOptions field', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'idling' })),
      } as never);

      const result = await sessionService.setConfigOption('sess-1', 'user-1', 'model', 'model-1');

      expect(result).toBe(false);
      expect(mockRedis.publish).not.toHaveBeenCalled();
    });

    it('should publish acp:set-config-option when session is idling with configOptions', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'idling', configOptions: [{ id: 'model' }] })),
      } as never);

      const result = await sessionService.setConfigOption('sess-1', 'user-1', 'model', 'model-1');

      expect(result).toBe(true);
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"type":"acp:set-config-option"'));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"sessionId":"sess-1"'));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"configId":"model"'));
      expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"value":"model-1"'));
    });
  });

  describe('workflow tagging', () => {
    it('create should persist workflowInstanceId/workflowNodeId when provided', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'my-server' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(Session.create).mockResolvedValue(
        mockSessionDoc({ workflowInstanceId: oid('inst-1'), workflowNodeId: 'node-1' }) as never,
      );

      const result = await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        workflowInstanceId: 'inst-1',
        workflowNodeId: 'node-1',
      });

      expect(Session.create).toHaveBeenCalledWith(
        expect.objectContaining({ workflowInstanceId: 'inst-1', workflowNodeId: 'node-1' }),
      );
      expect(result.workflowInstanceId).toBe('inst-1');
      expect(result.workflowNodeId).toBe('node-1');
    });

    it('create should not persist workflow fields when not provided', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'my-server' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(Session.create).mockResolvedValue(mockSessionDoc() as never);

      const result = await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
      });

      const createArg = vi.mocked(Session.create).mock.calls[0][0] as Record<string, unknown>;
      expect(createArg).not.toHaveProperty('workflowInstanceId');
      expect(createArg).not.toHaveProperty('workflowNodeId');
      expect(result.workflowInstanceId).toBeNull();
      expect(result.workflowNodeId).toBeNull();
    });

    it('create with mcpServerIds and workflow tags should pass workflow scope to createEndpoint', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'my-server' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(Session.create).mockResolvedValue(mockSessionDoc() as never);
      vi.mocked(McpServer.countDocuments).mockResolvedValue(1 as never);
      vi.mocked(mcpEndpointService.createEndpoint).mockResolvedValue({
        url: 'http://gateway/mcp/sess-1',
        token: 'mcp-token',
        serverNames: ['agent-workflow-tools'],
      });

      await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        mcpServerIds: ['server-1'],
        workflowInstanceId: 'inst-1',
        workflowNodeId: 'node-1',
      });

      expect(mcpEndpointService.createEndpoint).toHaveBeenCalledWith('sess-1', 'user-1', ['server-1'], {
        instanceId: 'inst-1',
        nodeId: 'node-1',
      });
    });

    it('findAllByUser should exclude workflow sessions by default', async () => {
      vi.mocked(Session.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
      } as never);

      await sessionService.findAllByUser('user-1');
      expect(Session.find).toHaveBeenCalledWith({ userId: 'user-1', workflowInstanceId: null });
    });

    it('findAllByUser should include workflow sessions when includeWorkflowSessions=true', async () => {
      vi.mocked(Session.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
      } as never);

      await sessionService.findAllByUser('user-1', { includeWorkflowSessions: true });
      expect(Session.find).toHaveBeenCalledWith({ userId: 'user-1' });
    });
  });

  describe('onSessionEnded callback', () => {
    it('updateStatus to ended should invoke registered callback', async () => {
      const callback = vi.fn();
      sessionService.onSessionEnded(callback);
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue(mockSessionDoc({ status: 'ended' }) as never);

      await sessionService.updateStatus('sess-1', 'user-1', 'ended');

      expect(callback).toHaveBeenCalledWith('sess-1');
    });

    it('updateStatus to non-ended should not invoke callback', async () => {
      const callback = vi.fn();
      sessionService.onSessionEnded(callback);
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue(mockSessionDoc({ status: 'running' }) as never);

      await sessionService.updateStatus('sess-1', 'user-1', 'running');

      expect(callback).not.toHaveBeenCalled();
    });

    it('close should invoke registered callback', async () => {
      const callback = vi.fn();
      sessionService.onSessionEnded(callback);
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue(mockSessionDoc({ status: 'ended' }) as never);

      await sessionService.close('sess-1', 'user-1');

      expect(callback).toHaveBeenCalledWith('sess-1');
    });
  });
});
