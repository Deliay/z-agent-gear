import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../models/workflow-instance.js', () => ({
  WorkflowInstance: {
    findOne: vi.fn(),
    findById: vi.fn(),
    updateOne: vi.fn(),
  },
}));

vi.mock('../../models/controller-workspace.js', () => ({
  ControllerWorkspace: {
    findOne: vi.fn(),
  },
}));

vi.mock('../../models/controller.js', () => ({
  Controller: {
    findById: vi.fn(),
  },
}));

vi.mock('./capability.js', () => ({
  getAvailableServerTypes: vi.fn(),
}));

vi.mock('../workspace-default-branch.js', () => ({
  resolveWorkspaceDefaultBranch: vi.fn(),
}));

vi.mock('./workflow-worktree.js', () => ({
  createWorkflowWorktree: vi.fn(),
  removeWorkflowWorktree: vi.fn(),
}));

vi.mock('./instance.js', () => ({
  invalidateWorkflowInstanceCache: vi.fn(),
}));

vi.mock('./engine.js', () => ({
  workflowEngine: {
    transition: vi.fn(),
  },
}));

import { WorkflowInstance } from '../../models/workflow-instance.js';
import { ControllerWorkspace } from '../../models/controller-workspace.js';
import { Controller } from '../../models/controller.js';
import { getAvailableServerTypes } from './capability.js';
import { resolveWorkspaceDefaultBranch } from '../workspace-default-branch.js';
import { createWorkflowWorktree, removeWorkflowWorktree } from './workflow-worktree.js';
import { invalidateWorkflowInstanceCache } from './instance.js';
import { workflowEngine } from './engine.js';
import { CONTINUATION_MESSAGES, continueWorkflowInstance } from './continuation.js';

interface NodeLike {
  nodeId: string;
  type: string;
  status: string;
  name: string;
  sessionId?: string | null;
  agentConfig?: { acpServerType: string; modeId?: string | null; modelId?: string | null; initNewWorktree: boolean } | null;
}

function makeInstance(overrides: Record<string, unknown> = {}) {
  const nodes: NodeLike[] = [
    { nodeId: 'n-human', type: 'HUMAN', status: 'DONE', name: '需求', sessionId: 's-human', agentConfig: null },
    {
      nodeId: 'n-ai-1',
      type: 'AI',
      status: 'RUNNING',
      name: '方案',
      sessionId: 's-ai-1',
      agentConfig: { acpServerType: 'opencode', modeId: 'm1', modelId: 'x1', initNewWorktree: false },
    },
    {
      nodeId: 'n-ai-2',
      type: 'AI',
      status: 'REWORK',
      name: '实现',
      sessionId: 's-ai-2',
      agentConfig: { acpServerType: 'kimi_code', initNewWorktree: false },
    },
    {
      nodeId: 'n-ai-done',
      type: 'AI',
      status: 'DONE',
      name: '验收',
      sessionId: 's-ai-done',
      agentConfig: { acpServerType: 'opencode', initNewWorktree: false },
    },
  ];
  return {
    _id: { toString: () => 'inst-1' },
    userId: 'user-1',
    controllerId: { toString: () => 'old-ctrl' },
    workspaceId: { toString: () => 'old-ws' },
    name: '示例工作流',
    nodes,
    deletedAt: null,
    finishedAt: null,
    worktreeCommitterName: null,
    worktreeCommitterEmail: null,
    worktreeCoAuthorName: null,
    worktreeCoAuthorEmail: null,
    ...overrides,
  };
}

function mappingOf(overrides: Record<string, unknown> = {}) {
  return {
    controllerId: 'new-ctrl',
    workspaceId: 'new-ws',
    harnessMappings: [
      { nodeId: 'n-ai-1', acpServerType: 'kimi_code' },
      { nodeId: 'n-ai-2', acpServerType: 'opencode' },
    ],
    ...overrides,
  };
}

const workspace = {
  _id: { toString: () => 'new-ws' },
  name: 'target-repo',
  path: '/work/target',
  defaultBranch: 'main',
};

function mockControllerStatus(status: string | null) {
  vi.mocked(Controller.findById).mockReturnValue({
    select: () => ({ lean: () => Promise.resolve(status === null ? null : { status }) }),
  } as never);
}

