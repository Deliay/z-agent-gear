import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  triggerFindById: vi.fn(),
  triggerUpdateOne: vi.fn(),
  triggerCreate: vi.fn(),
  triggerFind: vi.fn(),
  opFindById: vi.fn(),
  opFindOne: vi.fn(),
  opUpdateOne: vi.fn(),
  workflowFindOne: vi.fn(),
  workspaceFindOne: vi.fn(),
  controllerFindById: vi.fn(),
  systemWorkspaceContext: vi.fn(),
  instanceFindById: vi.fn(),
  findHost: vi.fn(),
  defaultWorkspace: vi.fn(),
  createOperation: vi.fn(),
  ensureWorkspace: vi.fn(),
  comment: vi.fn(),
  resolveRepoAccount: vi.fn(),
  instantiate: vi.fn(),
  completeHumanNode: vi.fn(),
  resolveDefaultBranch: vi.fn(),
  resolveWorktreeCommitter: vi.fn(),
}));

vi.mock('../../models/issue-workflow-trigger.js', () => ({
  ISSUE_TRIGGER_STATUSES: [],
  IssueWorkflowTrigger: {
    findById: h.triggerFindById,
    updateOne: h.triggerUpdateOne,
    create: h.triggerCreate,
    find: h.triggerFind,
  },
}));
vi.mock('../../models/cloud-host-setup-operation.js', () => ({
  CloudHostSetupOperation: {
    findById: h.opFindById,
    findOne: h.opFindOne,
    updateOne: h.opUpdateOne,
  },
}));
vi.mock('../../models/configured-workflow.js', () => ({
  ConfiguredWorkflow: { findOne: h.workflowFindOne },
}));
vi.mock('../../models/controller-workspace.js', () => ({
  ControllerWorkspace: { findOne: h.workspaceFindOne },
}));
vi.mock('../../models/controller.js', () => ({
  Controller: { findById: h.controllerFindById },
}));
vi.mock('../workspace-service.js', () => ({
  workspaceService: { systemWorkspaceContext: h.systemWorkspaceContext },
}));
vi.mock('../../models/workflow-instance.js', () => ({
  WorkflowInstance: { findById: h.instanceFindById },
}));
vi.mock('../cloud-host-service.js', () => ({
  cloudHostService: {
    findOwnedRawHostByController: h.findHost,
    defaultWorkspace: h.defaultWorkspace,
  },
}));
vi.mock('../cloud-host-github-service.js', () => ({
  cloudHostGithubService: { createOperation: h.createOperation },
}));
vi.mock('../cloud-host-workload-service.js', () => ({
  sanitizeOperationError: (err: { message?: string } | string) =>
    typeof err === 'string' ? err : err.message ?? 'error',
}));
vi.mock('../controller-workspace.js', () => ({
  controllerWorkspaceService: { ensureWorkspace: h.ensureWorkspace },
}));
vi.mock('../github.js', () => ({
  githubService: { createIssueComment: h.comment, resolveRepoAccount: h.resolveRepoAccount },
}));
vi.mock('./instance.js', () => ({
  workflowInstanceService: {
    instantiate: h.instantiate,
    completeHumanNode: h.completeHumanNode,
  },
}));
vi.mock('../workspace-path.js', () => ({
  normalizeWorkspacePrefix: (value: string) => value,
  resolveClonePath: (prefix: string, repo: string) => `${prefix}/${repo}`,
}));
vi.mock('../workspace-default-branch.js', () => ({
  resolveWorkspaceDefaultBranch: h.resolveDefaultBranch,
}));
vi.mock('../commit-settings-service.js', () => ({
  commitSettingsService: { resolveWorktreeCommitter: h.resolveWorktreeCommitter },
}));

import { IssuesTriggerRunner } from './issues-event-handler.js';

