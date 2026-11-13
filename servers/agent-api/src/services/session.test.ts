import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';

vi.mock('../models/session.js', () => ({
  Session: {
    find: vi.fn(),
    findOne: vi.fn(),
    findById: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findByIdAndUpdate: vi.fn(),
    findOneAndDelete: vi.fn(),
    deleteOne: vi.fn(),
    create: vi.fn(),
    updateOne: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock('../models/session-interaction.js', () => ({
  SessionInteraction: {
    deleteMany: vi.fn(),
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

vi.mock('../models/cloud-host.js', () => ({
  CloudHost: {
    findOne: vi.fn(),
  },
}));

vi.mock('../models/controller-workspace.js', () => ({
  ControllerWorkspace: {
    findOne: vi.fn(),
    find: vi.fn(),
    exists: vi.fn(),
  },
}));

vi.mock('../models/mcp-server.js', () => ({
  McpServer: {
    countDocuments: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(async () => ({ _id: { toString: () => 'mcp-tools' } })),
    find: vi.fn(() => ({
      select: vi.fn(() => ({
        lean: vi.fn(async () => []),
      })),
    })),
  },
}));

vi.mock('../models/custom-mcp-server.js', () => ({
  CustomMcpServer: {
    find: vi.fn(() => ({
      select: vi.fn(() => ({
        lean: vi.fn(async () => []),
      })),
    })),
  },
}));

vi.mock('./session-preview-tools.js', () => ({
  SESSION_PREVIEW_TOOLS_SERVER_NAME: 'agent-session-preview-tools',
  ensureSessionPreviewToolsServer: vi.fn(async () => 'mcp-preview-tools'),
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

vi.mock('./commit-settings-service.js', () => ({
  commitSettingsService: {
    resolveWorktreeCommitter: vi.fn(),
  },
}));

import { logger as rootLogger } from '../observability/logger.js';
import { createTestLogger } from '../observability/testing.js';

/**
 * 注入 createTestLogger：在被测模块加载前拦截 `rootLogger.child(...)`，把
 * session 日志写入内存 sink，断言 `records` 的结构化字段。
 */
const testLog = createTestLogger();
const childSpy = vi
  .spyOn(rootLogger, 'child')
  .mockImplementation((bindings) => testLog.logger.child(bindings));
const { sessionService, resolveInitialMcpServerIds } = await import('./session.js');
childSpy.mockRestore();
import { Session } from '../models/session.js';
import { AcpMessage } from '../models/acp-message.js';
import { Controller } from '../models/controller.js';
import { CloudHost } from '../models/cloud-host.js';
import { ControllerWorkspace } from '../models/controller-workspace.js';
import { McpServer } from '../models/mcp-server.js';
import { CustomMcpServer } from '../models/custom-mcp-server.js';
import { getRedisClient } from '../middleware/redis.js';
import { mcpEndpointService } from './mcp-endpoint.js';
import { commitSettingsService } from './commit-settings-service.js';
import { runWithWorkspace } from './workspace-context.js';

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
    vi.mocked(Session.updateOne).mockResolvedValue({ acknowledged: true } as never);
    vi.mocked(commitSettingsService.resolveWorktreeCommitter).mockResolvedValue(null);
    // 默认成功（T-SPT6 后 create 恒装配 preview tools、必达 createEndpoint）；
    // 需要失败语义的用例在本用例内重新 mockRejectedValue 覆盖
    vi.mocked(mcpEndpointService.createEndpoint).mockResolvedValue({
      token: 'tok',
      serverNames: ['agent-session-preview-tools'],
    } as never);
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

      expect(Session.find).toHaveBeenCalledWith({ userId: 'user-1', workflowInstanceId: null, archivedAt: null });
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

    it('T-SS-TEAM3: 后台链路无 ALS 上下文时继承控制器的租户工作区与租户', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          name: 'cloud-ctrl',
          workspaceId: 'ws-team',
          tenantId: 'tenant-team',
          type: 'local',
        }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(Session.create).mockResolvedValue(mockSessionDoc() as never);

      await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-project',
      });

      expect(Session.create).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws-team',
          tenantId: 'tenant-team',
        }),
      );
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
        .mockResolvedValueOnce(JSON.stringify({ success: true, worktreePath: '/worktrees/my-project/feat-123-abc12345', branch: 'my-project/feat-123-abc12345' }));

      vi.mocked(Session.create).mockResolvedValue(mockSessionDoc({
        controllerName: 'my-server',
        cwd: '/worktrees/my-project/feat-123-abc12345',
        worktreePath: '/worktrees/my-project/feat-123-abc12345',
        worktreeBranch: 'my-project/feat-123-abc12345',
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
      // 验证分支名包含随机后缀
      const publishCalls = mockRedis.publish.mock.calls.map(c => String(c[1]));
      const addCall = publishCalls.find(c => c.includes('git:worktree:add'));
      expect(addCall).toBeDefined();
      expect(addCall).toMatch(/"branch":"my-project\/feat-123-[a-f0-9]+"/);
      expect(Session.create).toHaveBeenCalledWith(expect.objectContaining({
        worktreePath: '/worktrees/my-project/feat-123-abc12345',
        worktreeBranch: expect.stringMatching(/my-project\/feat-123-[a-f0-9]+/),
      }));
      expect(result.cwd).toBe('/worktrees/my-project/feat-123-abc12345');
    });

    describe('T-WF-C3 独立会话 worktree 提交人', () => {
      function mockWorktreeDeps() {
        vi.mocked(Controller.findOne).mockReturnValue({
          lean: vi.fn().mockResolvedValue({ name: 'my-server', worktreeDir: '/worktrees' }),
        } as never);
        vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
          lean: vi.fn().mockResolvedValue({ path: '/home/user/project', name: 'my-project' }),
        } as never);
        mockRedis.publish.mockResolvedValue(1);
        mockRedis.get
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(JSON.stringify({ success: true, worktreePath: '/worktrees/my-project/feat-1-abc12345' }));
        vi.mocked(Session.create).mockResolvedValue(mockSessionDoc() as never);
      }

      function addPayload():
        | {
            committer?: {
              name: string;
              email: string;
              coAuthorName?: string;
              coAuthorEmail?: string;
            };
          }
        | undefined {
        return mockRedis.publish.mock.calls
          .map((c) => JSON.parse(String(c[1])))
          .find((p: { type?: string }) => p.type === 'git:worktree:add') as
          | {
              committer?: {
                name: string;
                email: string;
                coAuthorName?: string;
                coAuthorEmail?: string;
              };
            }
          | undefined;
      }

      it('C3a: 未显式传入 → 按会话创建者实时解析并随 git:worktree:add 下发（含共同作者）', async () => {
        mockWorktreeDeps();
        vi.mocked(commitSettingsService.resolveWorktreeCommitter).mockResolvedValue({
          name: 'Deliay',
          email: 'deliay@example.com',
          coAuthorName: 'zag-bot[bot]',
          coAuthorEmail: '123456+zag-bot[bot]@users.noreply.github.com',
        });

        await sessionService.create('user-1', {
          controllerId: 'ctrl-1',
          acpServerType: 'opencode',
          workspaceId: 'ws-1',
          enableWorktree: true,
          worktreeBranchSuffix: 'feat-1',
        });

        expect(commitSettingsService.resolveWorktreeCommitter).toHaveBeenCalledWith('user-1');
        expect(addPayload()?.committer).toEqual({
          name: 'Deliay',
          email: 'deliay@example.com',
          coAuthorName: 'zag-bot[bot]',
          coAuthorEmail: '123456+zag-bot[bot]@users.noreply.github.com',
        });
      });

      it('C3b: 调用方显式传入（工作流节点复用实例快照）优先，不再查会话创建者', async () => {
        mockWorktreeDeps();
        const snapshot = { name: 'snapshot', email: 'snapshot@example.com' };

        await sessionService.create('user-1', {
          controllerId: 'ctrl-1',
          acpServerType: 'opencode',
          workspaceId: 'ws-1',
          enableWorktree: true,
          worktreeBranchSuffix: 'feat-1',
          worktreeCommitter: snapshot,
        });

        expect(commitSettingsService.resolveWorktreeCommitter).not.toHaveBeenCalled();
        expect(addPayload()?.committer).toEqual(snapshot);
      });

      it('C3c: 显式 null → 不下发 committer（沿用容器级 bot）', async () => {
        mockWorktreeDeps();

        await sessionService.create('user-1', {
          controllerId: 'ctrl-1',
          acpServerType: 'opencode',
          workspaceId: 'ws-1',
          enableWorktree: true,
          worktreeBranchSuffix: 'feat-1',
          worktreeCommitter: null,
        });

        expect(commitSettingsService.resolveWorktreeCommitter).not.toHaveBeenCalled();
        expect(addPayload()).toBeTruthy();
        expect(addPayload()).not.toHaveProperty('committer');
      });

      it('C3d: 非 worktree 会话不解析提交人、不发 git:worktree:add', async () => {
        vi.mocked(Controller.findOne).mockReturnValue({
          lean: vi.fn().mockResolvedValue({ name: 'my-server' }),
        } as never);
        vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
          lean: vi.fn().mockResolvedValue({ path: '/home/user/project', name: 'my-project' }),
        } as never);
        vi.mocked(Session.create).mockResolvedValue(mockSessionDoc() as never);

        await sessionService.create('user-1', {
          controllerId: 'ctrl-1',
          acpServerType: 'opencode',
          workspaceId: 'ws-1',
        });

        expect(commitSettingsService.resolveWorktreeCommitter).not.toHaveBeenCalled();
        const types = mockRedis.publish.mock.calls.map((c) => JSON.parse(String(c[1])).type);
        expect(types).not.toContain('git:worktree:add');
      });

      it('C3e: 已有 Worktree 会话按当前设置同步共同作者（不重建 Worktree）', async () => {
        vi.mocked(Controller.findOne).mockReturnValue({
          lean: vi.fn().mockResolvedValue({ name: 'my-server', worktreeDir: '/worktrees' }),
        } as never);
        vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
          lean: vi.fn().mockResolvedValue({ path: '/home/user/project', name: 'my-project' }),
        } as never);
        vi.mocked(commitSettingsService.resolveWorktreeCommitter).mockResolvedValue({
          name: 'Deliay',
          email: 'deliay@example.com',
          coAuthorName: 'zag-bot[bot]',
          coAuthorEmail: '123456+zag-bot[bot]@users.noreply.github.com',
        });
        mockRedis.publish.mockResolvedValue(1);
        mockRedis.get.mockResolvedValue(JSON.stringify({ success: true }));
        vi.mocked(Session.create).mockResolvedValue(mockSessionDoc() as never);

        await sessionService.create('user-1', {
          controllerId: 'ctrl-1',
          acpServerType: 'opencode',
          workspaceId: 'ws-1',
          existingWorktreePath: '/worktrees/my-project/existing',
        });

        const types = mockRedis.publish.mock.calls.map((c) => JSON.parse(String(c[1])).type);
        expect(types).not.toContain('git:worktree:add');
        const coAuthorPayload = mockRedis.publish.mock.calls
          .map((c) => JSON.parse(String(c[1])))
          .find((p: { type?: string }) => p.type === 'git:worktree:coauthor');
        expect(coAuthorPayload).toMatchObject({
          controllerId: 'ctrl-1',
          worktreePath: '/worktrees/my-project/existing',
          coAuthor: {
            name: 'zag-bot[bot]',
            email: '123456+zag-bot[bot]@users.noreply.github.com',
          },
        });
        expect(commitSettingsService.resolveWorktreeCommitter).toHaveBeenCalledWith('user-1');
      });

      it('C3f: 已有 Worktree + 未勾选共同作者 → 下发空 coAuthor（worker 清理受管配置）', async () => {
        vi.mocked(Controller.findOne).mockReturnValue({
          lean: vi.fn().mockResolvedValue({ name: 'my-server', worktreeDir: '/worktrees' }),
        } as never);
        vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
          lean: vi.fn().mockResolvedValue({ path: '/home/user/project', name: 'my-project' }),
        } as never);
        vi.mocked(commitSettingsService.resolveWorktreeCommitter).mockResolvedValue({
          name: 'Deliay',
          email: 'deliay@example.com',
        });
        mockRedis.publish.mockResolvedValue(1);
        mockRedis.get.mockResolvedValue(JSON.stringify({ success: true }));
        vi.mocked(Session.create).mockResolvedValue(mockSessionDoc() as never);

        await sessionService.create('user-1', {
          controllerId: 'ctrl-1',
          acpServerType: 'opencode',
          workspaceId: 'ws-1',
          existingWorktreePath: '/worktrees/my-project/existing',
        });

        const coAuthorPayload = mockRedis.publish.mock.calls
          .map((c) => JSON.parse(String(c[1])))
          .find((p: { type?: string }) => p.type === 'git:worktree:coauthor');
        expect(coAuthorPayload).toMatchObject({
          worktreePath: '/worktrees/my-project/existing',
        });
        expect(coAuthorPayload).not.toHaveProperty('coAuthor');
      });
    });

    it('should throw on worktree add failure (non-retryable error)', async () => {      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'my-server' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project', name: 'my-project' }),
      } as never);

      mockRedis.publish.mockResolvedValue(1);
      mockRedis.get
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify({ success: false, error: 'permission denied' }));

      await expect(sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        enableWorktree: true,
        worktreeBranchSuffix: 'feat-123',
      })).rejects.toThrow('WORKTREE_ADD_FAILED: permission denied');
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

      await expect(promise).rejects.toThrow('WORKTREE_ADD_FAILED: 等待 git worktree add 超时');

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
        token: 'mcp-token',
        serverNames: ['fluentui-mcp'],
      });

      await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        mcpServerIds: ['server-1'],
      });

      // T-SPT6：会话预览平台工具（mcp-preview-tools）恒装配并去重；custom 快照空数组
      expect(mcpEndpointService.createEndpoint).toHaveBeenCalledWith(
        'sess-1',
        'user-1',
        ['server-1', 'mcp-preview-tools'],
        undefined,
        [],
      );
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"acp:start"'),
      );
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"mcpEndpoint":{"token":"mcp-token","serverNames":["fluentui-mcp"]}'),
      );
    });

    it('should assemble preview tools even without user MCP selection（T-SPT6）', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'my-server' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(Session.create).mockResolvedValue(mockSessionDoc() as never);
      vi.mocked(mcpEndpointService.createEndpoint).mockResolvedValue({
        token: 'mcp-token',
        serverNames: ['agent-session-preview-tools'],
      });

      await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
      });

      // 用户未选 MCP 时仍装配会话预览平台工具（全部类型会话公共路径）
      expect(mcpEndpointService.createEndpoint).toHaveBeenCalledWith(
        'sess-1',
        'user-1',
        ['mcp-preview-tools'],
        undefined,
        [],
      );
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"acp:start"'),
      );
    });

    it('should fail session creation when MCP endpoint issuance fails and mcpServerIds provided', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'my-server' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(Session.create).mockResolvedValue(mockSessionDoc() as never);
      vi.mocked(Session.deleteOne).mockResolvedValue({ deletedCount: 1 } as never);
      vi.mocked(McpServer.countDocuments).mockResolvedValue(1 as never);
      vi.mocked(mcpEndpointService.createEndpoint).mockRejectedValue(new Error('SERVER_NOT_FOUND'));

      await expect(
        sessionService.create('user-1', {
          controllerId: 'ctrl-1',
          acpServerType: 'opencode',
          workspaceId: 'ws-1',
          mcpServerIds: ['server-1'],
        }),
      ).rejects.toThrow('MCP endpoint 创建失败');

      // Session should be cleaned up
      expect(Session.deleteOne).toHaveBeenCalledWith({ _id: expect.anything() });
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

    // --- 自定义 MCP 签发（Phase 3 / T-CF1）---

    function mockCustomMcpRows(rows: unknown[]) {
      vi.mocked(CustomMcpServer.find).mockReturnValue({
        select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(rows) }),
      } as never);
    }

    function mockCreatePrereqs() {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'my-server' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(Session.create).mockResolvedValue(mockSessionDoc() as never);
    }

    it('T-CF1: 不可见/不存在的 customMcpServerIds 拒绝且不建会话', async () => {
      mockCreatePrereqs();
      // 可见集为空（不存在或跨工作区）：请求 1 条、命中 0 条
      mockCustomMcpRows([]);

      await expect(
        sessionService.create('user-1', {
          controllerId: 'ctrl-1',
          acpServerType: 'opencode',
          workspaceId: 'ws-1',
          mcpServerIds: [],
          customMcpServerIds: ['64b0000000000000000000c1'],
        }),
      ).rejects.toThrow('custom mcp server not found');

      expect(Session.create).not.toHaveBeenCalled();
      expect(mcpEndpointService.createEndpoint).not.toHaveBeenCalled();
      expect(mockRedis.publish).not.toHaveBeenCalled();
    });

    it('T-CF1: 非法 customMcpServerIds 直接拒绝（不发起查询）', async () => {
      mockCreatePrereqs();

      await expect(
        sessionService.create('user-1', {
          controllerId: 'ctrl-1',
          acpServerType: 'opencode',
          workspaceId: 'ws-1',
          mcpServerIds: [],
          customMcpServerIds: ['not-an-object-id'],
        }),
      ).rejects.toThrow('custom mcp server not found');

      expect(CustomMcpServer.find).not.toHaveBeenCalled();
      expect(Session.create).not.toHaveBeenCalled();
    });

    it('T-CF1: 可见 custom id 组装 [{id,name}] 快照并入 createEndpoint（custom-only 会话可签发）', async () => {
      mockCreatePrereqs();
      const customId = '64b0000000000000000000c1';
      mockCustomMcpRows([{ _id: { toString: () => customId }, name: 'custom-a' }]);
      vi.mocked(mcpEndpointService.createEndpoint).mockResolvedValue({
        token: 'mcp-token',
        serverNames: ['custom-a'],
      });

      await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        mcpServerIds: [],
        customMcpServerIds: [customId],
      });

      expect(CustomMcpServer.find).toHaveBeenCalledWith({ _id: { $in: [customId] } });
      expect(mcpEndpointService.createEndpoint).toHaveBeenCalledWith(
        'sess-1',
        'user-1',
        ['mcp-preview-tools'],
        undefined,
        [{ id: customId, name: 'custom-a' }],
      );
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"mcpEndpoint":{"token":"mcp-token","serverNames":["custom-a"]}'),
      );
    });

    it('T-CF1: custom 与个人 MCP 同时选择时快照一并下发', async () => {
      mockCreatePrereqs();
      const customId = '64b0000000000000000000c2';
      mockCustomMcpRows([{ _id: { toString: () => customId }, name: 'custom-a' }]);
      vi.mocked(McpServer.countDocuments).mockResolvedValue(1 as never);
      vi.mocked(mcpEndpointService.createEndpoint).mockResolvedValue({
        token: 'mcp-token',
        serverNames: ['fluentui-mcp', 'custom-a'],
      });

      await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        mcpServerIds: ['server-1'],
        customMcpServerIds: [customId],
      });

      expect(mcpEndpointService.createEndpoint).toHaveBeenCalledWith(
        'sess-1',
        'user-1',
        ['server-1', 'mcp-preview-tools'],
        undefined,
        [{ id: customId, name: 'custom-a' }],
      );
    });

    it('T-CF1: custom-only 会话签发失败同样 fail-fast 删会话', async () => {
      mockCreatePrereqs();
      vi.mocked(Session.deleteOne).mockResolvedValue({ deletedCount: 1 } as never);
      const customId = '64b0000000000000000000c1';
      mockCustomMcpRows([{ _id: { toString: () => customId }, name: 'custom-a' }]);
      vi.mocked(mcpEndpointService.createEndpoint).mockRejectedValue(new Error('boom'));

      await expect(
        sessionService.create('user-1', {
          controllerId: 'ctrl-1',
          acpServerType: 'opencode',
          workspaceId: 'ws-1',
          mcpServerIds: [],
          customMcpServerIds: [customId],
        }),
      ).rejects.toThrow('MCP endpoint 创建失败');

      expect(Session.deleteOne).toHaveBeenCalledWith({ _id: expect.anything() });
    });

    it('should reject when both existingWorktreePath and enableWorktree are provided', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl-1', name: 'dev' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project', name: 'proj' }),
      } as never);

      const err = await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        enableWorktree: true,
        existingWorktreePath: '/tmp/conflict',
      }).catch((e) => e);

      expect(err).toBeInstanceOf(GraphQLError);
      expect(err.message).toContain('mutually exclusive');
      expect((err as GraphQLError).extensions.code).toBe('BAD_USER_INPUT');
      expect(Session.create).not.toHaveBeenCalled();
    });

    it('should reject existingWorktreePath outside the workspace worktree scope', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl-1', name: 'dev', worktreeDir: '/worktrees' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project', name: 'my-project' }),
      } as never);

      const err = await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        existingWorktreePath: '/worktrees/other-project/feat-9',
      }).catch((e) => e);

      expect(err).toBeInstanceOf(GraphQLError);
      expect((err as GraphQLError).extensions.code).toBe('BAD_USER_INPUT');
      expect(Session.create).not.toHaveBeenCalled();
    });

    it('should reject existingWorktreePath that escapes the scope via path traversal', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl-1', name: 'dev', worktreeDir: '/worktrees' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project', name: 'my-project' }),
      } as never);

      const err = await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        existingWorktreePath: '/worktrees/my-project/../other-project/feat-9',
      }).catch((e) => e);

      expect(err).toBeInstanceOf(GraphQLError);
      expect((err as GraphQLError).extensions.code).toBe('BAD_USER_INPUT');
      expect(Session.create).not.toHaveBeenCalled();
    });

    it('should reuse an existing worktree without taking ownership (no worktreeBranch)', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl-1', name: 'dev', worktreeDir: '/worktrees' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project', name: 'my-project' }),
      } as never);
      vi.mocked(Session.create).mockResolvedValue(mockSessionDoc({
        cwd: '/worktrees/my-project/feat-1',
        worktreePath: '/worktrees/my-project/feat-1',
        worktreeBranch: null,
      }) as never);

      await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        existingWorktreePath: '/worktrees/my-project/feat-1',
        worktreeBranchSuffix: 'feat-1',
      });

      const createArg = vi.mocked(Session.create).mock.calls[0][0] as Record<string, unknown>;
      expect(createArg.cwd).toBe('/worktrees/my-project/feat-1');
      expect(createArg.worktreePath).toBe('/worktrees/my-project/feat-1');
      expect(createArg.worktreeBranch).toBeUndefined();
      // Reusing a worktree must not trigger git:worktree:add
      expect(mockRedis.publish).not.toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"git:worktree:add"'),
      );
    });

    it('should accept an expanded default worktree path when homeDir is reported (T-A1)', async () => {
      // 未配置 worktreeDir → 生效默认 ~/.zag/worktrees；控制器上报 homeDir；existingWorktreePath 为展开后绝对路径
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl-1', name: 'dev', homeDir: '/home/user', platform: 'linux' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/repo/my-project', name: 'my-project' }),
      } as never);
      vi.mocked(Session.create).mockResolvedValue(mockSessionDoc({
        cwd: '/home/user/.zag/worktrees/my-project/wf-abc',
        worktreePath: '/home/user/.zag/worktrees/my-project/wf-abc',
      }) as never);

      const result = await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        existingWorktreePath: '/home/user/.zag/worktrees/my-project/wf-abc',
      });

      expect(result.cwd).toBe('/home/user/.zag/worktrees/my-project/wf-abc');
      expect(Session.create).toHaveBeenCalled();
    });

    it('should use a configured custom worktreeDir (absolute) for validation and generation (T-A2)', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl-1', name: 'dev', worktreeDir: '/data/wt', homeDir: '/home/user', platform: 'linux' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/repo/my-project', name: 'my-project' }),
      } as never);
      vi.mocked(Session.create).mockResolvedValue(mockSessionDoc({
        cwd: '/data/wt/my-project/wf-abc',
        worktreePath: '/data/wt/my-project/wf-abc',
      }) as never);

      const result = await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        existingWorktreePath: '/data/wt/my-project/wf-abc',
      });

      expect(result.cwd).toBe('/data/wt/my-project/wf-abc');
    });

    it('should use a configured custom worktreeDir containing ~ for validation (T-A2 tilde)', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl-1', name: 'dev', worktreeDir: '~/wt', homeDir: '/home/user', platform: 'linux' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/repo/my-project', name: 'my-project' }),
      } as never);
      vi.mocked(Session.create).mockResolvedValue(mockSessionDoc({
        cwd: '/home/user/wt/my-project/wf-abc',
        worktreePath: '/home/user/wt/my-project/wf-abc',
      }) as never);

      const result = await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        existingWorktreePath: '/home/user/wt/my-project/wf-abc',
      });

      expect(result.cwd).toBe('/home/user/wt/my-project/wf-abc');
    });

    it('should still reject a traversal path that escapes the expanded scope (T-A3)', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl-1', name: 'dev', homeDir: '/home/user', platform: 'linux' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/repo/my-project', name: 'my-project' }),
      } as never);

      const err = await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        existingWorktreePath: '/home/user/.zag/worktrees/my-project/../evil/feat-9',
      }).catch((e) => e);

      expect(err).toBeInstanceOf(GraphQLError);
      expect((err as GraphQLError).extensions.code).toBe('BAD_USER_INPUT');
      expect(Session.create).not.toHaveBeenCalled();
    });

    it('should reject an existingWorktreePath from another workspace (T-A3 other-ws)', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl-1', name: 'dev', homeDir: '/home/user', platform: 'linux' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/repo/my-project', name: 'my-project' }),
      } as never);

      const err = await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        existingWorktreePath: '/home/user/.zag/worktrees/other-project/wf-abc',
      }).catch((e) => e);

      expect(err).toBeInstanceOf(GraphQLError);
      expect((err as GraphQLError).extensions.code).toBe('BAD_USER_INPUT');
    });

    it('should throw a clear error when homeDir missing and effective dir contains ~ (T-A4)', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl-1', name: 'dev' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/repo/my-project', name: 'my-project' }),
      } as never);

      const err = await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        existingWorktreePath: '/home/user/.zag/worktrees/my-project/wf-abc',
      }).catch((e) => e);

      expect(err).toBeInstanceOf(GraphQLError);
      expect((err as GraphQLError).extensions.code).toBe('BAD_USER_INPUT');
      expect(err.message).toContain('homeDir');
      expect(Session.create).not.toHaveBeenCalled();
    });

    it('should correctly determine ownership for a win32 controller (T-A5)', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl-1', name: 'dev', homeDir: 'C:\\Users\\dev', platform: 'win32' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: 'C:\\repo\\my-project', name: 'my-project' }),
      } as never);
      vi.mocked(Session.create).mockResolvedValue(mockSessionDoc({
        cwd: 'C:\\Users\\dev\\.zag\\worktrees\\My-Project\\WF-ABC',
        worktreePath: 'C:\\Users\\dev\\.zag\\worktrees\\My-Project\\WF-ABC',
      }) as never);

      const result = await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        existingWorktreePath: 'C:\\Users\\dev\\.zag\\worktrees\\My-Project\\WF-ABC',
      });

      expect(result.cwd).toBe('C:\\Users\\dev\\.zag\\worktrees\\My-Project\\WF-ABC');
    });

    it('should not depend on homeDir when effective dir is absolute (T-A6)', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl-1', name: 'dev', worktreeDir: '/data/wt' }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/repo/my-project', name: 'my-project' }),
      } as never);
      vi.mocked(Session.create).mockResolvedValue(mockSessionDoc({
        cwd: '/data/wt/my-project/wf-abc',
        worktreePath: '/data/wt/my-project/wf-abc',
      }) as never);

      const result = await sessionService.create('user-1', {
        controllerId: 'ctrl-1',
        acpServerType: 'opencode',
        workspaceId: 'ws-1',
        existingWorktreePath: '/data/wt/my-project/wf-abc',
      });

      expect(result.cwd).toBe('/data/wt/my-project/wf-abc');
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
        { returnDocument: 'after' },
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
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc()),
      } as never);
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue(mockSessionDoc({ status: 'ended' }) as never);

      const result = await sessionService.close('sess-1', 'user-1');
      expect(result).toBe(true);
    });

    it('should revoke MCP endpoint on close for normal session', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc()),
      } as never);
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue(mockSessionDoc({ status: 'ended' }) as never);

      await sessionService.close('sess-1', 'user-1');

      expect(mcpEndpointService.revokeEndpoint).toHaveBeenCalledWith('sess-1');
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"acp:stop"'),
      );
    });

    it('N-1: suppressFallback=true 时不触发会话结束兜底回调', async () => {
      const onEnded = vi.fn();
      sessionService.onSessionEnded(onEnded);
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ workflowInstanceId: oid('inst-1') })),
      } as never);
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue(
        mockSessionDoc({ status: 'ended', workflowInstanceId: oid('inst-1') }) as never,
      );

      await sessionService.close('sess-1', 'user-1', { suppressFallback: true });

      expect(onEnded).not.toHaveBeenCalled();
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"acp:stop"'),
      );
    });

    it('should NOT revoke MCP endpoint on close for workflow node session (validity follows workflow)', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ workflowInstanceId: oid('inst-1') })),
      } as never);
      vi.mocked(Session.findOneAndUpdate).mockResolvedValue(
        mockSessionDoc({ status: 'ended', workflowInstanceId: oid('inst-1') }) as never,
      );

      await sessionService.close('sess-1', 'user-1');

      expect(mcpEndpointService.revokeEndpoint).not.toHaveBeenCalled();
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
      // waitForStopAck polls until it gets the ack or times out
      mockRedis.get.mockResolvedValue(JSON.stringify({ stopped: true }));

      const result = await sessionService.delete('sess-1', 'user-1');

      expect(result).toBe(true);
      expect(AcpMessage.deleteMany).toHaveBeenCalledWith({ sessionId: 'sess-1' });
      expect(mockRedis.del).toHaveBeenCalledWith('session:sess-1:status');
      expect(mcpEndpointService.revokeEndpoint).toHaveBeenCalledWith('sess-1');
    });

    it('should wait for the ACP stop ack before cleaning a worktree', async () => {
      const sessionDoc = mockSessionDoc({ status: 'running', worktreePath: '/worktrees/project/branch', worktreeBranch: 'project/branch' });
      vi.mocked(Session.findOne).mockReturnValue({ lean: vi.fn().mockResolvedValue(sessionDoc) } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({ lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }) } as never);
      vi.mocked(Session.findOneAndDelete).mockResolvedValue(mockSessionDoc() as never);
      vi.mocked(AcpMessage.deleteMany).mockResolvedValue(undefined as never);
      // ack: first call returns null (no ack yet), second call returns ack (simulating delay)
      // then status: returns clean, then worktree remove: returns success
      mockRedis.get
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify({ stopped: true }))
        .mockResolvedValueOnce(JSON.stringify({ isClean: true }))
        .mockResolvedValueOnce(JSON.stringify({ success: true }));

      await sessionService.delete('sess-1', 'user-1');

      // First call should be the ack poll
      expect(mockRedis.get.mock.calls[0][0]).toBe('acp:stop:ack:sess-1');
      expect(mockRedis.del).toHaveBeenCalledWith('acp:stop:ack:sess-1');
    });

    it('should warn and continue when ACP stop ack times out', async () => {
      const sessionDoc = mockSessionDoc({ status: 'running' });
      vi.mocked(Session.findOne).mockReturnValue({ lean: vi.fn().mockResolvedValue(sessionDoc) } as never);
      vi.mocked(Session.findOneAndDelete).mockResolvedValue(mockSessionDoc() as never);
      vi.mocked(AcpMessage.deleteMany).mockResolvedValue(undefined as never);
      // Stub waitForStopAck to immediately return false (simulating timeout)
      const origWait = (sessionService as any).waitForStopAck.bind(sessionService);
      (sessionService as any).waitForStopAck = async () => false;
      testLog.reset();

      await sessionService.delete('sess-1', 'user-1');

      const rec = testLog.records.find((r) => r.level === 'warn' && String(r.msg).includes('ACP stop ack timeout'));
      expect(rec).toBeDefined();
      expect(rec?.sessionId).toBe('sess-1');
      (sessionService as any).waitForStopAck = origWait;
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
        .mockResolvedValueOnce(JSON.stringify({ stopped: true })) // ack → received
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
        .mockResolvedValueOnce(JSON.stringify({ stopped: true })) // ack → received
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
        .mockResolvedValueOnce(JSON.stringify({ stopped: true })) // ack → received
        .mockResolvedValueOnce(JSON.stringify({ isClean: true })) // clean, skip commit
        .mockResolvedValueOnce(JSON.stringify({ success: false, error: 'worktree not found' })); // remove fails

      await expect(sessionService.delete('sess-1', 'user-1')).rejects.toThrow('WORKTREE_REMOVE_FAILED');
    });

    it('should not throw error when worktree removal fails with "is not a working tree"', async () => {
      const sessionDoc = mockSessionDoc({ status: 'running', worktreePath: '/worktrees/project/branch', worktreeBranch: 'project/branch' });
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(sessionDoc),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(Session.findOneAndDelete).mockResolvedValue(mockSessionDoc() as never);
      vi.mocked(AcpMessage.deleteMany).mockResolvedValue(undefined as never);

      mockRedis.get
        .mockResolvedValueOnce(JSON.stringify({ stopped: true })) // ack → received
        .mockResolvedValueOnce(JSON.stringify({ isClean: true })) // clean, skip commit
        .mockResolvedValueOnce(JSON.stringify({ success: false, error: "fatal: '/path/to/worktree' is not a working tree" })); // remove fails with "is not a working tree"

      const result = await sessionService.delete('sess-1', 'user-1');
      expect(result).toBe(true);
    });

    it.each(['creating', 'connecting'])('should send acp:stop and wait for ack when deleting a %s session', async (status) => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status })),
      } as never);
      vi.mocked(Session.findOneAndDelete).mockResolvedValue(mockSessionDoc() as never);
      vi.mocked(AcpMessage.deleteMany).mockResolvedValue(undefined as never);
      mockRedis.get.mockResolvedValue(JSON.stringify({ stopped: true }));

      const result = await sessionService.delete('sess-1', 'user-1');

      expect(result).toBe(true);
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"acp:stop"'),
      );
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"reason":"user_delete"'),
      );
      expect(mockRedis.get).toHaveBeenCalledWith('acp:stop:ack:sess-1');
    });

    it('should clear any stale stop ack before requesting stop', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'running' })),
      } as never);
      vi.mocked(Session.findOneAndDelete).mockResolvedValue(mockSessionDoc() as never);
      vi.mocked(AcpMessage.deleteMany).mockResolvedValue(undefined as never);
      mockRedis.get.mockResolvedValue(JSON.stringify({ stopped: true }));

      await sessionService.delete('sess-1', 'user-1');

      const delAckIndex = mockRedis.del.mock.calls.findIndex((c) => c[0] === 'acp:stop:ack:sess-1');
      expect(delAckIndex).toBeGreaterThanOrEqual(0);
      const delAckOrder = mockRedis.del.mock.invocationCallOrder[delAckIndex];
      const stopPublishIndex = mockRedis.publish.mock.calls.findIndex((c) => String(c[1]).includes('"type":"acp:stop"'));
      expect(stopPublishIndex).toBeGreaterThanOrEqual(0);
      const stopPublishOrder = mockRedis.publish.mock.invocationCallOrder[stopPublishIndex];
      expect(delAckOrder).toBeLessThan(stopPublishOrder);
    });

    it('should not run worktree cleanup on delete when the session only reused the worktree (no worktreeBranch)', async () => {
      const sessionDoc = mockSessionDoc({
        status: 'idling',
        worktreePath: '/worktrees/my-project/feat-1',
        worktreeBranch: null,
      });
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(sessionDoc),
      } as never);
      vi.mocked(Session.findOneAndDelete).mockResolvedValue(mockSessionDoc() as never);
      vi.mocked(AcpMessage.deleteMany).mockResolvedValue(undefined as never);
      mockRedis.get.mockResolvedValue(JSON.stringify({ stopped: true }));

      const result = await sessionService.delete('sess-1', 'user-1');

      expect(result).toBe(true);
      expect(mockRedis.publish).not.toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"git:worktree:remove"'),
      );
      expect(mockRedis.publish).not.toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"git:commit"'),
      );
      expect(mockRedis.publish).not.toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"type":"git:status"'),
      );
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

  describe('acp server options cache', () => {
    const cachedOptions = {
      modes: [{ id: 'plan', name: 'Plan' }],
      models: [{ id: 'm1', name: 'M1' }],
      currentModeId: 'plan',
      currentModelId: 'm1',
      probedAt: '2026-10-23T06:00:00.000Z',
    };

    beforeEach(() => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: 'ctrl' }),
      } as never);
    });

    it('C-14: 命中缓存直接返回，不发布探测命令', async () => {
      vi.mocked(mockRedis.get).mockResolvedValue(JSON.stringify(cachedOptions));

      const result = await sessionService.getAcpServerOptions('ctrl-1', 'opencode', 'user-1');

      expect(result).toEqual(cachedOptions);
      expect(mockRedis.publish).not.toHaveBeenCalled();
    });

    it('C-14: 刷新先删缓存再重探测', async () => {
      const fresh = { ...cachedOptions, probedAt: new Date().toISOString() };
      vi.mocked(mockRedis.del).mockResolvedValue(1);
      vi.mocked(mockRedis.get).mockResolvedValue(JSON.stringify(fresh));

      const result = await sessionService.refreshAcpServerOptions('ctrl-1', 'opencode', 'user-1');

      expect(mockRedis.del).toHaveBeenCalledWith('acp:options:ctrl-1:opencode');
      expect(result).toEqual(fresh);
    });

    it('C-9: 刷新时删除缓存失败显式报错，不回退旧缓存', async () => {
      vi.mocked(mockRedis.del).mockRejectedValue(new Error('redis down'));

      await expect(
        sessionService.refreshAcpServerOptions('ctrl-1', 'opencode', 'user-1'),
      ).rejects.toThrow('刷新失败，请重试');
    });

    it('C-9: 刷新只接受删除之后写入的探测结果', async () => {
      vi.useFakeTimers();
      const stale = { ...cachedOptions, probedAt: '2020-01-01T00:00:00.000Z' };
      const fresh = { ...cachedOptions, probedAt: new Date().toISOString() };
      vi.mocked(mockRedis.del).mockResolvedValue(1);
      vi.mocked(mockRedis.get)
        .mockResolvedValueOnce(JSON.stringify(stale))
        .mockResolvedValueOnce(JSON.stringify(stale))
        .mockResolvedValue(JSON.stringify(fresh));

      const promise = sessionService.refreshAcpServerOptions('ctrl-1', 'opencode', 'user-1');
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(500);
      }

      await expect(promise).resolves.toEqual(fresh);
      vi.useRealTimers();
    });

    it('C-14: Controller not found', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({ lean: vi.fn().mockResolvedValue(null) } as never);

      await expect(
        sessionService.refreshAcpServerOptions('ctrl-1', 'opencode', 'user-1'),
      ).rejects.toThrow('Controller not found');
    });
  });

  describe('resume', () => {
    // 会话管理优化：resume 收敛为统一只读判定（控制器缺失/工作区缺失/云电脑终态 → session is ended），
    // 成功路径需控制器存在且工作区匹配（旧数据 cwd 回退口径）才放行。
    beforeEach(() => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl-1', type: 'local' }),
      } as never);
      vi.mocked(ControllerWorkspace.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue([{ path: '/home/user/project' }]),
      } as never);
    });

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
        token: 'new-mcp-token',
        serverNames: ['fluentui-mcp'],
      });

      await sessionService.resume('sess-1', 'user-1');

      expect(mcpEndpointService.reissueEndpoint).toHaveBeenCalledWith('sess-1', 'user-1');
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'session:command',
        expect.stringContaining('"mcpEndpoint":{"token":"new-mcp-token","serverNames":["fluentui-mcp"]}'),
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

    it('should include initial modeId/modelId in acp:resume when provided', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(
          mockSessionDoc({ status: 'ended', externalSessionId: 'ext-123' }),
        ),
      } as never);

      await sessionService.resume('sess-1', 'user-1', { modeId: 'code', modelId: 'gpt-5' });

      // 工作流节点 rework/兜底 resume：初始 mode/model 必须随 acp:resume 带内下发，
      // 由 bridge 在首条 prompt 前应用（setMode/setModel 的 idling 守卫在此阶段恒丢弃）
      const resumeCall = mockRedis.publish.mock.calls.find((c) => String(c[1]).includes('"type":"acp:resume"'));
      expect(String(resumeCall?.[1])).toContain('"modeId":"code"');
      expect(String(resumeCall?.[1])).toContain('"modelId":"gpt-5"');
    });

    it('should omit modeId/modelId in acp:resume when not provided', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(
          mockSessionDoc({ status: 'ended', externalSessionId: 'ext-123' }),
        ),
      } as never);

      await sessionService.resume('sess-1', 'user-1');

      const resumeCall = mockRedis.publish.mock.calls.find((c) => String(c[1]).includes('"type":"acp:resume"'));
      expect(String(resumeCall?.[1])).not.toContain('modeId');
      expect(String(resumeCall?.[1])).not.toContain('modelId');
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
      expect(Session.updateOne).toHaveBeenCalledWith({ _id: 'sess-1', userId: 'user-1' }, { currentModeId: 'mode-1' });
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
      expect(Session.updateOne).toHaveBeenCalledWith({ _id: 'sess-1', userId: 'user-1' }, { currentModelId: 'model-1' });
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

      expect(mcpEndpointService.createEndpoint).toHaveBeenCalledWith(
        'sess-1',
        'user-1',
        ['server-1', 'mcp-preview-tools'],
        {
          instanceId: 'inst-1',
          nodeId: 'node-1',
        },
        [],
      );
    });

    it('findAllByUser should exclude workflow sessions by default', async () => {
      vi.mocked(Session.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
      } as never);

      await sessionService.findAllByUser('user-1');
      expect(Session.find).toHaveBeenCalledWith({ userId: 'user-1', workflowInstanceId: null, archivedAt: null });
    });

    it('findAllByUser should include workflow sessions when includeWorkflowSessions=true', async () => {
      vi.mocked(Session.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
      } as never);

      await sessionService.findAllByUser('user-1', { includeWorkflowSessions: true });
      expect(Session.find).toHaveBeenCalledWith({ userId: 'user-1', archivedAt: null });
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

  describe('onSessionRemoved callback', () => {
    it('notifySessionRemoved should invoke registered callback', async () => {
      const callback = vi.fn();
      sessionService.onSessionRemoved(callback);

      await sessionService.notifySessionRemoved('sess-1');

      expect(callback).toHaveBeenCalledWith('sess-1');
    });
  });

  describe('onSessionIdled callback', () => {
    it('notifySessionIdled should invoke registered callback', async () => {
      const callback = vi.fn();
      sessionService.onSessionIdled(callback);

      await sessionService.notifySessionIdled('sess-1');

      expect(callback).toHaveBeenCalledWith('sess-1');
    });
  });

  describe('cloud host guards', () => {
    // 会话管理优化：本地会话写路径新增「项目工作区缺失」判定（旧数据 cwd 回退匹配），
    // 运行环境完好的用例需存在匹配工作区才放行。
    beforeEach(() => {
      vi.mocked(ControllerWorkspace.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue([{ path: '/home/user/project' }]),
      } as never);
    });

    it('rejects createSession on a non-RUNNING cloud host', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl-1', type: 'cloud', name: 'cloud' }),
      } as never);
      vi.mocked(CloudHost.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ status: 'STARTING' }),
      } as never);

      await expect(
        sessionService.create('user-1', {
          controllerId: 'ctrl-1',
          acpServerType: 'opencode',
          workspaceId: 'ws-1',
        }),
      ).rejects.toThrow('cloud host is not running');
    });

    it('T-SS-TEAM: 工作区上下文内按工作区查询云电脑（成员可在他人的云电脑上建会话）', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl-1', type: 'cloud', name: 'cloud' }),
      } as never);
      vi.mocked(CloudHost.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ status: 'STARTING' }),
      } as never);

      await expect(
        runWithWorkspace(
          {
            id: 'ws-team',
            tenantId: 'tenant-team',
            type: 'normal',
            role: 'developer',
            readOnly: false,
            globalWorkspaceId: 'ws-global',
          },
          () =>
            sessionService.create('user-1', {
              controllerId: 'ctrl-1',
              acpServerType: 'opencode',
              workspaceId: 'ws-1',
            }),
        ),
      ).rejects.toThrow('cloud host is not running');

      expect(CloudHost.findOne).toHaveBeenCalledWith({
        controllerId: 'ctrl-1',
        deletedAt: null,
      });
    });

    it('rejects createSession for an ACP type outside the cloud host harnessTypes', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl-1', type: 'cloud', name: 'cloud' }),
      } as never);
      vi.mocked(CloudHost.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ status: 'RUNNING', harnessTypes: ['OPENCODE'] }),
      } as never);

      await expect(
        sessionService.create('user-1', {
          controllerId: 'ctrl-1',
          acpServerType: 'claude_code',
          workspaceId: 'ws-1',
        }),
      ).rejects.toThrow('unsupported harness type: claude_code');
      expect(Session.create).not.toHaveBeenCalled();
    });

    it('T-MAP2: A-11 会话工具 ∈ 创建时所选 harnessTypes（deepseek_harness 生效）', async () => {
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl-1', type: 'cloud', name: 'cloud' }),
      } as never);
      vi.mocked(CloudHost.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ status: 'RUNNING', harnessTypes: ['DEEPSEEK_HARNESS'] }),
      } as never);
      vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ path: '/home/user/project' }),
      } as never);
      vi.mocked(McpServer.countDocuments).mockResolvedValue(1 as never);
      vi.mocked(Session.create).mockResolvedValue(mockSessionDoc() as never);

      await expect(
        sessionService.create('user-1', {
          controllerId: 'ctrl-1',
          acpServerType: 'deepseek_harness',
          workspaceId: 'ws-1',
        }),
      ).resolves.toBeDefined();

      await expect(
        sessionService.create('user-1', {
          controllerId: 'ctrl-1',
          acpServerType: 'kimi_code',
          workspaceId: 'ws-1',
        }),
      ).rejects.toThrow('unsupported harness type: kimi_code');
    });

    it('A-2 rejects send/cancel writes to a stopped cloud host session', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'ended' })),
      } as never);
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl-1', type: 'cloud' }),
      } as never);
      vi.mocked(CloudHost.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ status: 'STOPPED' }),
      } as never);

      await expect(sessionService.assertSessionWritable('sess-1', 'user-1')).rejects.toThrow(
        'session is ended',
      );
      await expect(sessionService.cancelGeneration('sess-1', 'user-1')).rejects.toThrow(
        'session is ended',
      );
      expect(mockRedis.publish).not.toHaveBeenCalled();
    });

    it('keeps normal ended sessions writable', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'ended' })),
      } as never);
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl-1', type: 'local' }),
      } as never);

      await expect(
        sessionService.assertSessionWritable('sess-1', 'user-1'),
      ).resolves.toBeUndefined();
      expect(CloudHost.findOne).not.toHaveBeenCalled();
    });

    it('rejects resume when cloud host is stopped', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'ended' })),
      } as never);
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl-1', type: 'cloud' }),
      } as never);
      vi.mocked(CloudHost.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ status: 'STOPPED' }),
      } as never);

      const result = await sessionService.resume('sess-1', 'user-1');

      expect(result).toEqual({ success: false, status: 'ended', error: 'session is ended' });
      expect(mockRedis.publish).not.toHaveBeenCalled();
    });

    it('keeps normal ended sessions resumable', async () => {
      vi.mocked(Session.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockSessionDoc({ status: 'ended' })),
      } as never);
      vi.mocked(Controller.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ _id: 'ctrl-1', type: 'local' }),
      } as never);
      vi.mocked(mcpEndpointService.reissueEndpoint).mockResolvedValue(undefined as never);

      const result = await sessionService.resume('sess-1', 'user-1');

      expect(result.success).toBe(true);
      expect(mockRedis.publish).toHaveBeenCalled();
      expect(CloudHost.findOne).not.toHaveBeenCalled();
    });
  });
});

