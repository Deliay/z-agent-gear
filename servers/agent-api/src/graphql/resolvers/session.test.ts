import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/session.js', () => ({
  sessionService: {
    findAllByUser: vi.fn(),
    findById: vi.fn(),
    getMessages: vi.fn(),
    getAcpCapabilities: vi.fn(),
    getAcpServerOptions: vi.fn(),
    create: vi.fn(),
    close: vi.fn(),
    delete: vi.fn(),
    addMessage: vi.fn(),
    cancelGeneration: vi.fn(),
    resume: vi.fn(),
    setMode: vi.fn(),
    setModel: vi.fn(),
    setConfigOption: vi.fn(),
    refreshAcpCapabilities: vi.fn(),
    refreshAcpServerOptions: vi.fn(),
    assertSessionWritable: vi.fn(),
    setArchived: vi.fn(),
    resolveSessionReadOnlyReason: vi.fn(),
    matchWorkspaceSessions: vi.fn(),
  },
}));

vi.mock('../../services/controller-workspace.js', () => ({
  controllerWorkspaceService: {
    findById: vi.fn(),
  },
}));

vi.mock('../../services/session-interaction-service.js', () => ({
  sessionInteractionService: {
    listBySession: vi.fn(),
  },
}));

vi.mock('../../services/session-import.js', () => ({
  sessionImportService: {
    listHistorySessions: vi.fn(),
    deleteHistorySession: vi.fn(),
    importSessions: vi.fn(),
  },
}));

vi.mock('../../services/model.js', () => ({
  modelService: {
    listSourceLibrary: vi.fn(),
  },
}));

vi.mock('../../services/cloud-host-service.js', () => ({
  cloudHostService: {
    mapCloudHost: vi.fn((host: Record<string, unknown>) => ({
      id: String(host._id),
      status: host.status,
      deletedAt: host.deletedAt ?? null,
    })),
  },
}));

vi.mock('../../models/controller.js', () => ({
  Controller: { findOne: vi.fn() },
}));

vi.mock('../../models/cloud-host.js', () => ({
  CloudHost: { findOne: vi.fn() },
}));

import { sessionResolvers } from './session.js';
import { sessionService } from '../../services/session.js';
import { sessionInteractionService } from '../../services/session-interaction-service.js';
import { controllerWorkspaceService } from '../../services/controller-workspace.js';
import { modelService } from '../../services/model.js';
import { Controller } from '../../models/controller.js';
import { CloudHost } from '../../models/cloud-host.js';
import { runWithWorkspace } from '../../services/workspace-context.js';
import type { AuthContext } from './auth.js';

function createContext(): AuthContext {
  return { currentUser: { id: 'user-1', username: 'u' } };
}

function chain(value: unknown) {
  return { lean: vi.fn().mockResolvedValue(value) } as never;
}

const context = { currentUser: { id: 'user-1' } } as never;
const parent = { controllerId: 'ctrl-1', userId: 'user-1' } as never;

describe('Session field resolvers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-SR1: features 返回快照内 features 的深拷贝', () => {
    const features = [{ id: 'session.load', status: 'supported', detail: null }];
    const session = { agentCapabilities: { features } };

    const result = sessionResolvers.Session.features(session);

    expect(result).toEqual(features);
    expect(result).not.toBe(features);
    result[0].id = 'mutated';
    expect(features[0].id).toBe('session.load');
  });

  it('T-SR2: 无快照/脏数据返回 []', () => {
    expect(sessionResolvers.Session.features({})).toEqual([]);
    expect(sessionResolvers.Session.features({ agentCapabilities: null })).toEqual([]);
    expect(sessionResolvers.Session.features({ agentCapabilities: { features: 'oops' } })).toEqual([]);
    expect(sessionResolvers.Session.agentCapabilities({})).toBeNull();
  });

  it('T-SR3: availableModels 按平台库/前缀/兜底分组', async () => {
    vi.mocked(modelService.listSourceLibrary).mockResolvedValue([
      { name: 'gpt-4o', scope: 'global' },
      { name: 'my-model', scope: 'user' },
    ]);

    const result = await sessionResolvers.Session.availableModels(
      {
        availableModels: [
          { id: 'gpt-4o', name: 'gpt-4o' },
          { id: 'my-model', name: 'my-model' },
          { id: 'opencode-go/kimi-k3', name: 'Kimi K3' },
          { id: 'local-llm', name: 'Local LLM' },
        ],
      },
      {},
      createContext(),
    );

    expect(result.map((m: { group: string }) => m.group)).toEqual([
      '平台内置',
      '自定义',
      'Agent 自带',
      '来源未知',
    ]);
    expect(result.map((m: { basis: string }) => m.basis)).toEqual([
      '按平台模型库比对（平台内置）',
      '按平台模型库比对（自定义）',
      '按标识前缀判定（opencode-go）',
      '无法判定',
    ]);
  });

  it('T-SR4: 同一 context 两次解析只调用一次 listSourceLibrary', async () => {
    vi.mocked(modelService.listSourceLibrary).mockResolvedValue([]);
    const ctx = createContext();
    const session = { availableModels: [{ id: 'a/b', name: 'B' }] };

    await sessionResolvers.Session.availableModels(session, {}, ctx);
    await sessionResolvers.Session.availableModels(session, {}, ctx);

    expect(modelService.listSourceLibrary).toHaveBeenCalledTimes(1);
  });

  it('T-SR5: 空 availableModels 不查库，返回 []', async () => {
    const result = await sessionResolvers.Session.availableModels(
      { availableModels: [] },
      {},
      createContext(),
    );

    expect(result).toEqual([]);
    expect(modelService.listSourceLibrary).not.toHaveBeenCalled();
  });
});