const TRIGGER_ID = '507f1f77bcf86cd799439021';
const CONTROLLER_ID = '507f1f77bcf86cd799439022';
const WORKSPACE_ID = '507f1f77bcf86cd799439023';
const INSTANCE_ID = '507f1f77bcf86cd799439024';
const USER_ID = '507f1f77bcf86cd799439025';

const lean = (value: unknown) => ({ lean: vi.fn().mockResolvedValue(value) });

function triggerDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: TRIGGER_ID,
    userId: USER_ID,
    controllerId: CONTROLLER_ID,
    configuredWorkflowId: '507f1f77bcf86cd799439026',
    labelName: 'start-dev',
    repoFullName: 'Deliay/z-agent-gear',
    issueId: '123',
    issueNumber: 42,
    issueTitle: '接入联动',
    issueBody: '正文',
    issueUrl: 'https://github.com/Deliay/z-agent-gear/issues/42',
    issueAuthor: 'octocat',
    status: 'PENDING_WORKSPACE',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function instanceDoc(nodes: Array<{ nodeId: string; status: string }>, overrides = {}) {
  return {
    _id: INSTANCE_ID,
    deletedAt: null,
    archivedAt: null,
    nodes,
    ...overrides,
  };
}

let runner: IssuesTriggerRunner;

beforeEach(() => {
  vi.clearAllMocks();
  runner = new IssuesTriggerRunner({ pollIntervalMs: 1 });
  h.triggerFindById.mockReturnValue(lean(triggerDoc()));
  h.triggerUpdateOne.mockResolvedValue({});
  h.opUpdateOne.mockResolvedValue({});
  h.workflowFindOne.mockReturnValue(
    lean({
      name: '开发流程',
      nodes: [{ nodeKey: 'human', type: 'HUMAN', name: '确认', stage: '默认阶段', dependsOn: [] }],
    }),
  );
  h.workspaceFindOne.mockReturnValue(lean(null));
  h.controllerFindById.mockReturnValue({ select: () => lean({ workspaceId: null }) });
  h.systemWorkspaceContext.mockResolvedValue(undefined);
  h.findHost.mockResolvedValue({ status: 'RUNNING', userId: USER_ID });
  h.defaultWorkspace.mockResolvedValue('/home/worker/workspace');
  h.resolveRepoAccount.mockResolvedValue('acc-1');
  h.comment.mockResolvedValue(99);
  h.resolveDefaultBranch.mockResolvedValue('main');
  h.resolveWorktreeCommitter.mockResolvedValue(null);
});

describe('IssuesTriggerRunner PENDING_WORKSPACE', () => {
  it('云电脑非 RUNNING → FAILED: CLOUD_HOST_NOT_RUNNING', async () => {
    h.findHost.mockResolvedValue({ status: 'STOPPED' });

    await runner.advance(TRIGGER_ID);

    expect(h.triggerUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: TRIGGER_ID }),
      { $set: { status: 'FAILED', failureReason: 'CLOUD_HOST_NOT_RUNNING' } },
    );
    expect(h.instantiate).not.toHaveBeenCalled();
  });

  it('工作区已存在 → 回写 workspaceId 并进入 PENDING_INSTANTIATE', async () => {
    h.workspaceFindOne.mockReturnValue(lean({ _id: WORKSPACE_ID }));

    await runner.advance(TRIGGER_ID);

    expect(h.triggerUpdateOne).toHaveBeenCalledWith(
      { _id: TRIGGER_ID, status: 'PENDING_WORKSPACE' },
      { $set: { workspaceId: WORKSPACE_ID, status: 'PENDING_INSTANTIATE' } },
    );
    expect(h.createOperation).not.toHaveBeenCalled();
  });

  it('工作区缺失 → createOperation(createSession:false) → 轮询终态后建工作区', async () => {
    h.opFindOne.mockReturnValue(lean(null));
    h.createOperation.mockResolvedValue({ id: '507f1f77bcf86cd799439027' });
    h.opFindById.mockReturnValue(lean({ status: 'SUCCEEDED' }));
    h.ensureWorkspace.mockResolvedValue({ id: WORKSPACE_ID });

    await runner.advance(TRIGGER_ID);

    expect(h.createOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        controllerId: CONTROLLER_ID,
        repoFullName: 'Deliay/z-agent-gear',
        targetPath: '/home/worker/workspace',
        createSession: false,
      }),
    );
    expect(h.ensureWorkspace).toHaveBeenCalledWith(
      CONTROLLER_ID,
      USER_ID,
      '/home/worker/workspace/Deliay/z-agent-gear',
    );
    expect(h.triggerUpdateOne).toHaveBeenCalledWith(
      { _id: TRIGGER_ID, status: 'PENDING_WORKSPACE' },
      { $set: { workspaceId: WORKSPACE_ID, status: 'PENDING_INSTANTIATE' } },
    );
  });

  it('工作区编排失败 → FAILED 且不实例化', async () => {
    h.opFindOne.mockReturnValue(lean(null));
    h.createOperation.mockResolvedValue({ id: '507f1f77bcf86cd799439027' });
    h.opFindById.mockReturnValue(lean({ status: 'FAILED', error: 'clone failed' }));

    await runner.advance(TRIGGER_ID);

    expect(h.ensureWorkspace).not.toHaveBeenCalled();
    expect(h.triggerUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: TRIGGER_ID }),
      { $set: { status: 'FAILED', failureReason: 'clone failed' } },
    );
  });
});