describe('SessionService - capability snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
  });

  it('T-SS1: mapSession 含快照时原样返回，无快照返回 null', async () => {
    const snapshot = {
      protocolVersion: 1,
      agentInfo: { name: 'OpenCode', version: '2.0.31' },
      features: [{ id: 'session.load', status: 'supported', detail: null }],
      raw: { agentCapabilities: {}, authMethods: [], clientCapabilities: {} },
    };
    vi.mocked(Session.findOne).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockSessionDoc({ agentCapabilities: snapshot })),
    } as never);

    const withSnapshot = await sessionService.findById('sess-1', 'user-1');
    expect(withSnapshot!.agentCapabilities).toEqual(snapshot);

    vi.mocked(Session.findOne).mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockSessionDoc()),
    } as never);
    const withoutSnapshot = await sessionService.findById('sess-1', 'user-1');
    expect(withoutSnapshot!.agentCapabilities).toBeNull();
  });
});

describe('resolveInitialMcpServerIds', () => {
  const enabled = ['srv-a', 'srv-b'];

  it('returns explicit ids as-is (including an explicit empty array)', () => {
    expect(resolveInitialMcpServerIds({ useAllEnabled: true }, ['srv-x'], enabled)).toEqual([
      'srv-x',
    ]);
    expect(resolveInitialMcpServerIds({ useAllEnabled: true }, [], enabled)).toEqual([]);
  });

  it('injects every enabled server when useAllEnabled is missing or true', () => {
    expect(resolveInitialMcpServerIds(undefined, undefined, enabled)).toEqual(enabled);
    expect(resolveInitialMcpServerIds({ useAllEnabled: true }, undefined, enabled)).toEqual(enabled);
  });

  it('keeps only the still-enabled subset when useAllEnabled=false', () => {
    expect(
      resolveInitialMcpServerIds(
        { useAllEnabled: false, serverIds: ['srv-a', 'srv-disabled', 'srv-deleted'] },
        undefined,
        enabled,
      ),
    ).toEqual(['srv-a']);
  });

  it('accepts ObjectId-like serverIds from Mongo lean (regression: 真实 DB 子集不再被清空)', () => {
    expect(
      resolveInitialMcpServerIds(
        {
          useAllEnabled: false,
          serverIds: [
            { toString: () => 'srv-a' },
            { toString: () => 'srv-disabled' },
            null,
          ],
        },
        undefined,
        enabled,
      ),
    ).toEqual(['srv-a']);
  });

  it('returns an empty list when the configured subset is fully disabled', () => {
    expect(
      resolveInitialMcpServerIds(
        { useAllEnabled: false, serverIds: ['srv-disabled'] },
        undefined,
        enabled,
      ),
    ).toEqual([]);
  });
});