describe('sessionResolvers.Session cloud host read-only fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('D-1 controllerType returns the controller type without relying on controllers list', async () => {
    vi.mocked(Controller.findOne).mockReturnValue(
      chain({ type: 'cloud' }) as never,
    );

    await expect(
      sessionResolvers.Session.controllerType(parent, {}, context),
    ).resolves.toBe('cloud');
    expect(Controller.findOne).toHaveBeenCalledWith({ _id: 'ctrl-1', userId: 'user-1' });
  });

  it('D-1 cloudHost returns the soft-deleted host for read-only rendering', async () => {
    vi.mocked(Controller.findOne).mockReturnValue(chain({ type: 'cloud' }) as never);
    vi.mocked(CloudHost.findOne).mockReturnValue(
      chain({ _id: 'cloud-1', status: 'STOPPED', deletedAt: new Date() }) as never,
    );

    const result = await sessionResolvers.Session.cloudHost(parent, {}, context);

    expect(result).toMatchObject({ id: 'cloud-1', status: 'STOPPED' });
    expect((result as { deletedAt: Date | null }).deletedAt).toBeInstanceOf(Date);
    // 软删除留档必须可返回：不过滤 deletedAt
    expect(CloudHost.findOne).toHaveBeenCalledWith({
      controllerId: 'ctrl-1',
      userId: 'user-1',
    });
  });

  it('cloudHost returns null for non-cloud controllers', async () => {
    vi.mocked(Controller.findOne).mockReturnValue(chain({ type: 'local' }) as never);

    await expect(
      sessionResolvers.Session.cloudHost(parent, {}, context),
    ).resolves.toBeNull();
    expect(CloudHost.findOne).not.toHaveBeenCalled();
  });

  it('returns null without authentication', async () => {
    const anon = { currentUser: null } as never;
    await expect(sessionResolvers.Session.controllerType(parent, {}, anon)).resolves.toBeNull();
    await expect(sessionResolvers.Session.cloudHost(parent, {}, anon)).resolves.toBeNull();
  });

  it('T-SR-TEAM: 工作区上下文内不再按 userId 过滤（团队租户可查看他人创建的控制器）', async () => {
    vi.mocked(Controller.findOne).mockReturnValue(chain({ type: 'cloud' }) as never);
    vi.mocked(CloudHost.findOne).mockReturnValue(
      chain({ _id: 'cloud-1', status: 'RUNNING', deletedAt: null }) as never,
    );

    await runWithWorkspace(
      {
        id: 'ws-team',
        tenantId: 'tenant-team',
        type: 'global',
        role: 'admin',
        readOnly: false,
        globalWorkspaceId: 'ws-team',
      },
      async () => {
        await sessionResolvers.Session.controllerType(parent, {}, context);
        await sessionResolvers.Session.cloudHost(parent, {}, context);
      },
    );

    expect(Controller.findOne).toHaveBeenCalledWith({ _id: 'ctrl-1' });
    expect(CloudHost.findOne).toHaveBeenCalledWith({ controllerId: 'ctrl-1' });
  });
});