describe('IssuesTriggerRunner PENDING_INSTANTIATE', () => {
  it('工作流不存在 → FAILED: workflow not found', async () => {
    h.triggerFindById.mockReturnValue(lean(triggerDoc({ status: 'PENDING_INSTANTIATE', workspaceId: WORKSPACE_ID })));
    h.workflowFindOne.mockReturnValue(lean(null));

    await runner.advance(TRIGGER_ID);

    expect(h.instantiate).not.toHaveBeenCalled();
    expect(h.triggerUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: TRIGGER_ID }),
      { $set: { status: 'FAILED', failureReason: 'workflow not found' } },
    );
  });

  it('实例化成功 → 取执行序首个 HUMAN 并进入 PENDING_HUMAN_NODE', async () => {
    h.triggerFindById.mockReturnValue(lean(triggerDoc({ status: 'PENDING_INSTANTIATE', workspaceId: WORKSPACE_ID })));
    h.instantiate.mockResolvedValue({
      _id: INSTANCE_ID,
      nodes: [
        { nodeId: 'ai', type: 'AI', status: 'RUNNING', dependsOn: [] },
        { nodeId: 'human', type: 'HUMAN', status: 'INITIALIZING', dependsOn: ['ai'] },
      ],
    });

    await runner.advance(TRIGGER_ID);

    expect(h.instantiate).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        source: 'CONFIGURED',
        controllerId: CONTROLLER_ID,
        workspaceId: WORKSPACE_ID,
      }),
    );
    expect(h.triggerUpdateOne).toHaveBeenCalledWith(
      { _id: TRIGGER_ID },
      { $set: { workflowInstanceId: INSTANCE_ID, humanNodeId: 'human', status: 'PENDING_HUMAN_NODE' } },
    );
  });

  it('工作流无 HUMAN → COMPLETED 留痕且不阻塞', async () => {
    h.triggerFindById.mockReturnValue(lean(triggerDoc({ status: 'PENDING_INSTANTIATE', workspaceId: WORKSPACE_ID })));
    h.instantiate.mockResolvedValue({
      _id: INSTANCE_ID,
      nodes: [{ nodeId: 'ai', type: 'AI', status: 'READY', dependsOn: [] }],
    });

    await runner.advance(TRIGGER_ID);

    expect(h.triggerUpdateOne).toHaveBeenCalledWith(
      { _id: TRIGGER_ID },
      {
        $set: {
          workflowInstanceId: INSTANCE_ID,
          status: 'COMPLETED',
          failureReason: 'workflow has no human node',
        },
      },
    );
  });

  it('重复 advance 不重复实例化（锁内重读状态）', async () => {
    const pendingInstantiate = triggerDoc({ status: 'PENDING_INSTANTIATE', workspaceId: WORKSPACE_ID });
    h.triggerFindById.mockReturnValue(lean(pendingInstantiate));
    h.instantiate.mockResolvedValue({
      _id: INSTANCE_ID,
      nodes: [{ nodeId: 'human', type: 'HUMAN', status: 'INITIALIZING', dependsOn: [] }],
    });
    h.instanceFindById.mockReturnValue(lean(instanceDoc([{ nodeId: 'human', status: 'INITIALIZING' }])));

    await runner.advance(TRIGGER_ID);
    h.triggerFindById.mockReturnValue(
      lean(
        triggerDoc({
          status: 'PENDING_HUMAN_NODE',
          workflowInstanceId: INSTANCE_ID,
          humanNodeId: 'human',
        }),
      ),
    );
    await runner.advance(TRIGGER_ID);

    expect(h.instantiate).toHaveBeenCalledTimes(1);
  });
});

