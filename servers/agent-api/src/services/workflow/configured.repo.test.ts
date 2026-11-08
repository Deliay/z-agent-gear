import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../models/configured-workflow.js', () => ({
  ConfiguredWorkflow: {
    create: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock('../../models/controller.js', () => ({
  Controller: {
    findOne: vi.fn(),
  },
}));

vi.mock('../controller-workspace.js', () => ({
  controllerWorkspaceService: {
    findById: vi.fn(),
  },
}));

vi.mock('../../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

import { configuredWorkflowService } from './configured.js';
import { ConfiguredWorkflow } from '../../models/configured-workflow.js';
import { Controller } from '../../models/controller.js';
import { controllerWorkspaceService } from '../controller-workspace.js';
import { getRedisClient } from '../../middleware/redis.js';
import { runWithWorkspace } from '../workspace-context.js';

const mockRedis = { get: vi.fn() };

function lean(value: unknown) {
  return { lean: vi.fn().mockResolvedValue(value) } as never;
}

function makeNodes(overrides: Record<string, unknown> = {}) {
  return [
    {
      nodeKey: 'requirement',
      type: 'HUMAN',
      name: '产品需求',
      stage: '需求',
      dependsOn: [],
      requiresWorktree: false,
    },
    {
      nodeKey: 'design',
      type: 'AI',
      name: '技术方案',
      stage: '设计',
      prompts: ['产出技术方案'],
      artifactTitles: ['技术方案文档'],
      dependsOn: ['requirement'],
      requiresWorktree: true,
      agentConfig: { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: true },
      ...overrides,
    },
  ];
}

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: 'ws-1',
    fileName: 'dev-flow.json',
    name: '仓库开发流程',
    nodes: makeNodes(),
    ...overrides,
  };
}

function mockCloudController(type = 'cloud') {
  vi.mocked(Controller.findOne).mockReturnValue(
    lean({ _id: 'ctrl-1', type, status: 'online', version: '2.18.0' }),
  );
}

function mockCapabilities(types: string[]) {
  mockRedis.get.mockResolvedValue(
    JSON.stringify({ servers: types.map((t) => ({ type: t, available: true })), checkedAt: new Date().toISOString() }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
  vi.mocked(controllerWorkspaceService.findById).mockResolvedValue({
    id: 'ws-1',
    controllerId: 'ctrl-1',
    path: '/home/worker/workspace/project',
  } as never);
  mockCloudController();
  mockCapabilities(['opencode', 'claude_code']);
  vi.mocked(ConfiguredWorkflow.create).mockResolvedValue({ _id: 'cfg-1' } as never);
});

describe('ConfiguredWorkflowService.configureFromRepo', () => {
  it('T-CFR1 合法输入落库：sourceKind=REPO、来源路径/工作区、租户归属齐备', async () => {
    await runWithWorkspace(
      {
        id: 'ws-team',
        tenantId: 'tenant-team',
        type: 'normal',
        role: 'developer',
        readOnly: false,
        globalWorkspaceId: 'ws-global',
      },
      () => configuredWorkflowService.configureFromRepo('user-1', makeInput() as never),
    );

    expect(ConfiguredWorkflow.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        controllerId: 'ctrl-1',
        name: '仓库开发流程',
        sourceKind: 'REPO',
        sourceRepoPath: '.zag/workflow/templates/dev-flow.json',
        sourceWorkspaceId: 'ws-1',
        resourceWorkspaceId: 'ws-team',
        tenantId: 'tenant-team',
        createdBy: 'HUMAN',
      }),
    );
  });

  it('T-CFR2 校验矩阵：非 cloud / fileName 非法 / name 非法 → 白名单文案', async () => {
    mockCloudController('local');
    await expect(
      configuredWorkflowService.configureFromRepo('user-1', makeInput() as never),
    ).rejects.toThrow('repo workflow only supports cloud host');

    mockCloudController('cloud');
    for (const fileName of ['../x.json', 'a/b.json', 'a\\b.json', 'x.txt', '  ', 'x..json']) {
      await expect(
        configuredWorkflowService.configureFromRepo('user-1', makeInput({ fileName }) as never),
      ).rejects.toThrow('invalid template file name');
    }

    await expect(
      configuredWorkflowService.configureFromRepo('user-1', makeInput({ name: '  ' }) as never),
    ).rejects.toThrow('invalid workflow name');
    await expect(
      configuredWorkflowService.configureFromRepo('user-1', makeInput({ name: 'a'.repeat(65) }) as never),
    ).rejects.toThrow('invalid workflow name');

    expect(ConfiguredWorkflow.create).not.toHaveBeenCalled();
  });

  it('T-CFR3 复用图校验与 agentConfig 校验（既有中文文案）', async () => {
    const noConfig = makeInput({
      nodes: [
        {
          nodeKey: 'requirement',
          type: 'HUMAN',
          name: '产品需求',
          stage: '需求',
          dependsOn: [],
          requiresWorktree: false,
        },
        {
          nodeKey: 'design',
          type: 'AI',
          name: '技术方案',
          stage: '设计',
          prompts: ['x'],
          dependsOn: ['requirement'],
          requiresWorktree: false,
        },
      ],
    });
    await expect(
      configuredWorkflowService.configureFromRepo('user-1', noConfig as never),
    ).rejects.toThrow('缺少 Agent 配置');

    const unavailable = makeInput({ nodes: makeNodes({ agentConfig: { acpServerType: 'unknown', initNewWorktree: false } }) });
    await expect(
      configuredWorkflowService.configureFromRepo('user-1', unavailable as never),
    ).rejects.toThrow('不在该控制器可用列表内');
  });

  it('T-CFR4 工作区不可见 → Workspace not found', async () => {
    vi.mocked(controllerWorkspaceService.findById).mockResolvedValue(null);

    await expect(
      configuredWorkflowService.configureFromRepo('user-1', makeInput() as never),
    ).rejects.toThrow('Workspace not found');
  });
});

describe('ConfiguredWorkflowService.deleteRepoScopedByController', () => {
  it('T-DEL1 仅删 REPO 来源并返回删除数', async () => {
    vi.mocked(ConfiguredWorkflow.deleteMany).mockResolvedValue({ deletedCount: 3 } as never);

    const count = await configuredWorkflowService.deleteRepoScopedByController('ctrl-1');

    expect(ConfiguredWorkflow.deleteMany).toHaveBeenCalledWith({
      controllerId: 'ctrl-1',
      sourceKind: 'REPO',
    });
    expect(count).toBe(3);
  });
});