describe('SessionService.create default MCP injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
    vi.mocked(Session.updateOne).mockResolvedValue({ acknowledged: true } as never);
    vi.mocked(mcpEndpointService.createEndpoint).mockResolvedValue({
      token: 'tok',
      serverNames: ['agent-session-preview-tools'],
    } as never);
    vi.mocked(McpServer.find).mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([]),
    } as never);
  });

  const controller = {
    _id: oid('ctrl-1'),
    userId: oid('user-1'),
    name: 'Local',
    type: 'local',
    defaultMcp: { useAllEnabled: true },
  };

  function setupCreateMocks() {
    vi.mocked(Controller.findOne).mockReturnValue({ lean: vi.fn().mockResolvedValue(controller) } as never);
    vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: oid('ws-1'), path: '/workspace' }),
    } as never);
    vi.mocked(Session.create).mockResolvedValue({ _id: oid('sess-1'), toObject: () => ({
      _id: oid('sess-1'),
      userId: oid('user-1'),
      controllerId: oid('ctrl-1'),
      controllerName: 'Local',
      acpServerType: 'opencode',
      status: 'creating',
      title: null,
      cwd: '/workspace',
      createdAt: new Date(),
      updatedAt: new Date(),
    }) } as never);
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
  }

  it('creates an endpoint with all enabled MCP servers when mcpServerIds is omitted', async () => {
    setupCreateMocks();
    vi.mocked(McpServer.find).mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([{ _id: 'srv-a' }, { _id: 'srv-b' }]),
    } as never);
    vi.mocked(McpServer.countDocuments).mockResolvedValue(2 as never);
    vi.mocked(mcpEndpointService.createEndpoint).mockResolvedValue({
      token: 'tok',
      serverNames: ['a', 'b'],
    } as never);

    await sessionService.create('user-1', {
      controllerId: 'ctrl-1',
      acpServerType: 'opencode',
      workspaceId: 'ws-1',
    });

    expect(McpServer.find).toHaveBeenCalledWith({
      userId: 'user-1',
      enabled: true,
      name: { $nin: ['agent-cloud-host-tools', 'agent-session-preview-tools'] },
    });
    expect(mcpEndpointService.createEndpoint).toHaveBeenCalledWith(
      'sess-1',
      'user-1',
      ['srv-a', 'srv-b', 'mcp-preview-tools'],
      undefined,
      [],
    );
  });

  it('explicit empty array skips default resolution but still assembles preview tools（T-SPT6）', async () => {
    setupCreateMocks();
    vi.mocked(mcpEndpointService.createEndpoint).mockResolvedValue({
      token: 'tok',
      serverNames: ['agent-session-preview-tools'],
    } as never);

    await sessionService.create('user-1', {
      controllerId: 'ctrl-1',
      acpServerType: 'opencode',
      workspaceId: 'ws-1',
      mcpServerIds: [],
    });

    expect(McpServer.find).not.toHaveBeenCalled();
    expect(mcpEndpointService.createEndpoint).toHaveBeenCalledWith(
      'sess-1',
      'user-1',
      ['mcp-preview-tools'],
      undefined,
      [],
    );
  });

  it('skips disabled servers listed in the controller default subset', async () => {
    setupCreateMocks();
    vi.mocked(Controller.findOne).mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        ...controller,
        defaultMcp: { useAllEnabled: false, serverIds: ['srv-a', 'srv-disabled'] },
      }),
    } as never);
    vi.mocked(McpServer.find).mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([{ _id: 'srv-a' }]),
    } as never);
    vi.mocked(McpServer.countDocuments).mockResolvedValue(1 as never);
    vi.mocked(mcpEndpointService.createEndpoint).mockResolvedValue({
      token: 'tok',
      serverNames: ['a'],
    } as never);

    await sessionService.create('user-1', {
      controllerId: 'ctrl-1',
      acpServerType: 'opencode',
      workspaceId: 'ws-1',
    });

    expect(McpServer.countDocuments).toHaveBeenCalledWith({
      _id: { $in: ['srv-a'] },
      userId: 'user-1',
      enabled: true,
    });
  });
});