describe('IssuesTriggerRunner PENDING_HUMAN_NODE', () => {
  const humanTrigger = (overrides: Record<string, unknown> = {}) =>
    lean(
      triggerDoc({
        status: 'PENDING_HUMAN_NODE',
        workflowInstanceId: INSTANCE_ID,
        humanNodeId: 'human',
        ...overrides,
      }),
    );

  it('前置 AI 节点未就绪 → 不调用 completeHumanNode', async () => {
    h.triggerFindById.mockReturnValue(humanTrigger());
    h.instanceFindById.mockReturnValue(
      lean(instanceDoc([{ nodeId: 'human', status: 'INITIALIZING' }])),
    );

    await runner.advance(TRIGGER_ID);

    expect(h.completeHumanNode).not.toHaveBeenCalled();
  });

  it('节点 READY → 回评并自动完成（输入含 Issue 内容），随后 COMPLETED', async () => {
    h.triggerFindById.mockReturnValue(humanTrigger());
    h.instanceFindById.mockReturnValue(lean(instanceDoc([{ nodeId: 'human', status: 'READY' }])));

    await runner.advance(TRIGGER_ID);

    expect(h.comment).toHaveBeenCalledWith(
      USER_ID,
      'Deliay/z-agent-gear',
      42,
      expect.stringContaining('/workflows/'),
    );
    expect(h.completeHumanNode).toHaveBeenCalledWith(
      USER_ID,
      INSTANCE_ID,
      'human',
      expect.stringContaining('来源：GitHub Issue Deliay/z-agent-gear#42'),
    );
    expect(h.triggerUpdateOne).toHaveBeenCalledWith(
      { _id: TRIGGER_ID, status: 'PENDING_HUMAN_NODE' },
      { $set: { status: 'COMPLETED', completedNodeId: 'human' } },
    );
  });

  it('节点已 DONE → 直接 COMPLETED（幂等，不再完成）', async () => {
    h.triggerFindById.mockReturnValue(humanTrigger());
    h.instanceFindById.mockReturnValue(lean(instanceDoc([{ nodeId: 'human', status: 'DONE' }])));

    await runner.advance(TRIGGER_ID);

    expect(h.completeHumanNode).not.toHaveBeenCalled();
    expect(h.triggerUpdateOne).toHaveBeenCalledWith(
      { _id: TRIGGER_ID, status: 'PENDING_HUMAN_NODE' },
      { $set: { status: 'COMPLETED', completedNodeId: 'human' } },
    );
  });

  it('实例已删除/归档 → FAILED: workflow interrupted', async () => {
    h.triggerFindById.mockReturnValue(humanTrigger());
    h.instanceFindById.mockReturnValue(
      lean(instanceDoc([{ nodeId: 'human', status: 'READY' }], { deletedAt: new Date() })),
    );

    await runner.advance(TRIGGER_ID);

    expect(h.triggerUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: TRIGGER_ID }),
      { $set: { status: 'FAILED', failureReason: 'workflow interrupted' } },
    );
  });

  it('超过 24h → FAILED: human node timeout 且不再回评', async () => {
    h.triggerFindById.mockReturnValue(
      humanTrigger({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }),
    );
    h.instanceFindById.mockReturnValue(lean(instanceDoc([{ nodeId: 'human', status: 'READY' }])));

    await runner.advance(TRIGGER_ID);

    expect(h.comment).not.toHaveBeenCalled();
    expect(h.triggerUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: TRIGGER_ID }),
      { $set: { status: 'FAILED', failureReason: 'human node timeout' } },
    );
  });

  it('回评失败 → 仅记录 commentError，不阻断自动完成', async () => {
    h.triggerFindById.mockReturnValue(humanTrigger());
    h.instanceFindById.mockReturnValue(lean(instanceDoc([{ nodeId: 'human', status: 'READY' }])));
    h.comment.mockRejectedValue(new Error('comment failed'));

    await runner.advance(TRIGGER_ID);

    expect(h.triggerUpdateOne).toHaveBeenCalledWith(
      { _id: TRIGGER_ID },
      { $set: { commentError: 'comment failed' }, $inc: { commentAttempts: 1 } },
    );
    expect(h.completeHumanNode).toHaveBeenCalled();
  });

  it('回评仅补偿一次：attempts=1 重试，attempts>=2 不再调用', async () => {
    h.instanceFindById.mockReturnValue(lean(instanceDoc([{ nodeId: 'human', status: 'READY' }])));

    h.triggerFindById.mockReturnValue(humanTrigger({ commentAttempts: 1 }));
    await runner.advance(TRIGGER_ID);
    expect(h.comment).toHaveBeenCalledTimes(1);

    h.comment.mockClear();
    h.triggerFindById.mockReturnValue(humanTrigger({ commentAttempts: 2 }));
    await runner.advance(TRIGGER_ID);
    expect(h.comment).not.toHaveBeenCalled();
  });
});

