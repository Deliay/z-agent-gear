import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../models/configured-workflow.js', () => ({
  ConfiguredWorkflow: {
    findOne: vi.fn(),
    findById: vi.fn(),
  },
}));

vi.mock('../../models/controller-workspace.js', () => ({
  ControllerWorkspace: {
    findOne: vi.fn(),
  },
}));

vi.mock('../../models/workflow-instance.js', () => ({
  WorkflowInstance: {
    create: vi.fn(),
    findOne: vi.fn(),
    find: vi.fn(),
    updateOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock('../../models/controller.js', () => ({
  Controller: {
    findOne: vi.fn(),
  },
}));

vi.mock('../../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('../../models/session.js', () => ({
  Session: {
    find: vi.fn(),
  },
}));

vi.mock('../session.js', () => ({
  sessionService: {
    delete: vi.fn(),
  },
}));

vi.mock('./engine.js', () => ({
  workflowEngine: {
    transition: vi.fn(),
  },
}));

vi.mock('./pr-handler-registry.js', () => ({
  prHandlerRegistry: {
    unregisterByInstance: vi.fn().mockResolvedValue(0),
  },
}));

vi.mock('../workspace-default-branch.js', () => ({
  resolveWorkspaceDefaultBranch: vi.fn(),
}));

vi.mock('../commit-settings-service.js', () => ({
  commitSettingsService: {
    resolveWorktreeCommitter: vi.fn(),
  },
}));

import { logger as rootLogger } from '../../observability/logger.js';
import { createTestLogger } from '../../observability/testing.js';

/**
 * 注入 createTestLogger：在被测模块加载前拦截 `rootLogger.child(...)`，把
 * workflow-instance 日志写入内存 sink，断言 `records` 的结构化字段。
 */
const testLog = createTestLogger();
const childSpy = vi
  .spyOn(rootLogger, 'child')
  .mockImplementation((bindings) => testLog.logger.child(bindings));
const { workflowInstanceService } = await import('./instance.js');
childSpy.mockRestore();

import { workflowEngine } from './engine.js';
import { ConfiguredWorkflow } from '../../models/configured-workflow.js';
import { ControllerWorkspace } from '../../models/controller-workspace.js';
import { WorkflowInstance } from '../../models/workflow-instance.js';
import { Controller } from '../../models/controller.js';
import { Session } from '../../models/session.js';
import { sessionService } from '../session.js';
import { getRedisClient } from '../../middleware/redis.js';
import { prHandlerRegistry } from './pr-handler-registry.js';
import { resolveWorkspaceDefaultBranch } from '../workspace-default-branch.js';
import { commitSettingsService } from '../commit-settings-service.js';

function oid(id: string) {
  return { toString: () => id } as import('mongoose').Types.ObjectId;
}

function leanQuery(result: unknown) {
  return { lean: vi.fn().mockResolvedValue(result) } as never;
}

const mockRedis = { get: vi.fn(), del: vi.fn(), publish: vi.fn() };

function makeConfigured(overrides: Record<string, unknown> = {}) {
  return {
    _id: oid('cfg-1'),
    userId: oid('user-1'),
    controllerId: oid('ctrl-1'),
    name: '开发工作流配置',
    nodes: [
      {
        nodeKey: 'requirement',
        type: 'HUMAN',
        name: '产品需求',
        stage: '需求',
        dependsOn: [],
        requiresWorktree: false,
        agentConfig: null,
      },
      {
        nodeKey: 'design',
        type: 'AI',
        name: '技术方案',
        stage: '设计',
        dependsOn: ['requirement'],
        requiresWorktree: true,
        agentConfig: { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: true },
      },
    ],
    ...overrides,
  };
}

function makeWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    _id: oid('ws-1'),
    userId: oid('user-1'),
    controllerId: oid('ctrl-1'),
    name: 'my-project',
    path: '/home/user/project',
    defaultBranch: 'main',
    ...overrides,
  };
}

function makeNodes() {
  return [
    {
      nodeKey: 'requirement',
      type: 'HUMAN' as const,
      name: '产品需求',
      stage: '需求',
      dependsOn: [],
      requiresWorktree: false,
      agentConfig: null,
    },
    {
      nodeKey: 'design',
      type: 'AI' as const,
      name: '技术方案',
      stage: '设计',
      prompts: ['产出技术方案'],
      artifactTitles: ['技术方案文档'],
      dependsOn: ['requirement'],
      requiresWorktree: true,
      agentConfig: { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: true },
    },
  ];
}

function instantiateInput(overrides: Record<string, unknown> = {}) {
  return {
    source: 'CONFIGURED',
    configuredWorkflowId: 'cfg-1',
    controllerId: 'ctrl-1',
    workspaceId: 'ws-1',
    name: '需求A开发',
    nodes: makeNodes(),
    ...overrides,
  };
}

function mockControllerFound() {
  vi.mocked(Controller.findOne).mockReturnValue(
    leanQuery({ _id: oid('ctrl-1'), userId: oid('user-1'), name: 'dev-machine' }),
  );
}

function mockCapabilities(types: string[]) {
  mockRedis.get.mockResolvedValue(
    JSON.stringify({ servers: types.map((t) => ({ type: t, available: true })), checkedAt: new Date().toISOString() }),
  );
}

/** Worktree 命令成功 + 能力探测可用（避免 get mock 覆盖 capabilities）。 */
function mockWorktreeRedis() {
  mockRedis.get.mockImplementation(async (key: string) => {
    if (key.startsWith('git:worktree:add:')) {
      return JSON.stringify({ success: true, worktreePath: '/wt/repo/workflow-x' });
    }
    if (key.startsWith('git:worktree:remove:')) {
      return JSON.stringify({ success: true });
    }
    return JSON.stringify({
      servers: [{ type: 'opencode', available: true }],
      checkedAt: new Date().toISOString(),
    });
  });
}