describe('sessionResolvers.Mutation.createSession', () => {
  const context = { currentUser: { id: 'user-1', username: 'u' } } as never;
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('treats an explicit empty mcpServerIds array as "no MCP"', async () => {
    vi.mocked(sessionService.create).mockResolvedValue({ id: 'sess-1' } as never);

    await sessionResolvers.Mutation.createSession(
      {},
      {
        input: {
          controllerId: 'ctrl-1',
          acpServerType: 'opencode',
          workspaceId: 'ws-1',
          mcpServerIds: [],
        },
      },
      context,
    );

    expect(sessionService.create).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ mcpServerIds: [] }),
    );
  });

  it('passes undefined when mcpServerIds is omitted so controller defaults apply', async () => {
    vi.mocked(sessionService.create).mockResolvedValue({ id: 'sess-1' } as never);

    await sessionResolvers.Mutation.createSession(
      {},
      { input: { controllerId: 'ctrl-1', acpServerType: 'opencode', workspaceId: 'ws-1' } },
      context,
    );

    const arg = vi.mocked(sessionService.create).mock.calls[0][1] as Record<string, unknown>;
    expect(arg.mcpServerIds).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(arg, 'mcpServerIds')).toBe(true);
  });

  it('forwards customMcpServerIds (null normalized to undefined)', async () => {
    vi.mocked(sessionService.create).mockResolvedValue({ id: 'sess-1' } as never);

    await sessionResolvers.Mutation.createSession(
      {},
      {
        input: {
          controllerId: 'ctrl-1',
          acpServerType: 'opencode',
          workspaceId: 'ws-1',
          customMcpServerIds: ['64b0000000000000000000c1'],
        },
      },
      context,
    );

    expect(sessionService.create).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ customMcpServerIds: ['64b0000000000000000000c1'] }),
    );
  });

  it('forwards modeId/modelId and normalizes null to undefined', async () => {
    vi.mocked(sessionService.create).mockResolvedValue({ id: 'sess-1' } as never);

    await sessionResolvers.Mutation.createSession(
      {},
      {
        input: {
          controllerId: 'ctrl-1',
          acpServerType: 'opencode',
          workspaceId: 'ws-1',
          modeId: 'plan',
          modelId: null,
        },
      },
      context,
    );

    expect(sessionService.create).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ modeId: 'plan', modelId: undefined }),
    );
  });
});

describe('sessionResolvers.Mutation.refreshAcpServerOptions', () => {
  const context = { currentUser: { id: 'user-1', username: 'u' } } as never;

  it('delegates to the service with the authenticated user', async () => {
    vi.mocked(sessionService.refreshAcpServerOptions).mockResolvedValue({
      modes: [],
      models: [],
      currentModeId: null,
      currentModelId: null,
      probedAt: null,
    } as never);

    await sessionResolvers.Mutation.refreshAcpServerOptions(
      {},
      { controllerId: 'ctrl-1', acpServerType: 'opencode' },
      context,
    );

    expect(sessionService.refreshAcpServerOptions).toHaveBeenCalledWith(
      'ctrl-1',
      'opencode',
      'user-1',
    );
  });

  it('requires authentication', async () => {
    await expect(
      sessionResolvers.Mutation.refreshAcpServerOptions(
        {},
        { controllerId: 'ctrl-1', acpServerType: 'opencode' },
        { currentUser: null } as never,
      ),
    ).rejects.toThrow('Not authenticated');
  });
});

// ---------------------------------------------------------------------------
// 会话管理优化（T-RES1~3）：archiveSession / sessions(archived) / readOnlyReason /
// workspaceArchiveImpact
// ---------------------------------------------------------------------------