describe('IssuesTriggerRunner 终态与快照', () => {
  it('COMPLETED / FAILED 记录不再推进', async () => {
    h.triggerFindById.mockReturnValue(lean(triggerDoc({ status: 'COMPLETED' })));
    await runner.advance(TRIGGER_ID);
    expect(h.triggerUpdateOne).not.toHaveBeenCalled();
    expect(h.instantiate).not.toHaveBeenCalled();
  });

  it('联动配置已删除仍按触发快照实例化（不依赖配置行）', async () => {
    h.triggerFindById.mockReturnValue(
      lean(triggerDoc({ status: 'PENDING_INSTANTIATE', workspaceId: WORKSPACE_ID })),
    );
    h.instantiate.mockResolvedValue({
      _id: INSTANCE_ID,
      nodes: [{ nodeId: 'human', type: 'HUMAN', status: 'INITIALIZING', dependsOn: [] }],
    });

    await runner.advance(TRIGGER_ID);

    expect(h.workflowFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: '507f1f77bcf86cd799439026' }),
    );
    expect(h.instantiate).toHaveBeenCalledTimes(1);
  });
});

describe('IssuesTriggerRunner 强制 Worktree 隔离', () => {
  const pendingInstantiate = () =>
    lean(triggerDoc({ status: 'PENDING_INSTANTIATE', workspaceId: WORKSPACE_ID }));

  it('R-WT1: instantiate 携带 createWorkflowWorktree: true', async () => {
    h.triggerFindById.mockReturnValue(pendingInstantiate());
    h.instantiate.mockResolvedValue({
      _id: INSTANCE_ID,
      nodes: [{ nodeId: 'human', type: 'HUMAN', status: 'INITIALIZING', dependsOn: [] }],
    });

    await runner.advance(TRIGGER_ID);

    expect(h.instantiate).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ createWorkflowWorktree: true }),
    );
  });

  it('R-WT2: 缺失默认分支时按 trigger.repoFullName 前置解析后实例化', async () => {
    h.triggerFindById.mockReturnValue(pendingInstantiate());
    h.instantiate.mockResolvedValue({
      _id: INSTANCE_ID,
      nodes: [{ nodeId: 'human', type: 'HUMAN', status: 'INITIALIZING', dependsOn: [] }],
    });

    await runner.advance(TRIGGER_ID);

    expect(h.resolveDefaultBranch).toHaveBeenCalledWith({
      userId: USER_ID,
      controllerId: CONTROLLER_ID,
      workspaceId: WORKSPACE_ID,
      repoFullName: 'Deliay/z-agent-gear',
    });
    expect(h.triggerUpdateOne).toHaveBeenCalledWith(
      { _id: TRIGGER_ID },
      { $set: { workflowInstanceId: INSTANCE_ID, humanNodeId: 'human', status: 'PENDING_HUMAN_NODE' } },
    );
  });

  it('R-WT3: 解析失败 → FAILED 且不调用 instantiate', async () => {
    h.triggerFindById.mockReturnValue(pendingInstantiate());
    h.resolveDefaultBranch.mockResolvedValue(null);

    await runner.advance(TRIGGER_ID);

    expect(h.triggerUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: TRIGGER_ID }),
      {
        $set: {
          status: 'FAILED',
          failureReason: 'cannot resolve workspace default branch (not a git repository?)',
        },
      },
    );
    expect(h.instantiate).not.toHaveBeenCalled();
  });

  it('R-WT4: instantiate 抛错 → FAILED 且原因可读', async () => {
    h.triggerFindById.mockReturnValue(pendingInstantiate());
    h.instantiate.mockRejectedValue(new Error('worktree add failed'));

    await runner.advance(TRIGGER_ID);

    expect(h.triggerUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: TRIGGER_ID }),
      { $set: { status: 'FAILED', failureReason: 'worktree add failed' } },
    );
  });
});