describe('WorkflowInstanceService.instantiate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
    mockControllerFound();
    mockCapabilities(['opencode', 'claude_code']);
    vi.mocked(ConfiguredWorkflow.findOne).mockReturnValue(leanQuery(makeConfigured()));
    vi.mocked(ControllerWorkspace.findOne).mockReturnValue(leanQuery(makeWorkspace()));
    vi.mocked(resolveWorkspaceDefaultBranch).mockResolvedValue(null);
    vi.mocked(commitSettingsService.resolveWorktreeCommitter).mockResolvedValue(null);
  });

  it('I1: CONFIGURED 正常实例化：节点全量快照落库，首节点 READY，其余 INITIALIZING', async () => {
    vi.mocked(WorkflowInstance.create).mockImplementation(async (doc) => doc as never);

    await workflowInstanceService.instantiate('user-1', instantiateInput() as never);

    const created = vi.mocked(WorkflowInstance.create).mock.calls[0][0] as {
      userId: string;
      controllerId: unknown;
      workspaceId: string;
      configuredWorkflowId: string;
      name: string;
      currentNodeNames: string[];
      nodes: {
        nodeId: string;
        nodeKey: string;
        type: string;
        status: string;
        dependsOn: string[];
        reworkCount: number;
        prompts?: string[];
        artifactTitles?: string[];
        agentConfig?: { acpServerType: string };
        requiresWorktree: boolean;
      }[];
    };
    expect(created).toMatchObject({
      userId: 'user-1',
      controllerId: 'ctrl-1',
      workspaceId: 'ws-1',
      configuredWorkflowId: 'cfg-1',
      name: '需求A开发',
      currentNodeNames: [],
    });
    expect(created.nodes).toHaveLength(2);
    expect(created.nodes[0]).toMatchObject({
      nodeKey: 'requirement',
      status: 'READY',
      reworkCount: 0,
      requiresWorktree: false,
    });
    expect(created.nodes[1]).toMatchObject({
      nodeKey: 'design',
      status: 'INITIALIZING',
      prompts: ['产出技术方案'],
      artifactTitles: ['技术方案文档'],
      requiresWorktree: true,
    });
    expect(created.nodes[1].agentConfig).toMatchObject({ acpServerType: 'opencode', initNewWorktree: true });
    expect(created.nodes[1].dependsOn).toEqual([created.nodes[0].nodeId]);
    expect(created.nodes[0].nodeId).toBeTruthy();
  });

  it('I1b (T-A8): 配置了自定义 worktreeDir 时，创建工作流 Worktree 下发的 wtPath 以配置值为准', async () => {
    vi.mocked(Controller.findOne).mockReturnValue(
      leanQuery({ _id: oid('ctrl-1'), userId: oid('user-1'), name: 'dev-machine', worktreeDir: '/data/wt' }),
    );
    vi.mocked(WorkflowInstance.create).mockImplementation(async (doc) => doc as never);
    mockRedis.get.mockImplementation(async (key: string) => {
      if (key.startsWith('git:worktree:add:')) {
        return JSON.stringify({ success: true, worktreePath: '/data/wt/my-project/workflow-wf-abcd' });
      }
      return JSON.stringify({
        servers: ['opencode', 'claude_code'].map((type) => ({ type, available: true })),
        checkedAt: new Date().toISOString(),
      });
    });

    await workflowInstanceService.instantiate('user-1', instantiateInput({ createWorkflowWorktree: true }) as never);

    const publishCalls = vi.mocked(mockRedis.publish).mock.calls.filter(
      ([ch]) => ch === 'session:command',
    );
    const addCall = publishCalls
      .map(([, payload]) => JSON.parse(payload as string))
      .find((p: { type?: string }) => p.type === 'git:worktree:add');
    expect(addCall).toBeTruthy();
    // 生成端以配置值为准，不再命中硬编码默认值 '~/.zag/worktrees'
    expect((addCall as { worktreePath: string }).worktreePath.startsWith('/data/wt/my-project/')).toBe(true);
    expect((addCall as { worktreePath: string }).worktreePath).not.toContain('~/.zag/worktrees');
  });

  it('I2: 来源必填校验——TEMPLATE 缺 templateId 报错', async () => {
    await expect(
      workflowInstanceService.instantiate('user-1', instantiateInput({ source: 'TEMPLATE' }) as never),
    ).rejects.toThrow(/templateId/);
    expect(WorkflowInstance.create).not.toHaveBeenCalled();
  });

  it('I2b: CONFIGURED 缺 configuredWorkflowId 报错', async () => {
    await expect(
      workflowInstanceService.instantiate('user-1', instantiateInput({ configuredWorkflowId: null }) as never),
    ).rejects.toThrow(/configuredWorkflowId/);
    expect(WorkflowInstance.create).not.toHaveBeenCalled();
  });

  it('工作区不存在或不属于该控制器时拒绝', async () => {
    vi.mocked(ControllerWorkspace.findOne).mockReturnValue(leanQuery(null));
    await expect(
      workflowInstanceService.instantiate('user-1', instantiateInput() as never),
    ).rejects.toThrow(/工作区/);
    expect(WorkflowInstance.create).not.toHaveBeenCalled();
  });

  it('I3: 非法图（双首节点）拒绝并报具体错误', async () => {
    const nodes = makeNodes();
    nodes[1].dependsOn = [];
    await expect(
      workflowInstanceService.instantiate('user-1', instantiateInput({ nodes }) as never),
    ).rejects.toThrow(/首节点必须唯一/);
    expect(WorkflowInstance.create).not.toHaveBeenCalled();
  });

  it('I4: AI 节点缺 agentConfig 拒绝并指出节点', async () => {
    const nodes = makeNodes();
    nodes[1].agentConfig = null;
    await expect(
      workflowInstanceService.instantiate('user-1', instantiateInput({ nodes }) as never),
    ).rejects.toThrow(/Agent 配置.*技术方案|技术方案.*Agent 配置/);
    expect(WorkflowInstance.create).not.toHaveBeenCalled();
  });

  it('I4b: acpServerType 不在 capabilities 内拒绝', async () => {
    const nodes = makeNodes();
    nodes[1].agentConfig = { acpServerType: 'gemini_cli', modeId: null, modelId: null, initNewWorktree: true };
    await expect(
      workflowInstanceService.instantiate('user-1', instantiateInput({ nodes }) as never),
    ).rejects.toThrow(/gemini_cli/);
  });

  it('I5: requiresWorktree 但解析不到默认分支 → 抛原错误文案', async () => {
    vi.mocked(ControllerWorkspace.findOne).mockReturnValue(leanQuery(makeWorkspace({ defaultBranch: null })));
    await expect(
      workflowInstanceService.instantiate('user-1', instantiateInput() as never),
    ).rejects.toThrow(/Git|git/);
    expect(resolveWorkspaceDefaultBranch).toHaveBeenCalled();
    expect(WorkflowInstance.create).not.toHaveBeenCalled();
  });

  it('I5b: 无 requiresWorktree 节点且不建实例 Worktree → 非 git 工作区可实例化且不调用解析器', async () => {
    const nodes = makeNodes();
    nodes[1].requiresWorktree = false;
    nodes[1].agentConfig = { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: false };
    vi.mocked(ControllerWorkspace.findOne).mockReturnValue(leanQuery(makeWorkspace({ defaultBranch: null })));
    vi.mocked(WorkflowInstance.create).mockImplementation(async (doc) => doc as never);

    await expect(
      workflowInstanceService.instantiate('user-1', instantiateInput({ nodes }) as never),
    ).resolves.toBeTruthy();
    expect(resolveWorkspaceDefaultBranch).not.toHaveBeenCalled();
  });

  it('I7: needsWorktree 且默认分支缺失 → 解析回填后实例化成功', async () => {
    vi.mocked(ControllerWorkspace.findOne).mockReturnValue(leanQuery(makeWorkspace({ defaultBranch: null })));
    vi.mocked(resolveWorkspaceDefaultBranch).mockResolvedValue('main');
    vi.mocked(WorkflowInstance.create).mockImplementation(async (doc) => doc as never);

    await expect(
      workflowInstanceService.instantiate('user-1', instantiateInput() as never),
    ).resolves.toBeTruthy();

    expect(resolveWorkspaceDefaultBranch).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', controllerId: 'ctrl-1', workspaceId: 'ws-1' }),
    );
    expect(WorkflowInstance.create).toHaveBeenCalledTimes(1);
  });

  it('I8: createWorkflowWorktree 且默认分支缺失 → 解析后创建实例级 Worktree', async () => {
    vi.mocked(ControllerWorkspace.findOne).mockReturnValue(leanQuery(makeWorkspace({ defaultBranch: null })));
    vi.mocked(resolveWorkspaceDefaultBranch).mockResolvedValue('main');
    vi.mocked(WorkflowInstance.create).mockImplementation(async (doc) => doc as never);
    mockWorktreeRedis();

    await workflowInstanceService.instantiate(
      'user-1',
      instantiateInput({ createWorkflowWorktree: true }) as never,
    );

    const addCall = vi
      .mocked(mockRedis.publish)
      .mock.calls.map(([, payload]) => JSON.parse(payload as string))
      .find((p: { type?: string }) => p.type === 'git:worktree:add');
    expect(addCall).toBeTruthy();
    const created = vi.mocked(WorkflowInstance.create).mock.calls[0][0] as {
      workflowWorktreePath?: string;
      workflowWorktreeBranch?: string;
    };
    expect(created.workflowWorktreePath).toBe('/wt/repo/workflow-x');
    expect(created.workflowWorktreeBranch).toBeTruthy();
  });

  it('I9a: needsWorktree 且解析失败 → 原错误文案', async () => {
    vi.mocked(ControllerWorkspace.findOne).mockReturnValue(leanQuery(makeWorkspace({ defaultBranch: null })));

    await expect(
      workflowInstanceService.instantiate('user-1', instantiateInput() as never),
    ).rejects.toThrow(/未设置默认分支/);
    expect(WorkflowInstance.create).not.toHaveBeenCalled();
  });

  it('I9b: createWorkflowWorktree 且非 Git 工作区 → 不创建 Worktree（A49 语义：不阻断实例化）', async () => {
    const nodes = makeNodes();
    nodes[1].requiresWorktree = false;
    nodes[1].agentConfig = { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: false };
    vi.mocked(ControllerWorkspace.findOne).mockReturnValue(leanQuery(makeWorkspace({ defaultBranch: null })));

    await expect(
      workflowInstanceService.instantiate(
        'user-1',
        instantiateInput({ nodes, createWorkflowWorktree: true }) as never,
      ),
    ).resolves.toBeDefined();
    expect(WorkflowInstance.create).toHaveBeenCalledTimes(1);
    const doc = vi.mocked(WorkflowInstance.create).mock.calls[0][0] as Record<string, unknown>;
    expect(doc.workflowWorktreePath).toBeUndefined();
  });

  it('I10: 实例创建失败 → 回滚 Worktree 并继续抛错', async () => {
    vi.mocked(WorkflowInstance.create).mockRejectedValueOnce(new Error('db down'));
    mockWorktreeRedis();

    await expect(
      workflowInstanceService.instantiate(
        'user-1',
        instantiateInput({ createWorkflowWorktree: true }) as never,
      ),
    ).rejects.toThrow('db down');

    const types = vi
      .mocked(mockRedis.publish)
      .mock.calls.map(([, payload]) => JSON.parse(payload as string).type);
    expect(types).toContain('git:worktree:add');
    expect(types).toContain('git:worktree:remove');
  });

  it('I6: 提交图与来源图不同（实例化前被修改）时以提交图为准落库', async () => {
    // 来源是配置 cfg-1，但提交图新增一个节点，服务端应以提交图为准
    const nodes = [...makeNodes(), { nodeKey: 'extra', type: 'AI' as const, name: '额外', stage: '实现', prompts: ['做某事'], dependsOn: ['design'], requiresWorktree: false, agentConfig: { acpServerType: 'opencode', initNewWorktree: false } }];
    vi.mocked(WorkflowInstance.create).mockImplementation(async (doc) => doc as never);

    await workflowInstanceService.instantiate('user-1', instantiateInput({ nodes }) as never);

    const created = vi.mocked(WorkflowInstance.create).mock.calls[0][0] as { nodes: { nodeKey: string }[] };
    expect(created.nodes).toHaveLength(3);
    expect(created.nodes.map((n) => n.nodeKey)).toEqual(['requirement', 'design', 'extra']);
  });

  it('TEMPLATE/BLANK 来源也能实例化（无 configuredWorkflowId 落库为 null）', async () => {
    vi.mocked(WorkflowInstance.create).mockImplementation(async (doc) => doc as never);
    await workflowInstanceService.instantiate('user-1', instantiateInput({ source: 'TEMPLATE', templateId: 'tpl-1', configuredWorkflowId: null }) as never);
    const created = vi.mocked(WorkflowInstance.create).mock.calls[0][0] as { configuredWorkflowId: unknown };
    expect(created.configuredWorkflowId).toBeNull();
  });

  describe('T-WF-C1 worktreeCommitter 实例快照', () => {
    const committer = { name: 'Deliay', email: 'deliay@example.com' };

    function findAddCall() {
      return vi
        .mocked(mockRedis.publish)
        .mock.calls.map(([, payload]) => JSON.parse(payload as string))
        .find((p: { type?: string }) => p.type === 'git:worktree:add') as
        | { committer?: { name: string; email: string } }
        | undefined;
    }

    it('C1a: 未显式传入 → 解析创建者「提交人」，落库快照并随 worktree 载荷下发', async () => {
      vi.mocked(commitSettingsService.resolveWorktreeCommitter).mockResolvedValue(committer);
      vi.mocked(WorkflowInstance.create).mockImplementation(async (doc) => doc as never);
      mockWorktreeRedis();

      await workflowInstanceService.instantiate(
        'user-1',
        instantiateInput({ createWorkflowWorktree: true }) as never,
      );

      expect(commitSettingsService.resolveWorktreeCommitter).toHaveBeenCalledWith('user-1');
      const created = vi.mocked(WorkflowInstance.create).mock.calls[0][0] as Record<string, unknown>;
      expect(created.worktreeCommitterName).toBe('Deliay');
      expect(created.worktreeCommitterEmail).toBe('deliay@example.com');
      expect(findAddCall()?.committer).toEqual(committer);
    });

    it('C1b: 创建者未设置提交人 → 快照 null 且 worktree 载荷不带 committer（沿用 bot）', async () => {
      vi.mocked(commitSettingsService.resolveWorktreeCommitter).mockResolvedValue(null);
      vi.mocked(WorkflowInstance.create).mockImplementation(async (doc) => doc as never);
      mockWorktreeRedis();

      await workflowInstanceService.instantiate(
        'user-1',
        instantiateInput({ createWorkflowWorktree: true }) as never,
      );

      const created = vi.mocked(WorkflowInstance.create).mock.calls[0][0] as Record<string, unknown>;
      expect(created.worktreeCommitterName).toBeNull();
      expect(created.worktreeCommitterEmail).toBeNull();
      expect(findAddCall()).toBeTruthy();
      expect(findAddCall()).not.toHaveProperty('committer');
    });

    it('C1c: Issue 显式传入优先于创建者解析（不再查创建者设置）', async () => {
      const issueCommitter = { name: 'octocat', email: '583231+octocat@users.noreply.github.com' };
      vi.mocked(WorkflowInstance.create).mockImplementation(async (doc) => doc as never);
      mockWorktreeRedis();

      await workflowInstanceService.instantiate(
        'user-1',
        instantiateInput({ createWorkflowWorktree: true, worktreeCommitter: issueCommitter }) as never,
      );

      expect(commitSettingsService.resolveWorktreeCommitter).not.toHaveBeenCalled();
      const created = vi.mocked(WorkflowInstance.create).mock.calls[0][0] as Record<string, unknown>;
      expect(created.worktreeCommitterName).toBe('octocat');
      expect(created.worktreeCommitterEmail).toBe('583231+octocat@users.noreply.github.com');
      expect(findAddCall()?.committer).toEqual(issueCommitter);
    });

    it('C1d: 显式 null（触发人无法识别 → bot）覆盖创建者设置，快照 null 且不下发', async () => {
      vi.mocked(commitSettingsService.resolveWorktreeCommitter).mockResolvedValue(committer);
      vi.mocked(WorkflowInstance.create).mockImplementation(async (doc) => doc as never);
      mockWorktreeRedis();

      await workflowInstanceService.instantiate(
        'user-1',
        instantiateInput({ createWorkflowWorktree: true, worktreeCommitter: null }) as never,
      );

      expect(commitSettingsService.resolveWorktreeCommitter).not.toHaveBeenCalled();
      const created = vi.mocked(WorkflowInstance.create).mock.calls[0][0] as Record<string, unknown>;
      expect(created.worktreeCommitterName).toBeNull();
      expect(created.worktreeCommitterEmail).toBeNull();
      expect(findAddCall()).not.toHaveProperty('committer');
    });
  });
});

