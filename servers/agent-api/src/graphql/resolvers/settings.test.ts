import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/commit-settings-service.js', () => ({
  commitSettingsService: { getCommitSettings: vi.fn() },
}));
vi.mock('../../services/provider.js', () => ({ providerService: { findAll: vi.fn() } }));
vi.mock('../../services/model.js', () => ({ modelService: { findAll: vi.fn() } }));
vi.mock('../../services/controller-key.js', () => ({
  controllerKeyService: { findAllByUser: vi.fn() },
}));
vi.mock('../../services/workflow/admin-tools.js', () => ({
  ensureAdminToolsServer: vi.fn(),
}));
vi.mock('../../models/mcp-server.js', () => ({
  McpServer: { find: vi.fn() },
}));
vi.mock('../../services/valut-service.js', () => ({ valutService: { listGrouped: vi.fn() } }));
vi.mock('../../services/custom-mcp-service.js', () => ({
  customMcpService: { list: vi.fn() },
}));
vi.mock('../../services/custom-tool-service.js', () => ({
  customToolService: { list: vi.fn() },
}));
vi.mock('../../services/github.js', () => ({
  githubService: { getAccounts: vi.fn(), getAppUrl: vi.fn() },
}));
vi.mock('../../services/external-login.js', () => ({ listExternalLogins: vi.fn() }));
vi.mock('../../models/auth-provider.js', () => ({
  AuthProvider: { find: vi.fn() },
}));
vi.mock('../../services/cloud-storage-service.js', () => ({
  cloudStorageService: { getCapabilities: vi.fn(), list: vi.fn() },
}));
vi.mock('../../middleware/redis.js', () => ({
  getRedisClient: () => ({ set: vi.fn().mockResolvedValue('OK') }),
}));
vi.mock('./mcp-server.js', () => ({
  mapMcpServer: (server: { id: string }) => ({ id: server.id }),
}));

import { settingsResolvers } from './settings.js';
import { commitSettingsService } from '../../services/commit-settings-service.js';
import { providerService } from '../../services/provider.js';
import { modelService } from '../../services/model.js';
import { controllerKeyService } from '../../services/controller-key.js';
import { ensureAdminToolsServer } from '../../services/workflow/admin-tools.js';
import { McpServer } from '../../models/mcp-server.js';
import { valutService } from '../../services/valut-service.js';
import { customMcpService } from '../../services/custom-mcp-service.js';
import { customToolService } from '../../services/custom-tool-service.js';
import { githubService } from '../../services/github.js';
import { listExternalLogins } from '../../services/external-login.js';
import { AuthProvider } from '../../models/auth-provider.js';
import { cloudStorageService } from '../../services/cloud-storage-service.js';

const ctx = { currentUser: { id: 'user-1' } } as never;
const emptyCtx = { currentUser: null } as never;

function chain<T>(value: T) {
  return { sort: () => ({ lean: () => Promise.resolve(value) }) };
}

describe('settingsOverview resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(commitSettingsService.getCommitSettings).mockResolvedValue({
      committerType: 'CUSTOM',
      customName: 'n',
      customEmail: 'e@example.com',
      commitWithBot: true,
    } as never);
    vi.mocked(providerService.findAll).mockResolvedValue([{ id: 'p1' }] as never);
    vi.mocked(modelService.findAll).mockResolvedValue([{ id: 'm1' }] as never);
    vi.mocked(controllerKeyService.findAllByUser).mockResolvedValue([{ id: 'k1' }] as never);
    vi.mocked(McpServer.find).mockReturnValue(chain([{ id: 'mcp1' }]) as never);
    vi.mocked(valutService.listGrouped).mockResolvedValue([{ namespace: 'manual' }] as never);
    vi.mocked(customMcpService.list).mockResolvedValue([{ id: 'cm1' }] as never);
    vi.mocked(customToolService.list).mockResolvedValue([{ id: 'ct1' }] as never);
    vi.mocked(githubService.getAccounts).mockResolvedValue([{ id: 'gh1' }] as never);
    vi.mocked(githubService.getAppUrl).mockResolvedValue({ url: 'https://x', state: 's1' } as never);
    vi.mocked(listExternalLogins).mockResolvedValue([{ id: 'el1' }] as never);
    vi.mocked(AuthProvider.find).mockReturnValue(chain([
      { _id: { toString: () => 'ap1' }, type: 'github_oauth', displayName: 'x' },
    ]) as never);
    vi.mocked(cloudStorageService.getCapabilities).mockReturnValue({ enabled: true });
    vi.mocked(cloudStorageService.list).mockResolvedValue([{ id: 'cs1' }] as never);
  });

  it('未认证拒绝', async () => {
    await expect(settingsResolvers.Query.settingsOverview({}, {}, emptyCtx)).rejects.toThrow(
      'Not authenticated',
    );
  });

  it('14 个分支原样组装（与被替代查询逐字段一致）', async () => {
    const result = await settingsResolvers.Query.settingsOverview({}, {}, ctx);

    expect(ensureAdminToolsServer).toHaveBeenCalledWith('user-1');
    expect(githubService.getAppUrl).toHaveBeenCalledWith('user-1');
    expect(cloudStorageService.list).toHaveBeenCalledWith({ includeDestroyed: false });
    expect(result.commitSettings).toMatchObject({ committerType: 'CUSTOM' });
    expect(result.providers).toHaveLength(1);
    expect(result.models).toHaveLength(1);
    expect(result.controllerKeys).toHaveLength(1);
    expect(result.mcpServers).toEqual([{ id: 'mcp1' }]);
    expect(result.valutEntries).toHaveLength(1);
    expect(result.customMcpServers).toHaveLength(1);
    expect(result.customTools).toHaveLength(1);
    expect(result.githubAccounts).toHaveLength(1);
    expect(result.githubAppUrl).toEqual({ url: 'https://x', state: 's1' });
    expect(result.myExternalLogins).toHaveLength(1);
    expect(result.authProviders).toEqual([{ id: 'ap1', type: 'github_oauth', displayName: 'GitHub' }]);
    expect(result.cloudStorageCapabilities).toEqual({ enabled: true });
    expect(result.cloudStorages).toHaveLength(1);
  });

  it('单分支失败不拖垮整页：非空分支按 D12 兜底形态返回', async () => {
    vi.mocked(commitSettingsService.getCommitSettings).mockRejectedValue(new Error('x'));
    vi.mocked(githubService.getAppUrl).mockRejectedValue(new Error('x'));
    vi.mocked(cloudStorageService.getCapabilities).mockImplementation(() => {
      throw new Error('x');
    });
    vi.mocked(providerService.findAll).mockRejectedValue(new Error('x'));

    const result = await settingsResolvers.Query.settingsOverview({}, {}, ctx);

    expect(result.commitSettings).toEqual({
      committerType: 'UNSET',
      customName: null,
      customEmail: null,
      commitWithBot: false,
    });
    expect(result.githubAppUrl).toEqual({ url: '', state: '' });
    expect(result.cloudStorageCapabilities).toEqual({ enabled: false });
    expect(result.providers).toEqual([]);
    // 其他分支正常
    expect(result.models).toHaveLength(1);
  });

  it('只读上下文 githubAppUrl 求值失败经 degrade 降级（不签发 state）', async () => {
    const readonlyCtx = {
      currentUser: { id: 'user-1' },
      workspaceAccess: { readOnly: true },
    } as never;

    const result = await settingsResolvers.Query.settingsOverview({}, {}, readonlyCtx);

    expect(githubService.getAppUrl).not.toHaveBeenCalled();
    expect(result.githubAppUrl).toEqual({ url: '', state: '' });
  });
});