describe('IssuesTriggerRunner 团队租户工作区上下文', () => {
  it('T-ISS-CTX: 按控制器工作区建立上下文后再推进（团队租户 tenantId 不再是 userId）', async () => {
    const { getWorkspaceContext } = await import('../workspace-context.js');
    const ctx = {
      id: WORKSPACE_ID,
      tenantId: 'team-1',
      type: 'global',
      role: 'admin',
      readOnly: false,
      globalWorkspaceId: WORKSPACE_ID,
    } as const;
    h.triggerFindById.mockReturnValue(
      lean(
        triggerDoc({
          status: 'PENDING_HUMAN_NODE',
          workflowInstanceId: INSTANCE_ID,
          humanNodeId: 'h1',
        }),
      ),
    );
    h.instanceFindById.mockReturnValue(lean(instanceDoc([{ nodeId: 'h1', status: 'RUNNING' }])));
    h.controllerFindById.mockReturnValue({ select: () => lean({ workspaceId: WORKSPACE_ID }) });
    h.systemWorkspaceContext.mockResolvedValue(ctx);

    let seen: ReturnType<typeof getWorkspaceContext> | undefined;
    h.completeHumanNode.mockImplementation(async () => {
      seen = getWorkspaceContext();
      return {};
    });

    await runner.advance(TRIGGER_ID);

    expect(h.systemWorkspaceContext).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(seen?.tenantId).toBe('team-1');
    expect(seen?.role).toBe('admin');
  });
});