describe('sessionResolvers 会话归档与只读（T-RES1~3）', () => {
  const context = createContext();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-RES1: 未认证拒绝（archiveSession / workspaceArchiveImpact / sessions）', async () => {
    const anon = { currentUser: null } as never;

    await expect(
      sessionResolvers.Mutation.archiveSession({}, { id: 's-1', archived: true }, anon),
    ).rejects.toThrow('Not authenticated');
    await expect(
      sessionResolvers.Mutation.workspaceArchiveImpact({}, { id: 'ws-1' }, anon),
    ).rejects.toThrow('Not authenticated');
    await expect(sessionResolvers.Query.sessions({}, {}, anon)).rejects.toThrow(
      'Not authenticated',
    );
    expect(sessionService.setArchived).not.toHaveBeenCalled();
    expect(sessionService.findAllByUser).not.toHaveBeenCalled();
  });

  it('archiveSession 透传 userId/id/archived，服务层错误文案原样透传', async () => {
    vi.mocked(sessionService.setArchived).mockResolvedValue(true as never);
    await expect(
      sessionResolvers.Mutation.archiveSession({}, { id: 's-1', archived: true }, context),
    ).resolves.toBe(true);
    expect(sessionService.setArchived).toHaveBeenCalledWith('user-1', 's-1', true);

    vi.mocked(sessionService.setArchived).mockRejectedValue(new Error('Session not found'));
    await expect(
      sessionResolvers.Mutation.archiveSession({}, { id: 's-1', archived: true }, context),
    ).rejects.toThrow('Session not found');

    vi.mocked(sessionService.setArchived).mockRejectedValue(
      new Error('ARCHIVE_WORKFLOW_SESSION_UNSUPPORTED'),
    );
    await expect(
      sessionResolvers.Mutation.archiveSession({}, { id: 's-1', archived: true }, context),
    ).rejects.toThrow('ARCHIVE_WORKFLOW_SESSION_UNSUPPORTED');
  });

  it('T-RES2: Query.sessions 透传 archived（与 includeWorkflowSessions/controllerId 正交）', async () => {
    vi.mocked(sessionService.findAllByUser).mockResolvedValue([] as never);

    await sessionResolvers.Query.sessions(
      {},
      { archived: true, includeWorkflowSessions: true, controllerId: 'ctrl-1' },
      context,
    );
    expect(sessionService.findAllByUser).toHaveBeenCalledWith('user-1', {
      controllerId: 'ctrl-1',
      includeWorkflowSessions: true,
      archived: true,
    });

    await sessionResolvers.Query.sessions({}, {}, context);
    expect(sessionService.findAllByUser).toHaveBeenLastCalledWith('user-1', {
      controllerId: undefined,
      includeWorkflowSessions: undefined,
      archived: undefined,
    });
  });

  it('T-RES2b: workspaceArchiveImpact 与连带共用匹配函数，仅计未归档会话', async () => {
    vi.mocked(controllerWorkspaceService.findById).mockResolvedValue({
      id: 'ws-1',
      controllerId: 'ctrl-1',
      path: '/home/user/project',
      name: 'project',
    } as never);
    vi.mocked(sessionService.matchWorkspaceSessions).mockResolvedValue([
      { _id: 's-1', archivedAt: null },
      { _id: 's-2', archivedAt: new Date() },
      { _id: 's-3' },
    ] as never);

    await expect(
      sessionResolvers.Mutation.workspaceArchiveImpact({}, { id: 'ws-1' }, context),
    ).resolves.toEqual({ sessionCount: 2 });

    expect(sessionService.matchWorkspaceSessions).toHaveBeenCalledWith(
      { _id: 'ws-1', controllerId: 'ctrl-1', path: '/home/user/project', name: 'project' },
      'user-1',
    );

    vi.mocked(controllerWorkspaceService.findById).mockResolvedValue(null);
    await expect(
      sessionResolvers.Mutation.workspaceArchiveImpact({}, { id: 'ws-1' }, context),
    ).rejects.toThrow('Workspace not found');
  });

  it('T-RES3: Session.readOnlyReason 透出四态，未认证返回 null', async () => {
    vi.mocked(sessionService.resolveSessionReadOnlyReason).mockResolvedValue('WORKSPACE_MISSING');
    await expect(
      sessionResolvers.Session.readOnlyReason(parent, {}, context),
    ).resolves.toBe('WORKSPACE_MISSING');
    expect(sessionService.resolveSessionReadOnlyReason).toHaveBeenCalledWith(parent, 'user-1');

    vi.mocked(sessionService.resolveSessionReadOnlyReason).mockResolvedValue('CLOUD_HOST_DESTROYED');
    await expect(
      sessionResolvers.Session.readOnlyReason(parent, {}, context),
    ).resolves.toBe('CLOUD_HOST_DESTROYED');

    vi.mocked(sessionService.resolveSessionReadOnlyReason).mockResolvedValue(null);
    await expect(
      sessionResolvers.Session.readOnlyReason(parent, {}, context),
    ).resolves.toBeNull();

    await expect(
      sessionResolvers.Session.readOnlyReason(parent, {}, { currentUser: null } as never),
    ).resolves.toBeNull();
    expect(sessionService.resolveSessionReadOnlyReason).toHaveBeenCalledTimes(3);
  });
});

describe('Query.sessionInteractions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('未认证抛 Not authenticated', async () => {
    await expect(
      sessionResolvers.Query.sessionInteractions({}, { sessionId: 'sess-1' }, { currentUser: null } as never),
    ).rejects.toThrow('Not authenticated');
  });

  it('非归属会话抛 Session not found（不查交互）', async () => {
    vi.mocked(sessionService.findById).mockResolvedValue(null);
    await expect(
      sessionResolvers.Query.sessionInteractions({}, { sessionId: 'sess-1' }, context),
    ).rejects.toThrow('Session not found');
    expect(sessionInteractionService.listBySession).not.toHaveBeenCalled();
  });

  it('归属校验用 sessionService.findById(userId)；只读会话放行并按 createdAt 升序返回', async () => {
    vi.mocked(sessionService.findById).mockResolvedValue({ id: 'sess-1' } as never);
    const rows = [
      { id: 'i-1', interactionId: 'req-1', status: 'ACCEPTED' },
      { id: 'i-2', interactionId: 'req-2', status: 'PENDING' },
    ];
    vi.mocked(sessionInteractionService.listBySession).mockResolvedValue(rows as never);

    await expect(
      sessionResolvers.Query.sessionInteractions({}, { sessionId: 'sess-1' }, context),
    ).resolves.toEqual(rows);
    expect(sessionService.findById).toHaveBeenCalledWith('sess-1', 'user-1');
    expect(sessionInteractionService.listBySession).toHaveBeenCalledWith('sess-1');
  });
});