// ---------------------------------------------------------------------------
// 会话状态通用通道（T-SES1）：onSessionStatus / notifySessionStatus / getSessionStatusRaw
// ---------------------------------------------------------------------------

describe('SessionService.onSessionStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-SES1: 注册与分发；未注册时静默；注销后不再触发', async () => {
    const listener = vi.fn();
    const event = { sessionId: 'sess-1', status: 'idling' };

    // 未注册时静默
    await expect(sessionService.notifySessionStatus(event)).resolves.toBeUndefined();

    const unsubscribe = sessionService.onSessionStatus(listener);
    await sessionService.notifySessionStatus({ ...event, promptCompleted: true, error: 'BOOM' });
    expect(listener).toHaveBeenCalledWith({ sessionId: 'sess-1', status: 'idling', promptCompleted: true, error: 'BOOM' });

    unsubscribe();
    await sessionService.notifySessionStatus(event);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('T-SES1b: 监听器抛错只告警，不影响其他监听器', async () => {
    const bad = vi.fn().mockRejectedValue(new Error('boom'));
    const good = vi.fn();
    const offBad = sessionService.onSessionStatus(bad);
    const offGood = sessionService.onSessionStatus(good);
    try {
      await expect(sessionService.notifySessionStatus({ sessionId: 'sess-1', status: 'idling' })).resolves.toBeUndefined();
      expect(good).toHaveBeenCalled();
    } finally {
      offBad();
      offGood();
    }
  });

  it('T-SES1c: getSessionStatusRaw 直读会话状态，缺失返回 null', async () => {
    vi.mocked(Session.findById).mockReturnValue({
      select: vi.fn(() => ({ lean: vi.fn(async () => ({ status: 'idling' })) })),
    } as never);
    await expect(sessionService.getSessionStatusRaw('sess-1')).resolves.toBe('idling');
    expect(Session.findById).toHaveBeenCalledWith('sess-1');

    vi.mocked(Session.findById).mockReturnValue({
      select: vi.fn(() => ({ lean: vi.fn(async () => null) })),
    } as never);
    await expect(sessionService.getSessionStatusRaw('sess-x')).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 会话管理优化（T-ARCH / T-RO / T-WSARC）：归档、统一只读判定、工作区删除连带归档
// ---------------------------------------------------------------------------

/** `find/findOne(...).lean()` 链式 mock */
function leanQuery(value: unknown) {
  return { lean: vi.fn().mockResolvedValue(value) } as never;
}

const workspaceTarget = {
  _id: 'ws-1',
  controllerId: 'ctrl-1',
  path: '/home/user/project',
  name: 'project',
};

/** 精确匹配与旧数据回退两次 `Session.find` 的返回序列 */
function mockMatchResults(exact: unknown[], legacy: unknown[]) {
  vi.mocked(Session.find)
    .mockReturnValueOnce(leanQuery(exact))
    .mockReturnValueOnce(leanQuery(legacy));
}

describe('SessionService 归档（T-ARCH1~4）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
    vi.mocked(Session.updateOne).mockResolvedValue({ acknowledged: true } as never);
  });

  it('T-ARCH1: 归档/取消归档往返（archivedAt 置位/置空），重复操作幂等', async () => {
    vi.mocked(Session.findOne).mockReturnValue(leanQuery(mockSessionDoc()));

    await expect(sessionService.setArchived('user-1', 'sess-1', true)).resolves.toBe(true);
    expect(Session.updateOne).toHaveBeenCalledWith(
      { _id: 'sess-1', userId: 'user-1' },
      { $set: { archivedAt: expect.any(Date) } },
    );

    await expect(sessionService.setArchived('user-1', 'sess-1', false)).resolves.toBe(true);
    expect(Session.updateOne).toHaveBeenLastCalledWith(
      { _id: 'sess-1', userId: 'user-1' },
      { $set: { archivedAt: null } },
    );

    // 幂等：重复归档结果一致、不报错
    await expect(sessionService.setArchived('user-1', 'sess-1', true)).resolves.toBe(true);
    expect(Session.updateOne).toHaveBeenCalledTimes(3);
  });

  it('T-ARCH2: 他人会话 Session not found；节点会话 ARCHIVE_WORKFLOW_SESSION_UNSUPPORTED 且不写库', async () => {
    vi.mocked(Session.findOne).mockReturnValue(leanQuery(null));
    await expect(sessionService.setArchived('user-2', 'sess-1', true)).rejects.toThrow(
      'Session not found',
    );
    expect(Session.updateOne).not.toHaveBeenCalled();

    vi.mocked(Session.findOne).mockReturnValue(
      leanQuery(mockSessionDoc({ workflowInstanceId: oid('inst-1'), workflowNodeId: 'n1' })),
    );
    await expect(sessionService.setArchived('user-1', 'sess-1', true)).rejects.toThrow(
      'ARCHIVE_WORKFLOW_SESSION_UNSUPPORTED',
    );
    expect(Session.updateOne).not.toHaveBeenCalled();
  });

  it('T-ARCH3: mapSession 输出 archived 映射正确，不透出 archivedAt 原文', async () => {
    vi.mocked(Session.findOne).mockReturnValue(
      leanQuery(mockSessionDoc({ archivedAt: new Date('2026-11-05T00:00:00Z') })),
    );
    const archived = await sessionService.findById('sess-1', 'user-1');
    expect(archived!.archived).toBe(true);
    expect(archived).not.toHaveProperty('archivedAt');

    vi.mocked(Session.findOne).mockReturnValue(leanQuery(mockSessionDoc({ archivedAt: null })));
    const active = await sessionService.findById('sess-1', 'user-1');
    expect(active!.archived).toBe(false);
    expect(active).not.toHaveProperty('archivedAt');
  });

  it('T-ARCH4: findAllByUser(archived) 三档口径（默认活跃 / 仅已归档 / 与 includeWorkflowSessions 正交）', async () => {
    vi.mocked(Session.find).mockReturnValue({
      sort: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    } as never);

    await sessionService.findAllByUser('user-1');
    expect(Session.find).toHaveBeenLastCalledWith({
      userId: 'user-1',
      workflowInstanceId: null,
      archivedAt: null,
    });

    await sessionService.findAllByUser('user-1', { archived: true });
    expect(Session.find).toHaveBeenLastCalledWith({
      userId: 'user-1',
      workflowInstanceId: null,
      archivedAt: { $ne: null },
    });

    await sessionService.findAllByUser('user-1', { archived: true, includeWorkflowSessions: true });
    expect(Session.find).toHaveBeenLastCalledWith({
      userId: 'user-1',
      archivedAt: { $ne: null },
    });

    await sessionService.findAllByUser('user-1', { archived: false, controllerId: 'ctrl-1' });
    expect(Session.find).toHaveBeenLastCalledWith({
      userId: 'user-1',
      workflowInstanceId: null,
      archivedAt: null,
      controllerId: 'ctrl-1',
    });
  });
});

describe('SessionService 统一只读判定（T-RO1~7）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
    vi.mocked(Session.findOne).mockReturnValue(leanQuery(mockSessionDoc({ status: 'ended' })));
    vi.mocked(ControllerWorkspace.find).mockReturnValue(leanQuery([]));
  });

  it('T-RO1: 控制器缺失（unbind 删除）→ 写路径拒绝 session is ended', async () => {
    vi.mocked(Controller.findOne).mockReturnValue(leanQuery(null));

    await expect(sessionService.assertSessionWritable('sess-1', 'user-1')).rejects.toThrow(
      'session is ended',
    );
    await expect(sessionService.cancelGeneration('sess-1', 'user-1')).rejects.toThrow(
      'session is ended',
    );
    expect(mockRedis.publish).not.toHaveBeenCalled();
  });

  it('T-RO2: 云电脑三终态 + host 缺失/软删（回归）拒绝，RUNNING 放行', async () => {
    vi.mocked(Controller.findOne).mockReturnValue(
      leanQuery({ _id: 'ctrl-1', type: 'cloud' }),
    );

    for (const status of ['STOPPING', 'STOPPED', 'FAILED']) {
      vi.mocked(CloudHost.findOne).mockReturnValue(leanQuery({ status }));
      await expect(sessionService.assertSessionWritable('sess-1', 'user-1')).rejects.toThrow(
        'session is ended',
      );
    }

    // 软删除：查询带 deletedAt:null 过滤后为空
    vi.mocked(CloudHost.findOne).mockReturnValue(leanQuery(null));
    await expect(sessionService.assertSessionWritable('sess-1', 'user-1')).rejects.toThrow(
      'session is ended',
    );

    vi.mocked(CloudHost.findOne).mockReturnValue(leanQuery({ status: 'RUNNING' }));
    await expect(sessionService.assertSessionWritable('sess-1', 'user-1')).resolves.toBeUndefined();
    expect(ControllerWorkspace.find).not.toHaveBeenCalled();
  });

  it('T-RO3: 工作区缺失拒绝（controllerWorkspaceId 精确判定），存在则放行', async () => {
    const workspaceRef = oid('ws-1');
    vi.mocked(Controller.findOne).mockReturnValue(leanQuery({ _id: 'ctrl-1', type: 'local' }));
    vi.mocked(Session.findOne).mockReturnValue(
      leanQuery(mockSessionDoc({ status: 'ended', controllerWorkspaceId: workspaceRef })),
    );

    vi.mocked(ControllerWorkspace.exists).mockResolvedValue(null);
    await expect(sessionService.assertSessionWritable('sess-1', 'user-1')).rejects.toThrow(
      'session is ended',
    );
    expect(ControllerWorkspace.exists).toHaveBeenCalledWith({
      _id: workspaceRef,
      userId: 'user-1',
    });
    // 精确口径命中时不走 cwd 回退
    expect(ControllerWorkspace.find).not.toHaveBeenCalled();

    vi.mocked(ControllerWorkspace.exists).mockResolvedValue({ _id: 'ws-1' } as never);
    await expect(sessionService.assertSessionWritable('sess-1', 'user-1')).resolves.toBeUndefined();
  });

  it('T-RO4: 旧数据 cwd 等值/前缀回退——无匹配拒绝、等值与子目录放行、异路径拒绝', async () => {
    const sessionDoc = mockSessionDoc({ status: 'ended', cwd: '/home/user/project' });
    vi.mocked(Controller.findOne).mockReturnValue(leanQuery({ _id: 'ctrl-1', type: 'local' }));
    vi.mocked(Session.findOne).mockReturnValue(leanQuery(sessionDoc));

    vi.mocked(ControllerWorkspace.find).mockReturnValue(leanQuery([]));
    await expect(sessionService.assertSessionWritable('sess-1', 'user-1')).rejects.toThrow(
      'session is ended',
    );
    expect(ControllerWorkspace.find).toHaveBeenCalledWith({
      controllerId: sessionDoc.controllerId,
      userId: 'user-1',
    });

    vi.mocked(ControllerWorkspace.find).mockReturnValue(
      leanQuery([{ path: '/home/user/project' }]),
    );
    await expect(sessionService.assertSessionWritable('sess-1', 'user-1')).resolves.toBeUndefined();

    vi.mocked(ControllerWorkspace.find).mockReturnValue(leanQuery([{ path: '/home/user' }]));
    await expect(sessionService.assertSessionWritable('sess-1', 'user-1')).resolves.toBeUndefined();

    // 前缀必须带路径分隔符：/home/user/project2 不得误判为父目录
    vi.mocked(ControllerWorkspace.find).mockReturnValue(
      leanQuery([{ path: '/home/user/project2' }]),
    );
    await expect(sessionService.assertSessionWritable('sess-1', 'user-1')).rejects.toThrow(
      'session is ended',
    );
  });

  it('T-RO5: 工作区存在放行；worktree 旧数据（worktreePath != null）无法判定放行不误伤', async () => {
    vi.mocked(Controller.findOne).mockReturnValue(leanQuery({ _id: 'ctrl-1', type: 'local' }));

    // 工作区存在（旧数据 cwd 匹配）
    vi.mocked(Session.findOne).mockReturnValue(
      leanQuery(mockSessionDoc({ status: 'ended', cwd: '/home/user/project' })),
    );
    vi.mocked(ControllerWorkspace.find).mockReturnValue(
      leanQuery([{ path: '/home/user/project' }]),
    );
    await expect(sessionService.assertSessionWritable('sess-1', 'user-1')).resolves.toBeUndefined();

    // worktree 旧数据：无法可靠判定 → 放行，且不发起工作区查询
    vi.mocked(Session.findOne).mockReturnValue(
      leanQuery(
        mockSessionDoc({
          status: 'ended',
          cwd: '/worktrees/project/feat-abc',
          worktreePath: '/worktrees/project/feat-abc',
        }),
      ),
    );
    vi.mocked(ControllerWorkspace.find).mockClear();
    vi.mocked(ControllerWorkspace.exists).mockClear();
    await expect(sessionService.assertSessionWritable('sess-1', 'user-1')).resolves.toBeUndefined();
    expect(ControllerWorkspace.find).not.toHaveBeenCalled();
    expect(ControllerWorkspace.exists).not.toHaveBeenCalled();
  });

  it('T-RO6: resolveSessionReadOnlyReason 四态映射（null / 三枚举）', async () => {
    const session = {
      controllerId: 'ctrl-1',
      controllerWorkspaceId: 'ws-1',
      cwd: '/home/user/project',
      worktreePath: null,
    };

    vi.mocked(Controller.findOne).mockReturnValue(leanQuery(null));
    await expect(sessionService.resolveSessionReadOnlyReason(session, 'user-1')).resolves.toBe(
      'CONTROLLER_MISSING',
    );

    vi.mocked(Controller.findOne).mockReturnValue(leanQuery({ _id: 'ctrl-1', type: 'cloud' }));
    vi.mocked(CloudHost.findOne).mockReturnValue(leanQuery({ status: 'STOPPED' }));
    await expect(sessionService.resolveSessionReadOnlyReason(session, 'user-1')).resolves.toBe(
      'CLOUD_HOST_DESTROYED',
    );

    vi.mocked(Controller.findOne).mockReturnValue(leanQuery({ _id: 'ctrl-1', type: 'github' }));
    vi.mocked(ControllerWorkspace.exists).mockResolvedValue(null);
    await expect(sessionService.resolveSessionReadOnlyReason(session, 'user-1')).resolves.toBe(
      'WORKSPACE_MISSING',
    );

    vi.mocked(ControllerWorkspace.exists).mockResolvedValue({ _id: 'ws-1' } as never);
    await expect(sessionService.resolveSessionReadOnlyReason(session, 'user-1')).resolves.toBeNull();
  });

  it('T-RO7: resume 收敛统一判定——门禁文案不变，控制器缺失/工作区缺失返回 session is ended', async () => {
    // 门禁：非 ended/disconnected 依旧拒绝
    vi.mocked(Session.findOne).mockReturnValue(leanQuery(mockSessionDoc({ status: 'running' })));
    await expect(sessionService.resume('sess-1', 'user-1')).resolves.toEqual({
      success: false,
      status: 'running',
      error: 'Session is not ended',
    });

    vi.mocked(Session.findOne).mockReturnValue(leanQuery(mockSessionDoc({ status: 'ended' })));

    // 控制器缺失
    vi.mocked(Controller.findOne).mockReturnValue(leanQuery(null));
    await expect(sessionService.resume('sess-1', 'user-1')).resolves.toEqual({
      success: false,
      status: 'ended',
      error: 'session is ended',
    });
    expect(mockRedis.publish).not.toHaveBeenCalled();

    // 工作区缺失（旧数据回退无匹配）
    vi.mocked(Controller.findOne).mockReturnValue(leanQuery({ _id: 'ctrl-1', type: 'local' }));
    vi.mocked(ControllerWorkspace.find).mockReturnValue(leanQuery([]));
    await expect(sessionService.resume('sess-1', 'user-1')).resolves.toEqual({
      success: false,
      status: 'ended',
      error: 'session is ended',
    });
    expect(mockRedis.publish).not.toHaveBeenCalled();
  });
});