describe('WorkflowInstanceService.updateNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
  });

  function makeInstance(nodes: Record<string, unknown>[] = []) {
    return {
      _id: oid('inst-1'),
      userId: oid('user-1'),
      configuredWorkflowId: oid('cfg-1'),
      nodes,
    };
  }

  function makeNode(overrides: Record<string, unknown> = {}) {
    return {
      nodeId: 'n1',
      nodeKey: 'design',
      type: 'AI',
      name: '技术方案',
      stage: '设计',
      status: 'READY',
      startedAt: null,
      prompts: ['旧提示词'],
      artifactTitles: ['旧产物'],
      requiresWorktree: true,
      agentConfig: { acpServerType: 'opencode', initNewWorktree: true },
      ...overrides,
    };
  }

  it('N1: INITIALIZING/READY 且 startedAt=null 更新成功', async () => {
    vi.mocked(WorkflowInstance.findOne).mockReturnValueOnce(leanQuery(makeInstance([makeNode()]) as never));
    vi.mocked(WorkflowInstance.findOneAndUpdate).mockReturnValueOnce(
      leanQuery(makeInstance([makeNode({ prompts: ['新提示词'], name: '新名字' })]) as never),
    );

    await workflowInstanceService.updateNode('user-1', 'inst-1', 'n1', {
      name: '新名字',
      prompts: ['新提示词'],
    });

    expect(WorkflowInstance.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'inst-1',
        nodes: {
          $elemMatch: { nodeId: 'n1', status: { $in: ['INITIALIZING', 'READY'] }, startedAt: null },
        },
      }),
      expect.objectContaining({ $set: expect.objectContaining({ 'nodes.$[n].name': '新名字' }) }),
      expect.objectContaining({ arrayFilters: [{ 'n.nodeId': 'n1' }], returnDocument: 'after' }),
    );
    expect(mockRedis.del).toHaveBeenCalledWith('workflow:instance:inst-1');
  });

  it('N2: RUNNING/DONE/REJECT/REWORK/FAILED 拒绝「节点已开始，不可修改」', async () => {
    for (const status of ['RUNNING', 'DONE', 'REJECT', 'REWORK', 'FAILED']) {
      vi.clearAllMocks();
      vi.mocked(WorkflowInstance.findOne).mockReturnValueOnce(leanQuery(makeInstance([makeNode({ status })]) as never));
      vi.mocked(WorkflowInstance.findOneAndUpdate).mockReturnValueOnce(leanQuery(null) as never);
      vi.mocked(WorkflowInstance.findOne).mockReturnValueOnce(leanQuery(makeInstance([makeNode({ status })]) as never));

      await expect(
        workflowInstanceService.updateNode('user-1', 'inst-1', 'n1', { name: 'x' }),
      ).rejects.toThrow(/已开始，不可修改/);
    }
  });

  it('N3: 旧实例节点（无快照字段）先回查补齐快照再应用修改', async () => {
    const oldNode = { nodeId: 'n1', nodeKey: 'design', type: 'AI', name: '技术方案', stage: '设计', status: 'READY', startedAt: null };
    vi.mocked(WorkflowInstance.findOne).mockReturnValueOnce(leanQuery(makeInstance([oldNode]) as never));
    vi.mocked(ConfiguredWorkflow.findById).mockReturnValueOnce(
      leanQuery(makeConfigured()),
    );
    vi.mocked(WorkflowInstance.updateOne).mockResolvedValue({} as never);
    vi.mocked(WorkflowInstance.findOneAndUpdate).mockReturnValueOnce(
      leanQuery(makeInstance([makeNode({ prompts: ['补齐后的提示词'] })]) as never),
    );

    await workflowInstanceService.updateNode('user-1', 'inst-1', 'n1', { prompts: ['补齐后的提示词'] });

    // 先回查补齐快照
    expect(ConfiguredWorkflow.findById).toHaveBeenCalledTimes(1);
    expect(WorkflowInstance.updateOne).toHaveBeenCalled();
  });

  it('N3b: 旧实例节点引用配置已变更（nodeKey 已删除）报可读错误', async () => {
    const oldNode = { nodeId: 'n1', nodeKey: 'ghost', type: 'AI', name: '技术方案', stage: '设计', status: 'READY', startedAt: null };
    vi.mocked(WorkflowInstance.findOne).mockReturnValueOnce(leanQuery(makeInstance([oldNode]) as never));
    vi.mocked(ConfiguredWorkflow.findById).mockReturnValueOnce(leanQuery(makeConfigured()));

    await expect(
      workflowInstanceService.updateNode('user-1', 'inst-1', 'n1', { name: 'x' }),
    ).rejects.toThrow(/已变更|不存在/);
  });

  it('N4: 实例已删除（deletedAt 非空）拒绝', async () => {
    vi.mocked(WorkflowInstance.findOne).mockReturnValueOnce(leanQuery(null) as never);
    await expect(
      workflowInstanceService.updateNode('user-1', 'inst-1', 'n1', { name: 'x' }),
    ).rejects.toThrow(/不存在/);
    expect(WorkflowInstance.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('N4b: 节点不存在拒绝', async () => {
    vi.mocked(WorkflowInstance.findOne).mockReturnValueOnce(leanQuery(makeInstance([]) as never));
    await expect(
      workflowInstanceService.updateNode('user-1', 'inst-1', 'n1', { name: 'x' }),
    ).rejects.toThrow(/不存在节点/);
  });
});

describe('WorkflowInstanceService.completeHumanNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('首节点输入文本：start → complete 组合转移，产物写入黑板', async () => {
    const instance = {
      _id: oid('inst-1'),
      userId: oid('user-1'),
      nodes: [
        { nodeId: 'n1', nodeKey: 'requirement', type: 'HUMAN', name: '产品需求', status: 'READY', dependsOn: [] },
      ],
    };
    vi.mocked(WorkflowInstance.findOne).mockReturnValue(leanQuery(instance));
    vi.mocked(workflowEngine.transition).mockResolvedValue({} as never);

    await workflowInstanceService.completeHumanNode('user-1', 'inst-1', 'n1', '初版需求文本');

    expect(workflowEngine.transition).toHaveBeenCalledTimes(2);
    expect(vi.mocked(workflowEngine.transition).mock.calls[0]).toEqual(['inst-1', 'n1', 'start', {}]);
    expect(vi.mocked(workflowEngine.transition).mock.calls[1]).toEqual([
      'inst-1',
      'n1',
      'complete',
      { artifacts: [{ title: '输入', value: '初版需求文本' }] },
    ]);
  });

  it('下游人类节点已被引擎激活（RUNNING）：跳过 start 直接 complete', async () => {
    const instance = {
      _id: oid('inst-1'),
      userId: oid('user-1'),
      nodes: [
        { nodeId: 'n1', nodeKey: 'requirement', type: 'HUMAN', name: '产品需求', status: 'DONE', dependsOn: [] },
        { nodeId: 'n2', nodeKey: 'review', type: 'HUMAN', name: '评审', status: 'RUNNING', dependsOn: ['n1'] },
      ],
    };
    vi.mocked(WorkflowInstance.findOne).mockReturnValue(leanQuery(instance));
    vi.mocked(workflowEngine.transition).mockResolvedValue({} as never);

    await workflowInstanceService.completeHumanNode('user-1', 'inst-1', 'n2', '同意方案');

    expect(workflowEngine.transition).toHaveBeenCalledTimes(1);
    expect(vi.mocked(workflowEngine.transition).mock.calls[0]).toEqual([
      'inst-1',
      'n2',
      'complete',
      { artifacts: [{ title: '输入', value: '同意方案' }] },
    ]);
  });

  it('REWORK 人类节点重新提交：走 completeRework 转移（重置产物入垃圾桶、复工下游）', async () => {
    const instance = {
      _id: oid('inst-1'),
      userId: oid('user-1'),
      nodes: [
        { nodeId: 'n1', nodeKey: 'requirement', type: 'HUMAN', name: '产品需求', status: 'REWORK', dependsOn: [], reworkCount: 1 },
      ],
    };
    vi.mocked(WorkflowInstance.findOne).mockReturnValue(leanQuery(instance));
    vi.mocked(workflowEngine.transition).mockResolvedValue({} as never);

    await workflowInstanceService.completeHumanNode('user-1', 'inst-1', 'n1', '修订后的需求');

    expect(workflowEngine.transition).toHaveBeenCalledTimes(1);
    expect(vi.mocked(workflowEngine.transition).mock.calls[0]).toEqual([
      'inst-1',
      'n1',
      'completeRework',
      { artifacts: [{ title: '输入', value: '修订后的需求' }] },
    ]);
  });

  it('非人类节点拒绝人工完成', async () => {
    const instance = {
      _id: oid('inst-1'),
      nodes: [{ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', status: 'RUNNING', dependsOn: ['n1'] }],
    };
    vi.mocked(WorkflowInstance.findOne).mockReturnValue(leanQuery(instance));

    await expect(workflowInstanceService.completeHumanNode('user-1', 'inst-1', 'n2', 'x')).rejects.toThrow(
      /人类节点/,
    );
    expect(workflowEngine.transition).not.toHaveBeenCalled();
  });

  it('他人实例拒绝', async () => {
    vi.mocked(WorkflowInstance.findOne).mockReturnValue(leanQuery(null));
    await expect(workflowInstanceService.completeHumanNode('user-2', 'inst-1', 'n1', 'x')).rejects.toThrow(
      /不存在/,
    );
  });
});

