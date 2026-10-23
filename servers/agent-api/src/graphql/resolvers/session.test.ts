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
import { modelService } from '../../services/model.js';
import { Controller } from '../../models/controller.js';
import { CloudHost } from '../../models/cloud-host.js';
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
