import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../models/configured-workflow.js', () => ({
  ConfiguredWorkflow: {
    findOne: vi.fn(),
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
  },
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

import { workflowInstanceService } from './instance.js';
import { workflowEngine } from './engine.js';
import { ConfiguredWorkflow } from '../../models/configured-workflow.js';
import { ControllerWorkspace } from '../../models/controller-workspace.js';
import { WorkflowInstance } from '../../models/workflow-instance.js';
import { Session } from '../../models/session.js';
import { sessionService } from '../session.js';

function oid(id: string) {
  return { toString: () => id } as import('mongoose').Types.ObjectId;
}

function leanQuery(result: unknown) {
  return { lean: vi.fn().mockResolvedValue(result) } as never;
}

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

describe('WorkflowInstanceService.instantiate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ConfiguredWorkflow.findOne).mockReturnValue(leanQuery(makeConfigured()));
    vi.mocked(ControllerWorkspace.findOne).mockReturnValue(leanQuery(makeWorkspace()));
  });

  it('正常实例化：首节点 READY，其余 INITIALIZING，dependsOn 映射为实例节点 nodeId', async () => {
    vi.mocked(WorkflowInstance.create).mockImplementation(async (doc) => doc as never);

    await workflowInstanceService.instantiate('user-1', 'cfg-1', 'ws-1', '需求A开发');

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
      }[];
    };
    expect(created).toMatchObject({
      userId: 'user-1',
      workspaceId: 'ws-1',
      configuredWorkflowId: 'cfg-1',
      name: '需求A开发',
      currentNodeNames: [],
    });
    expect(created.nodes).toHaveLength(2);
    // 首节点（人类，无上游）READY
    expect(created.nodes[0]).toMatchObject({ nodeKey: 'requirement', status: 'READY', reworkCount: 0 });
    // 其余 INITIALIZING，dependsOn 已映射为首节点的 nodeId
    expect(created.nodes[1]).toMatchObject({ nodeKey: 'design', status: 'INITIALIZING' });
    expect(created.nodes[1].dependsOn).toEqual([created.nodes[0].nodeId]);
    expect(created.nodes[0].nodeId).toBeTruthy();
  });

  it('已配置工作流不存在时拒绝', async () => {
    vi.mocked(ConfiguredWorkflow.findOne).mockReturnValue(leanQuery(null));
    await expect(workflowInstanceService.instantiate('user-1', 'cfg-x', 'ws-1', 'x')).rejects.toThrow(/不存在/);
    expect(WorkflowInstance.create).not.toHaveBeenCalled();
  });

  it('工作区不存在或不属于该控制器时拒绝', async () => {
    vi.mocked(ControllerWorkspace.findOne).mockReturnValue(leanQuery(null));
    await expect(workflowInstanceService.instantiate('user-1', 'cfg-1', 'ws-x', 'x')).rejects.toThrow(/工作区/);
  });

  it('O5: 模板含 requiresWorktree 节点但工作区非 git（无默认分支）时拒绝实例化', async () => {
    vi.mocked(ControllerWorkspace.findOne).mockReturnValue(leanQuery(makeWorkspace({ defaultBranch: null })));
    await expect(workflowInstanceService.instantiate('user-1', 'cfg-1', 'ws-1', 'x')).rejects.toThrow(
      /Git|git/,
    );
    expect(WorkflowInstance.create).not.toHaveBeenCalled();
  });

  it('O5b: 无 requiresWorktree 节点时非 git 工作区也可实例化', async () => {
    const configured = makeConfigured();
    configured.nodes[1].requiresWorktree = false;
    vi.mocked(ConfiguredWorkflow.findOne).mockReturnValue(leanQuery(configured));
    vi.mocked(ControllerWorkspace.findOne).mockReturnValue(leanQuery(makeWorkspace({ defaultBranch: null })));
    vi.mocked(WorkflowInstance.create).mockImplementation(async (doc) => doc as never);

    await expect(workflowInstanceService.instantiate('user-1', 'cfg-1', 'ws-1', 'x')).resolves.toBeTruthy();
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
  it('人类打回：走引擎 reject 转移', async () => {
    const instance = {
      _id: oid('inst-1'),
      nodes: [{ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', status: 'RUNNING', dependsOn: ['n1'] }],
    };
    vi.mocked(WorkflowInstance.findOne).mockReturnValue(leanQuery(instance));
    vi.mocked(workflowEngine.transition).mockResolvedValue({} as never);

    await workflowInstanceService.rejectNode('user-1', 'inst-1', 'n2', '方案不完整');

    expect(workflowEngine.transition).toHaveBeenCalledWith('inst-1', 'n2', 'reject', {
      reason: '方案不完整',
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
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(workflowInstanceService.deleteInstance('user-1', 'inst-1')).resolves.toBe(true);

    expect(sessionService.delete).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('实例不存在、无权限或已删除时拒绝', async () => {
    vi.mocked(WorkflowInstance.findOne).mockReturnValue(leanQuery(null));

    await expect(workflowInstanceService.deleteInstance('user-1', 'inst-x')).rejects.toThrow(/不存在/);
    expect(WorkflowInstance.updateOne).not.toHaveBeenCalled();
    expect(sessionService.delete).not.toHaveBeenCalled();
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