describe('WorkflowInstanceService.rejectNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('人类打回：走引擎 reject 转移', async () => {
    const instance = {
      _id: oid('inst-1'),
      nodes: [{ nodeId: 'n2', nodeKey: 'review', type: 'HUMAN', name: '评审', status: 'RUNNING', dependsOn: ['n1'] }],
    };
    vi.mocked(WorkflowInstance.findOne).mockReturnValue(leanQuery(instance));
    vi.mocked(workflowEngine.transition).mockResolvedValue({} as never);

    await workflowInstanceService.rejectNode('user-1', 'inst-1', 'n2', '方案不完整');

    expect(workflowEngine.transition).toHaveBeenCalledWith('inst-1', 'n2', 'reject', {
      reason: '方案不完整',
      fromNodeId: null,
    });
  });

  it('READY 人类节点：先 start 再 reject', async () => {
    const instance = {
      _id: oid('inst-1'),
      nodes: [{ nodeId: 'n1', nodeKey: 'requirement', type: 'HUMAN', name: '需求', status: 'READY', dependsOn: [] }],
    };
    vi.mocked(WorkflowInstance.findOne).mockReturnValue(leanQuery(instance));
    vi.mocked(workflowEngine.transition).mockResolvedValue({} as never);

    await workflowInstanceService.rejectNode('user-1', 'inst-1', 'n1', '不通过');

    expect(workflowEngine.transition).toHaveBeenNthCalledWith(1, 'inst-1', 'n1', 'start', {});
    expect(workflowEngine.transition).toHaveBeenNthCalledWith(2, 'inst-1', 'n1', 'reject', {
      reason: '不通过',
      fromNodeId: null,
    });
  });

  it('人工打回沿用既有类型无关语义（AI 节点可被打回，见裁决 17）', async () => {
    const instance = {
      _id: oid('inst-1'),
      nodes: [{ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', status: 'RUNNING', dependsOn: ['n1'] }],
    };
    vi.mocked(WorkflowInstance.findOne).mockReturnValue(leanQuery(instance));
    vi.mocked(workflowEngine.transition).mockResolvedValue({} as never);

    await workflowInstanceService.rejectNode('user-1', 'inst-1', 'n2', 'x');
    expect(workflowEngine.transition).toHaveBeenCalledWith('inst-1', 'n2', 'reject', {
      reason: 'x',
      fromNodeId: null,
    });
  });
});