describe('SessionService 工作区删除连带归档（T-WSARC1~3、T-WSARC5）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
    vi.mocked(Session.updateOne).mockResolvedValue({ acknowledged: true } as never);
    vi.mocked(Session.findOneAndUpdate).mockResolvedValue(mockSessionDoc() as never);
  });

  it('T-WSARC1: 精确匹配 + cwd 前缀/worktree scope 回退，查询层排除节点会话', async () => {
    const exact = {
      _id: oid('s-exact'),
      controllerWorkspaceId: oid('ws-1'),
      status: 'ended',
    };
    const root = {
      _id: oid('s-root'),
      controllerWorkspaceId: null,
      cwd: '/home/user/project/sub',
      worktreePath: null,
      status: 'ended',
    };
    const wt = {
      _id: oid('s-wt'),
      controllerWorkspaceId: null,
      cwd: '/worktrees/project/feat-abc',
      worktreePath: '/worktrees/project/feat-abc',
      status: 'ended',
    };
    const foreign = {
      _id: oid('s-foreign'),
      controllerWorkspaceId: null,
      cwd: '/home/other',
      worktreePath: '/worktrees/other/feat-x',
      status: 'ended',
    };
    mockMatchResults([exact], [root, wt, foreign]);
    vi.mocked(Controller.findOne).mockReturnValue(
      leanQuery({
        _id: 'ctrl-1',
        type: 'local',
        worktreeDir: '/worktrees',
        homeDir: '/home/user',
        platform: 'linux',
      }),
    );

    const matched = await sessionService.matchWorkspaceSessions(workspaceTarget, 'user-1');

    expect(matched.map((doc) => String(doc._id))).toEqual(['s-exact', 's-root', 's-wt']);
    // 两类匹配都在查询层排除工作流节点会话（D2）
    expect(Session.find).toHaveBeenNthCalledWith(1, {
      controllerId: 'ctrl-1',
      workflowInstanceId: null,
      userId: 'user-1',
      controllerWorkspaceId: 'ws-1',
    });
    expect(Session.find).toHaveBeenNthCalledWith(2, {
      controllerId: 'ctrl-1',
      workflowInstanceId: null,
      userId: 'user-1',
      controllerWorkspaceId: null,
    });
  });

  it('T-WSARC1b: homeDir 缺失时 worktree scope 退化（不按 scope 归组），worktree 旧数据不误伤', async () => {
    const wt = {
      _id: oid('s-wt'),
      controllerWorkspaceId: null,
      cwd: '~/.zag/worktrees/project/feat-abc',
      worktreePath: '~/.zag/worktrees/project/feat-abc',
      status: 'ended',
    };
    mockMatchResults([], [wt]);
    vi.mocked(Controller.findOne).mockReturnValue(
      leanQuery({ _id: 'ctrl-1', type: 'local', worktreeDir: '~/.zag/worktrees', homeDir: null }),
    );

    const matched = await sessionService.matchWorkspaceSessions(workspaceTarget, 'user-1');
    expect(matched).toEqual([]);
  });

  it('T-WSARC2: 非 ended 会话先 close（acp:stop + ended）后归档；已 ended 直接归档', async () => {
    const activeDoc = {
      _id: oid('sess-active'),
      userId: oid('user-1'),
      controllerId: oid('ctrl-1'),
      status: 'idling',
      cwd: '/home/user/project',
      archivedAt: null,
    };
    const endedDoc = { ...activeDoc, _id: oid('sess-ended'), status: 'ended' };
    mockMatchResults([activeDoc, endedDoc], []);
    vi.mocked(Session.findOne).mockReturnValue(
      leanQuery(mockSessionDoc({ _id: oid('sess-active'), status: 'idling' })),
    );
    vi.mocked(Session.updateMany).mockResolvedValue({ modifiedCount: 2 } as never);

    const count = await sessionService.archiveByWorkspace('user-1', workspaceTarget);

    // 先结束：仅非 ended 会话 close
    expect(Session.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(Session.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'sess-active', userId: 'user-1' },
      { status: 'ended', endedAt: expect.any(Date) },
    );
    expect(mockRedis.publish).toHaveBeenCalledTimes(1);
    expect(mockRedis.publish).toHaveBeenCalledWith(
      'session:command',
      expect.stringContaining('"type":"acp:stop"'),
    );
    expect(mockRedis.publish).toHaveBeenCalledWith(
      'session:command',
      expect.stringContaining('"reason":"workspace_deleted"'),
    );
    // 后归档：archivedAt:null 条件幂等
    expect(Session.updateMany).toHaveBeenCalledWith(
      {
        _id: { $in: [activeDoc._id, endedDoc._id] },
        archivedAt: null,
        userId: 'user-1',
      },
      { $set: { archivedAt: expect.any(Date) } },
    );
    expect(count).toBe(2);
  });

  it('T-WSARC3: 幂等——归档以 archivedAt:null 为条件，第二次执行零增量', async () => {
    const doc = {
      _id: oid('sess-1'),
      userId: oid('user-1'),
      controllerId: oid('ctrl-1'),
      status: 'ended',
      cwd: '/home/user/project',
      archivedAt: null,
    };
    vi.mocked(Session.updateMany)
      .mockResolvedValueOnce({ modifiedCount: 1 } as never)
      .mockResolvedValueOnce({ modifiedCount: 0 } as never);

    mockMatchResults([doc], []);
    await expect(sessionService.archiveByWorkspace('user-1', workspaceTarget)).resolves.toBe(1);

    mockMatchResults([doc], []);
    await expect(sessionService.archiveByWorkspace('user-1', workspaceTarget)).resolves.toBe(0);

    expect(Session.updateMany).toHaveBeenCalledTimes(2);
    expect(Session.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ archivedAt: null }),
      expect.anything(),
    );
    expect(Session.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ archivedAt: null }),
      expect.anything(),
    );
    // 已 ended 会话不重复 close
    expect(Session.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('T-WSARC5: close 单会话失败仅记录日志不阻断归档', async () => {
    const activeDoc = {
      _id: oid('sess-active'),
      userId: oid('user-1'),
      controllerId: oid('ctrl-1'),
      status: 'idling',
      cwd: '/home/user/project',
      archivedAt: null,
    };
    mockMatchResults([activeDoc], []);
    vi.mocked(Session.findOne).mockRejectedValue(new Error('db down') as never);
    vi.mocked(Session.updateMany).mockResolvedValue({ modifiedCount: 1 } as never);
    testLog.reset();

    await expect(sessionService.archiveByWorkspace('user-1', workspaceTarget)).resolves.toBe(1);

    expect(Session.updateMany).toHaveBeenCalled();
    const record = testLog.records.find(
      (r) => r.level === 'error' && r.event === 'close-session-before-archive-failed',
    );
    expect(record).toBeDefined();
    expect(String(record?.sessionId)).toBe('sess-active');
  });
});