describe('IssuesTriggerRunner 触发人身份优先级（T-GH-S3/S4）', () => {
  const TRIGGER_USER_ID = '507f1f77bcf86cd799439041';

  const pending = (overrides: Record<string, unknown> = {}) =>
    lean(
      triggerDoc({
        status: 'PENDING_INSTANTIATE',
        workspaceId: WORKSPACE_ID,
        ...overrides,
      }),
    );

  function mockInstantiated() {
    h.instantiate.mockResolvedValue({
      _id: INSTANCE_ID,
      nodes: [{ nodeId: 'human', type: 'HUMAN', status: 'INITIALIZING', dependsOn: [] }],
    });
  }

  function instantiateArg(): Record<string, unknown> {
    return vi.mocked(h.instantiate).mock.calls[0][1] as Record<string, unknown>;
  }

  it('S3a: triggerUserId 的「提交人」优先（sender 身份不参与）', async () => {
    h.triggerFindById.mockReturnValue(
      pending({ triggerUserId: TRIGGER_USER_ID, triggerSenderId: 583231, triggerSenderLogin: 'octocat' }),
    );
    h.resolveWorktreeCommitter.mockResolvedValue({ name: 'Deliay', email: 'deliay@example.com' });
    mockInstantiated();

    await runner.advance(TRIGGER_ID);

    expect(h.resolveWorktreeCommitter).toHaveBeenCalledWith(TRIGGER_USER_ID);
    expect(instantiateArg().worktreeCommitter).toEqual({
      name: 'Deliay',
      email: 'deliay@example.com',
    });
  });

  it('S3b: 触发人未设置提交人 → 回退 sender 的 GitHub 身份（login + noreply）', async () => {
    h.triggerFindById.mockReturnValue(
      pending({ triggerUserId: TRIGGER_USER_ID, triggerSenderId: 583231, triggerSenderLogin: 'octocat' }),
    );
    h.resolveWorktreeCommitter.mockResolvedValue(null);
    mockInstantiated();

    await runner.advance(TRIGGER_ID);

    expect(instantiateArg().worktreeCommitter).toEqual({
      name: 'octocat',
      email: '583231+octocat@users.noreply.github.com',
    });
  });

  it('S3c: 未匹配平台成员但有 sender → 直接用 GitHub 身份', async () => {
    h.triggerFindById.mockReturnValue(
      pending({ triggerUserId: null, triggerSenderId: 583231, triggerSenderLogin: 'octocat' }),
    );
    mockInstantiated();

    await runner.advance(TRIGGER_ID);

    expect(h.resolveWorktreeCommitter).not.toHaveBeenCalled();
    expect(instantiateArg().worktreeCommitter).toEqual({
      name: 'octocat',
      email: '583231+octocat@users.noreply.github.com',
    });
  });

  it('S3d: 触发人不可识别（无 sender）→ null（沿用 bot）', async () => {
    h.triggerFindById.mockReturnValue(
      pending({ triggerUserId: null, triggerSenderId: null, triggerSenderLogin: null }),
    );
    mockInstantiated();

    await runner.advance(TRIGGER_ID);

    const arg = instantiateArg();
    expect(arg).toHaveProperty('worktreeCommitter', null);
    expect(arg.createWorkflowWorktree).toBe(true);
  });

  it('S4: Issue 触发人覆盖工作流创建者（不解析 trigger.userId 的提交人）', async () => {
    h.triggerFindById.mockReturnValue(
      pending({ triggerUserId: TRIGGER_USER_ID, triggerSenderId: 583231, triggerSenderLogin: 'octocat' }),
    );
    h.resolveWorktreeCommitter.mockImplementation(async (userId: string) =>
      userId === TRIGGER_USER_ID ? { name: 'trigger-user', email: 'trigger@example.com' } : null,
    );
    mockInstantiated();

    await runner.advance(TRIGGER_ID);

    expect(h.resolveWorktreeCommitter).toHaveBeenCalledTimes(1);
    expect(h.resolveWorktreeCommitter).not.toHaveBeenCalledWith(USER_ID);
    expect(instantiateArg().worktreeCommitter).toEqual({
      name: 'trigger-user',
      email: 'trigger@example.com',
    });
  });
});