describe('WorkflowInstanceService 查询排除已删除实例', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('listForWorkspace 过滤 deletedAt: null', async () => {
    const lean = vi.fn().mockResolvedValue([]);
    const sort = vi.fn().mockReturnValue({ lean });
    vi.mocked(WorkflowInstance.find).mockReturnValue({ sort } as never);

    await workflowInstanceService.listForWorkspace('user-1', 'ws-1');

    expect(WorkflowInstance.find).toHaveBeenCalledWith({
      userId: 'user-1',
      workspaceId: 'ws-1',
      deletedAt: null,
      archivedAt: null,
    });
  });

  it('listForWorkspace(archived=true) 仅返回已归档实例', async () => {
    const lean = vi.fn().mockResolvedValue([]);
    const sort = vi.fn().mockReturnValue({ lean });
    vi.mocked(WorkflowInstance.find).mockReturnValue({ sort } as never);

    await workflowInstanceService.listForWorkspace('user-1', 'ws-1', true);

    expect(WorkflowInstance.find).toHaveBeenCalledWith({
      userId: 'user-1',
      workspaceId: 'ws-1',
      deletedAt: null,
      archivedAt: { $ne: null },
    });
  });

  it('findById 过滤 deletedAt: null', async () => {
    vi.mocked(WorkflowInstance.findOne).mockReturnValue(leanQuery(null));

    const result = await workflowInstanceService.findById('inst-1', 'user-1');

    expect(WorkflowInstance.findOne).toHaveBeenCalledWith({
      _id: 'inst-1',
      userId: 'user-1',
      deletedAt: null,
    });
    expect(result).toBeNull();
  });
});