// ---------------------------------------------------------------------------
// addMessage 多片段输入（T-PARTS1~5，裁决 6/8）
// ---------------------------------------------------------------------------

describe('SessionService.addMessage parts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
    vi.mocked(AcpMessage.create).mockImplementation(async (doc: unknown) => ({
      toObject: () => ({ _id: 'msg-1', createdAt: new Date(), ...(doc as Record<string, unknown>) }),
    }) as never);
    vi.mocked(AcpMessage.countDocuments).mockResolvedValue(0 as never);
    vi.mocked(Session.findByIdAndUpdate).mockResolvedValue({} as never);
  });

  it('T-PARTS1 parts 过滤：trim 空文本片段被滤；全空抛 BAD_USER_INPUT(empty prompt)', async () => {
    await expect(
      sessionService.addMessage('sess-1', {
        direction: 'input',
        type: 'text',
        content: '',
        parts: [{ type: 'text', text: '   ' }, { type: 'text', text: '' }],
      }),
    ).rejects.toThrow('empty prompt');

    await expect(
      sessionService.addMessage('sess-1', {
        direction: 'input',
        type: 'text',
        content: '',
        parts: [],
      }),
    ).rejects.toThrow('empty prompt');

    expect(AcpMessage.create).not.toHaveBeenCalled();
  });

  it('T-PARTS2 持久化：content=合并文本(\\n\\n)、metadata.parts 全量含图片、标题取自合并文本', async () => {
    vi.mocked(AcpMessage.countDocuments).mockResolvedValue(1 as never);

    await sessionService.addMessage('sess-1', {
      direction: 'input',
      type: 'text',
      content: 'ignored',
      parts: [
        { type: 'text', text: 'a' },
        { type: 'image', data: 'BASE64', mimeType: 'image/png', name: 'shot.png' },
        { type: 'text', text: '   ' },
        { type: 'text', text: 'b' },
      ],
    });

    const doc = vi.mocked(AcpMessage.create).mock.calls[0][0] as Record<string, unknown>;
    expect(doc.content).toEqual({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'a\n\nb' },
    });
    expect(JSON.parse(doc.metadata as string)).toEqual({
      parts: [
        { type: 'text', text: 'a' },
        { type: 'image', data: 'BASE64', mimeType: 'image/png', name: 'shot.png' },
        { type: 'text', text: 'b' },
      ],
    });
    expect(Session.findByIdAndUpdate).toHaveBeenCalledWith('sess-1', { title: 'a\n\nb' });
  });

  it('T-PARTS3 发布：Redis session:message 载荷带 parts', async () => {
    await sessionService.addMessage('sess-1', {
      direction: 'input',
      type: 'text',
      content: '',
      parts: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'IMG', mimeType: 'image/png' },
      ],
    });

    const publishCall = mockRedis.publish.mock.calls.find((c) => c[0] === 'session:message');
    expect(publishCall).toBeTruthy();
    const payload = JSON.parse(String(publishCall![1])) as { message: { parts?: unknown[] } };
    expect(payload.message.parts).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'IMG', mimeType: 'image/png' },
    ]);
  });

  it('T-PARTS4 体积：parts JSON >12MB 拒绝', async () => {
    const huge = 'x'.repeat(13 * 1024 * 1024);
    await expect(
      sessionService.addMessage('sess-1', {
        direction: 'input',
        type: 'text',
        content: '',
        parts: [{ type: 'text', text: huge }],
      }),
    ).rejects.toThrow('prompt parts too large');
    expect(AcpMessage.create).not.toHaveBeenCalled();
  });

  it('T-PARTS5 兼容：无 parts 旧调用逐字不变（metadata 原样、发布不带 parts）', async () => {
    await sessionService.addMessage('sess-1', {
      direction: 'input',
      type: 'text',
      content: 'plain text',
      metadata: '{"k":1}',
    });

    const doc = vi.mocked(AcpMessage.create).mock.calls[0][0] as Record<string, unknown>;
    expect(doc.content).toEqual({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'plain text' },
    });
    expect(doc.metadata).toBe('{"k":1}');

    const publishCall = mockRedis.publish.mock.calls.find((c) => c[0] === 'session:message');
    const payload = JSON.parse(String(publishCall![1])) as { message: { parts?: unknown[] } };
    expect(payload.message.parts).toBeUndefined();
  });
});