describe('continueWorkflowInstance', () => {
  let instance: ReturnType<typeof makeInstance>;
  let updated: ReturnType<typeof makeInstance>;

  beforeEach(() => {
    vi.clearAllMocks();
    instance = makeInstance();
    updated = makeInstance({
      controllerId: { toString: () => 'new-ctrl' },
      workspaceId: { toString: () => 'new-ws' },
      continuationHistory: [
        {
          fromControllerId: 'old-ctrl',
          fromWorkspaceId: 'old-ws',
          toControllerId: 'new-ctrl',
          toWorkspaceId: 'new-ws',
          at: new Date(),
        },
      ],
    });

    vi.mocked(WorkflowInstance.findOne).mockReturnValue({ lean: () => Promise.resolve(instance) } as never);
    vi.mocked(WorkflowInstance.updateOne).mockResolvedValue({ modifiedCount: 1 } as never);
    vi.mocked(WorkflowInstance.findById).mockReturnValue({ lean: () => Promise.resolve(updated) } as never);
    mockControllerStatus('offline');
    vi.mocked(ControllerWorkspace.findOne).mockReturnValue({ lean: () => Promise.resolve(workspace) } as never);
    vi.mocked(getAvailableServerTypes).mockResolvedValue(['opencode', 'kimi_code']);
    vi.mocked(createWorkflowWorktree).mockResolvedValue({ path: '/wt/new', branch: 'workflow/new-1' });
    vi.mocked(removeWorkflowWorktree).mockResolvedValue(undefined);
    vi.mocked(resolveWorkspaceDefaultBranch).mockResolvedValue('main');
    vi.mocked(invalidateWorkflowInstanceCache).mockResolvedValue(undefined);
    vi.mocked(workflowEngine.transition).mockResolvedValue({} as never);
  });

  it('T-CONT1 成功路径：换绑 + 逐节点 Harness 改写 + 未完成清 sessionId + 接续历史', async () => {
    const result = await continueWorkflowInstance('user-1', 'inst-1', mappingOf());

    expect(result).toBe(updated);
    const [filter, update, options] = vi.mocked(WorkflowInstance.updateOne).mock.calls[0];
    expect(filter).toMatchObject({ _id: 'inst-1', deletedAt: null, finishedAt: null });
    expect((filter as unknown as Record<string, unknown>).controllerId).toBe(instance.controllerId);
    const set = (update as { $set: Record<string, unknown> }).$set;
    expect(set.controllerId).toBe('new-ctrl');
    expect(set.workspaceId).toBe('new-ws');
    expect(set.workflowWorktreePath).toBe('/wt/new');
    expect(set.workflowWorktreeBranch).toBe('workflow/new-1');
    expect(set['nodes.$[h0].agentConfig.acpServerType']).toBe('kimi_code');
    expect(set['nodes.$[h1].agentConfig.acpServerType']).toBe('opencode');
    expect(set['nodes.$[u].sessionId']).toBeNull();
    const push = (update as { $push: { continuationHistory: Record<string, unknown> } }).$push;
    expect(push.continuationHistory).toMatchObject({
      fromControllerId: instance.controllerId,
      fromWorkspaceId: instance.workspaceId,
      toControllerId: 'new-ctrl',
      toWorkspaceId: 'new-ws',
    });
    const arrayFilters = (options as { arrayFilters: Record<string, unknown>[] }).arrayFilters;
    expect(arrayFilters).toContainEqual({ 'u.status': { $ne: 'DONE' } });
    expect(arrayFilters).toContainEqual({ 'h0.nodeId': 'n-ai-1' });
    expect(arrayFilters).toContainEqual({ 'h1.nodeId': 'n-ai-2' });
    expect(invalidateWorkflowInstanceCache).toHaveBeenCalledWith('inst-1');
  });

  it('T-CONT1b 提交人快照沿用实例既有快照（换绑不换身份）', async () => {
    instance = makeInstance({
      worktreeCommitterName: 'ZeroAsh',
      worktreeCommitterEmail: 'zero@example.com',
      worktreeCoAuthorName: 'bot',
      worktreeCoAuthorEmail: 'bot@example.com',
    });
    vi.mocked(WorkflowInstance.findOne).mockReturnValue({ lean: () => Promise.resolve(instance) } as never);

    await continueWorkflowInstance('user-1', 'inst-1', mappingOf());

    expect(createWorkflowWorktree).toHaveBeenCalledWith(
      'new-ctrl',
      expect.objectContaining({ _id: 'new-ws', path: '/work/target' }),
      '示例工作流',
      {
        name: 'ZeroAsh',
        email: 'zero@example.com',
        coAuthorName: 'bot',
        coAuthorEmail: 'bot@example.com',
      },
    );
  });

  it('T-CONT2 勾选 Worktree：使用目标工作区路径创建并落库路径/分支；默认分支缺失先回填', async () => {
    vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
      lean: () => Promise.resolve({ ...workspace, defaultBranch: undefined }),
    } as never);

    await continueWorkflowInstance('user-1', 'inst-1', mappingOf());

    expect(resolveWorkspaceDefaultBranch).toHaveBeenCalledWith({
      userId: 'user-1',
      controllerId: 'new-ctrl',
      workspaceId: 'new-ws',
    });
    expect(createWorkflowWorktree).toHaveBeenCalledWith(
      'new-ctrl',
      expect.objectContaining({ path: '/work/target', defaultBranch: 'main' }),
      '示例工作流',
      null,
    );
  });

  it('T-CONT2b 默认分支回填失败 → 拒绝且不创建 Worktree', async () => {
    vi.mocked(ControllerWorkspace.findOne).mockReturnValue({
      lean: () => Promise.resolve({ ...workspace, defaultBranch: undefined }),
    } as never);
    vi.mocked(resolveWorkspaceDefaultBranch).mockResolvedValue(null);

    await expect(continueWorkflowInstance('user-1', 'inst-1', mappingOf())).rejects.toThrow(
      CONTINUATION_MESSAGES.notGitRepo,
    );
    expect(createWorkflowWorktree).not.toHaveBeenCalled();
    expect(WorkflowInstance.updateOne).not.toHaveBeenCalled();
  });

  it('T-CONT3 CAS 未命中 → 回滚新 Worktree 并抛并发文案，实例保持旧绑定', async () => {
    vi.mocked(WorkflowInstance.updateOne).mockResolvedValue({ modifiedCount: 0 } as never);

    await expect(continueWorkflowInstance('user-1', 'inst-1', mappingOf())).rejects.toThrow(
      CONTINUATION_MESSAGES.concurrent,
    );
    expect(removeWorkflowWorktree).toHaveBeenCalledWith('new-ctrl', '/work/target', '/wt/new', 'workflow/new-1');
    expect(workflowEngine.transition).not.toHaveBeenCalled();
  });

  it('T-CONT4 状态门：不存在/已删除/已完成/当前可用', async () => {
    vi.mocked(WorkflowInstance.findOne).mockReturnValue({ lean: () => Promise.resolve(null) } as never);
    await expect(continueWorkflowInstance('user-1', 'inst-1', mappingOf())).rejects.toThrow(
      CONTINUATION_MESSAGES.notFound,
    );

    vi.mocked(WorkflowInstance.findOne).mockReturnValue({
      lean: () => Promise.resolve(makeInstance({ deletedAt: new Date() })),
    } as never);
    await expect(continueWorkflowInstance('user-1', 'inst-1', mappingOf())).rejects.toThrow(
      CONTINUATION_MESSAGES.deleted,
    );

    vi.mocked(WorkflowInstance.findOne).mockReturnValue({
      lean: () => Promise.resolve(makeInstance({ finishedAt: new Date() })),
    } as never);
    await expect(continueWorkflowInstance('user-1', 'inst-1', mappingOf())).rejects.toThrow(
      CONTINUATION_MESSAGES.finished,
    );

    vi.mocked(WorkflowInstance.findOne).mockReturnValue({ lean: () => Promise.resolve(instance) } as never);
    mockControllerStatus('online');
    await expect(continueWorkflowInstance('user-1', 'inst-1', mappingOf())).rejects.toThrow(
      CONTINUATION_MESSAGES.available,
    );
  });

  it('T-CONT5 映射校验：缺失/多余/重复 → 必须恰好覆盖；非 AI/已完成 → 含非 AI；Harness 不支持', async () => {
    const base = mappingOf();
    await expect(
      continueWorkflowInstance('user-1', 'inst-1', {
        ...base,
        harnessMappings: [{ nodeId: 'n-ai-1', acpServerType: 'kimi_code' }],
      }),
    ).rejects.toThrow(CONTINUATION_MESSAGES.mappingsNotExact);

    await expect(
      continueWorkflowInstance('user-1', 'inst-1', {
        ...base,
        harnessMappings: [
          ...base.harnessMappings,
          { nodeId: 'n-unknown', acpServerType: 'opencode' },
        ],
      }),
    ).rejects.toThrow(CONTINUATION_MESSAGES.mappingsNotExact);

    await expect(
      continueWorkflowInstance('user-1', 'inst-1', {
        ...base,
        harnessMappings: [
          base.harnessMappings[0],
          base.harnessMappings[0],
          base.harnessMappings[1],
        ],
      }),
    ).rejects.toThrow(CONTINUATION_MESSAGES.mappingsNotExact);

    await expect(
      continueWorkflowInstance('user-1', 'inst-1', {
        ...base,
        harnessMappings: [
          ...base.harnessMappings,
          { nodeId: 'n-ai-done', acpServerType: 'opencode' },
        ],
      }),
    ).rejects.toThrow(CONTINUATION_MESSAGES.mappingInvalidNode('验收'));

    await expect(
      continueWorkflowInstance('user-1', 'inst-1', {
        ...base,
        harnessMappings: [
          { nodeId: 'n-ai-1', acpServerType: 'cursor' },
          base.harnessMappings[1],
        ],
      }),
    ).rejects.toThrow(CONTINUATION_MESSAGES.harnessUnsupported('cursor'));
    expect(WorkflowInstance.updateOne).not.toHaveBeenCalled();
  });

  it('T-CONT6 目标控制器归属/离线：能力校验错误原样冒泡', async () => {
    vi.mocked(getAvailableServerTypes).mockRejectedValue(new Error('控制器不存在或不属于当前用户'));
    await expect(continueWorkflowInstance('user-1', 'inst-1', mappingOf())).rejects.toThrow(
      '控制器不存在或不属于当前用户',
    );

    vi.mocked(getAvailableServerTypes).mockRejectedValue(
      new Error('控制器「x」的 Agent 能力信息不可用（可能离线），请确认控制器在线后重试'),
    );
    await expect(continueWorkflowInstance('user-1', 'inst-1', mappingOf())).rejects.toThrow(
      /能力信息不可用/,
    );
  });

  it('T-CONT7 目标工作区不属于目标控制器 → 拒绝', async () => {
    vi.mocked(ControllerWorkspace.findOne).mockReturnValue({ lean: () => Promise.resolve(null) } as never);
    await expect(continueWorkflowInstance('user-1', 'inst-1', mappingOf())).rejects.toThrow(
      CONTINUATION_MESSAGES.workspaceInvalid,
    );
  });

  it('T-CONT8 RUNNING/REWORK 的 AI 节点收敛 FAILED(CONTROLLER_UNAVAILABLE)；单节点失败仅告警', async () => {
    vi.mocked(workflowEngine.transition)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error('transition failed'));

    await expect(continueWorkflowInstance('user-1', 'inst-1', mappingOf())).resolves.toBe(updated);

    expect(workflowEngine.transition).toHaveBeenCalledTimes(2);
    expect(workflowEngine.transition).toHaveBeenNthCalledWith(1, 'inst-1', 'n-ai-1', 'fail', {
      reason: CONTINUATION_MESSAGES.nodeFailedReason,
      source: 'CONTROLLER_UNAVAILABLE',
    });
    expect(workflowEngine.transition).toHaveBeenNthCalledWith(2, 'inst-1', 'n-ai-2', 'fail', {
      reason: CONTINUATION_MESSAGES.nodeFailedReason,
      source: 'CONTROLLER_UNAVAILABLE',
    });
    // 人类 RUNNING / AI DONE / AI READY 不参与收敛（实例内无 READY AI 节点，验证集合口径）
    const nodeIds = vi.mocked(workflowEngine.transition).mock.calls.map((call) => call[1]);
    expect(nodeIds).not.toContain('n-human');
    expect(nodeIds).not.toContain('n-ai-done');
  });

  it('T-CONT10 createWorkflowWorktree=false：不创建，worktree 字段清空，映射仍生效', async () => {
    await continueWorkflowInstance('user-1', 'inst-1', mappingOf({ createWorkflowWorktree: false }));

    expect(createWorkflowWorktree).not.toHaveBeenCalled();
    const [, update] = vi.mocked(WorkflowInstance.updateOne).mock.calls[0];
    const set = (update as { $set: Record<string, unknown> }).$set;
    expect(set.workflowWorktreePath).toBeNull();
    expect(set.workflowWorktreeBranch).toBeNull();
    expect(set['nodes.$[h0].agentConfig.acpServerType']).toBe('kimi_code');
  });
});