describe('WorkflowInstanceService.list 过滤条件组装', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockFind() {
    const lean = vi.fn().mockResolvedValue([]);
    const sort = vi.fn().mockReturnValue({ lean });
    vi.mocked(WorkflowInstance.find).mockReturnValue({ sort } as never);
  }

  it('无参数：恒有 userId + deletedAt:null + archivedAt:null', async () => {
    mockFind();
    await workflowInstanceService.list('user-1');
    expect(WorkflowInstance.find).toHaveBeenCalledWith({
      userId: 'user-1',
      deletedAt: null,
      archivedAt: null,
    });
  });

  it('仅 workspaceId', async () => {
    mockFind();
    await workflowInstanceService.list('user-1', { workspaceId: 'ws-1' });
    expect(WorkflowInstance.find).toHaveBeenCalledWith({
      userId: 'user-1',
      deletedAt: null,
      archivedAt: null,
      workspaceId: 'ws-1',
    });
  });

  it('仅 controllerId', async () => {
    mockFind();
    await workflowInstanceService.list('user-1', { controllerId: 'ctrl-1' });
    expect(WorkflowInstance.find).toHaveBeenCalledWith({
      userId: 'user-1',
      deletedAt: null,
      archivedAt: null,
      controllerId: 'ctrl-1',
    });
  });

  it('workspaceId + controllerId 同传取交集', async () => {
    mockFind();
    await workflowInstanceService.list('user-1', { workspaceId: 'ws-1', controllerId: 'ctrl-1' });
    expect(WorkflowInstance.find).toHaveBeenCalledWith({
      userId: 'user-1',
      deletedAt: null,
      archivedAt: null,
      workspaceId: 'ws-1',
      controllerId: 'ctrl-1',
    });
  });

  it('archived=true 仅归档（archivedAt $ne null）', async () => {
    mockFind();
    await workflowInstanceService.list('user-1', { archived: true, controllerId: 'ctrl-1' });
    expect(WorkflowInstance.find).toHaveBeenCalledWith({
      userId: 'user-1',
      deletedAt: null,
      archivedAt: { $ne: null },
      controllerId: 'ctrl-1',
    });
  });
});

describe('WorkflowInstanceService.deleteInstance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockSessions(ids: string[]) {
    const lean = vi.fn().mockResolvedValue(ids.map((id) => ({ _id: oid(id) })));
    const select = vi.fn().mockReturnValue({ lean });
    vi.mocked(Session.find).mockReturnValue({ select } as never);
  }

  it('软删除：先标记 deletedAt，再逐个删除流程下全部会话，返回 true', async () => {
    vi.mocked(WorkflowInstance.findOne).mockReturnValue(
      leanQuery({ _id: oid('inst-1'), userId: oid('user-1') }),
    );
    vi.mocked(WorkflowInstance.updateOne).mockResolvedValue({} as never);
    mockSessions(['sess-1', 'sess-2']);
    vi.mocked(sessionService.delete).mockResolvedValue(true as never);

    const result = await workflowInstanceService.deleteInstance('user-1', 'inst-1');

    expect(result).toBe(true);
    // 先标记删除（阻断引擎/兜底），再删会话
    expect(WorkflowInstance.updateOne).toHaveBeenCalledWith(
      { _id: 'inst-1' },
      { $set: { deletedAt: expect.any(Date) } },
    );
    expect(vi.mocked(WorkflowInstance.updateOne).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sessionService.delete).mock.invocationCallOrder[0],
    );
    expect(Session.find).toHaveBeenCalledWith({ workflowInstanceId: 'inst-1' });
    expect(sessionService.delete).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sessionService.delete).mock.calls[0][0]).toBe('sess-1');
    expect(vi.mocked(sessionService.delete).mock.calls[1][0]).toBe('sess-2');
  });

  it('单个会话删除失败不中断其余会话清理', async () => {
    vi.mocked(WorkflowInstance.findOne).mockReturnValue(
      leanQuery({ _id: oid('inst-1'), userId: oid('user-1') }),
    );
    vi.mocked(WorkflowInstance.updateOne).mockResolvedValue({} as never);
    mockSessions(['sess-1', 'sess-2']);
    vi.mocked(sessionService.delete)
      .mockRejectedValueOnce(new Error('worktree 清理失败'))
      .mockResolvedValueOnce(true as never);
    testLog.reset();

    await expect(workflowInstanceService.deleteInstance('user-1', 'inst-1')).resolves.toBe(true);

    expect(sessionService.delete).toHaveBeenCalledTimes(2);
    expect(testLog.records.some((r) => r.level === 'error')).toBe(true);
  });

  it('实例不存在、无权限或已删除时拒绝', async () => {
    vi.mocked(WorkflowInstance.findOne).mockReturnValue(leanQuery(null));

    await expect(workflowInstanceService.deleteInstance('user-1', 'inst-x')).rejects.toThrow(/不存在/);
    expect(WorkflowInstance.updateOne).not.toHaveBeenCalled();
    expect(sessionService.delete).not.toHaveBeenCalled();
  });

  it('Worktree 清理失败时标记 worktreeCleanupFailed', async () => {
    vi.mocked(WorkflowInstance.findOne)
      .mockReturnValueOnce(
        leanQuery({
          _id: oid('inst-1'),
          userId: oid('user-1'),
          workflowWorktreePath: '/worktrees/my-project/workflow-test',
          workflowWorktreeBranch: 'workflow/test',
          workspaceId: oid('ws-1'),
          controllerId: oid('ctrl-1'),
        }),
      );
    vi.mocked(WorkflowInstance.updateOne).mockResolvedValue({} as never);
    mockSessions([]);
    vi.mocked(ControllerWorkspace.findOne).mockReturnValue(
      leanQuery({ _id: oid('ws-1'), path: '/home/user/project', name: 'my-project' }),
    );
    // 模拟 git:worktree:remove 返回失败
    mockRedis.publish.mockResolvedValue(1 as never);
    mockRedis.get.mockResolvedValue(JSON.stringify({ success: false, error: 'branch not found' }));
    mockRedis.del.mockResolvedValue(null as never);
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);

    const result = await workflowInstanceService.deleteInstance('user-1', 'inst-1');

    expect(result).toBe(true);
    // 应调用 publish 发送 git:worktree:remove
    expect(mockRedis.publish).toHaveBeenCalledWith(
      'session:command',
      expect.stringContaining('git:worktree:remove'),
    );
    // 应写入 worktreeCleanupFailed 标记
    expect(WorkflowInstance.updateOne).toHaveBeenCalledWith(
      { _id: 'inst-1' },
      { $set: { worktreeCleanupFailed: true } },
    );
  });

  it('无 Worktree 的实例删除时不触发清理', async () => {
    vi.mocked(WorkflowInstance.findOne)
      .mockReturnValueOnce(
        leanQuery({
          _id: oid('inst-1'),
          userId: oid('user-1'),
        }),
      );
    vi.mocked(WorkflowInstance.updateOne).mockResolvedValue({} as never);
    mockSessions([]);

    const result = await workflowInstanceService.deleteInstance('user-1', 'inst-1');

    expect(result).toBe(true);
    // 不应调用 publish（无 worktree 需清理）
    expect(mockRedis.publish).not.toHaveBeenCalled();
    // 不应写入 worktreeCleanupFailed 标记
    expect(WorkflowInstance.updateOne).not.toHaveBeenCalledWith(
      { _id: 'inst-1' },
      { $set: { worktreeCleanupFailed: true } },
    );
  });
});


describe('WorkflowInstanceService.setArchived', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('归档：置 archivedAt 为当前时间，返回 true', async () => {
    vi.mocked(WorkflowInstance.findOne).mockReturnValue(
      leanQuery({ _id: oid('inst-1'), userId: oid('user-1') }),
    );
    vi.mocked(WorkflowInstance.updateOne).mockResolvedValue({} as never);

    const result = await workflowInstanceService.setArchived('user-1', 'inst-1', true);

    expect(result).toBe(true);
    expect(WorkflowInstance.updateOne).toHaveBeenCalledWith(
      { _id: 'inst-1' },
      { $set: { archivedAt: expect.any(Date) } },
    );
  });

  it('取消归档：archivedAt 置回 null', async () => {
    vi.mocked(WorkflowInstance.findOne).mockReturnValue(
      leanQuery({ _id: oid('inst-1'), userId: oid('user-1'), archivedAt: new Date() }),
    );
    vi.mocked(WorkflowInstance.updateOne).mockResolvedValue({} as never);

    const result = await workflowInstanceService.setArchived('user-1', 'inst-1', false);

    expect(result).toBe(true);
    expect(WorkflowInstance.updateOne).toHaveBeenCalledWith(
      { _id: 'inst-1' },
      { $set: { archivedAt: null } },
    );
  });

  it('实例不存在、无权限或已删除时拒绝', async () => {
    vi.mocked(WorkflowInstance.findOne).mockReturnValue(leanQuery(null));

    await expect(workflowInstanceService.setArchived('user-1', 'inst-x', true)).rejects.toThrow(/不存在/);
    expect(WorkflowInstance.updateOne).not.toHaveBeenCalled();
  });
});

describe('WorkflowInstanceService 追加提示词与联动注销', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
    mockRedis.del.mockResolvedValue(1);
    vi.mocked(prHandlerRegistry.unregisterByInstance).mockResolvedValue(0);
  });

  it('setAdditionalPrompt 同 key 覆盖并拒绝系统键', async () => {
    vi.mocked(WorkflowInstance.findOneAndUpdate).mockReturnValue(leanQuery({ _id: 'inst-1' }));
    await workflowInstanceService.setAdditionalPrompt('user-1', 'inst-1', 'my-note', 'v');
    expect(WorkflowInstance.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'inst-1', userId: 'user-1', deletedAt: null },
      { $set: { 'additionalPrompts.my-note': 'v' } },
      { returnDocument: 'after' },
    );

    await expect(
      workflowInstanceService.setAdditionalPrompt('user-1', 'inst-1', 'github-pr', 'x'),
    ).rejects.toThrow(/系统保留/);
    await expect(
      workflowInstanceService.setAdditionalPrompt('user-1', 'inst-1', 'bad.key', 'x'),
    ).rejects.toThrow(/key 非法/);
  });

  it('removeAdditionalPrompt 幂等删除并拒绝系统键', async () => {
    vi.mocked(WorkflowInstance.findOneAndUpdate).mockReturnValue(leanQuery({ _id: 'inst-1' }));
    await workflowInstanceService.removeAdditionalPrompt('user-1', 'inst-1', 'my-note');
    expect(WorkflowInstance.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'inst-1', userId: 'user-1', deletedAt: null },
      { $unset: { 'additionalPrompts.my-note': 1 } },
      { returnDocument: 'after' },
    );
    await expect(
      workflowInstanceService.removeAdditionalPrompt('user-1', 'inst-1', 'github-pr-review'),
    ).rejects.toThrow(/系统保留/);
  });

  it('syncGithubPrPrompt 有勾选写 github-pr，全部取消则删除', async () => {
    vi.mocked(WorkflowInstance.findOne).mockReturnValue(
      leanQuery({ nodes: [{ type: 'HUMAN', linkUpstreamPullRequest: true }] }),
    );
    await expect(workflowInstanceService.syncGithubPrPrompt('inst-1')).resolves.toBe(true);
    expect(WorkflowInstance.updateOne).toHaveBeenCalledWith(
      { _id: 'inst-1' },
      { $set: { 'additionalPrompts.github-pr': expect.stringContaining('## GitHub Pull Request 联动') } },
    );

    vi.mocked(WorkflowInstance.findOne).mockReturnValue(
      leanQuery({ nodes: [{ type: 'HUMAN', linkUpstreamPullRequest: false }] }),
    );
    await expect(workflowInstanceService.syncGithubPrPrompt('inst-1')).resolves.toBe(false);
    expect(WorkflowInstance.updateOne).toHaveBeenCalledWith(
      { _id: 'inst-1' },
      { $unset: { 'additionalPrompts.github-pr': 1 } },
    );
  });

  it('归档解除关联，取消归档不解除', async () => {
    vi.mocked(WorkflowInstance.findOne).mockReturnValue(leanQuery({ _id: 'inst-1' }));
    vi.mocked(WorkflowInstance.updateOne).mockResolvedValue({} as never);

    await workflowInstanceService.setArchived('user-1', 'inst-1', true);
    expect(prHandlerRegistry.unregisterByInstance).toHaveBeenCalledWith('inst-1', 'ARCHIVED');

    vi.mocked(prHandlerRegistry.unregisterByInstance).mockClear();
    await workflowInstanceService.setArchived('user-1', 'inst-1', false);
    expect(prHandlerRegistry.unregisterByInstance).not.toHaveBeenCalled();
  });

  it('删除实例解除关联', async () => {
    vi.mocked(WorkflowInstance.findOne).mockReturnValue(leanQuery({ _id: 'inst-1', name: 'demo' }));
    vi.mocked(WorkflowInstance.updateOne).mockResolvedValue({} as never);
    const select = vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
    vi.mocked(Session.find).mockReturnValue({ select } as never);

    await workflowInstanceService.deleteInstance('user-1', 'inst-1');
    expect(prHandlerRegistry.unregisterByInstance).toHaveBeenCalledWith('inst-1', 'DELETED');
  });

  it('实例化时任一人类节点勾选则写入 github-pr', async () => {
    vi.mocked(ControllerWorkspace.findOne).mockReturnValue(leanQuery(makeWorkspace()));
    mockCapabilities(['opencode']);
    vi.mocked(WorkflowInstance.create).mockImplementation(((doc: unknown) => Promise.resolve(doc)) as never);
    const nodes = makeNodes().map((n) =>
      n.type === 'HUMAN' ? { ...n, linkUpstreamPullRequest: true } : n,
    );

    await workflowInstanceService.instantiate('user-1', instantiateInput({ nodes }) as never);

    expect(WorkflowInstance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalPrompts: { 'github-pr': expect.stringContaining('## GitHub Pull Request 联动') },
      }),
    );
  });
});
