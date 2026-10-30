import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../models/workflow-instance.js', () => ({
  WorkflowInstance: { findById: vi.fn() },
}));

vi.mock('./pr-handler-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pr-handler-registry.js')>();
  return {
    ...actual,
    prHandlerRegistry: {
      findByPullRequestId: vi.fn(),
      findById: vi.fn(),
      unregisterByInstance: vi.fn(),
      markEventHandled: vi.fn(),
    },
  };
});

vi.mock('./instance.js', () => ({
  workflowInstanceService: {
    setAdditionalPrompt: vi.fn(),
    setSystemAdditionalPrompt: vi.fn(),
    removeSystemAdditionalPrompt: vi.fn(),
    completeHumanNode: vi.fn(),
    rejectNode: vi.fn(),
  },
}));

const ws = vi.hoisted(() => ({ systemWorkspaceContext: vi.fn() }));
vi.mock('../workspace-service.js', () => ({
  workspaceService: ws,
}));

import { handlePullRequestEvent } from './pr-event-handler.js';
import { getWorkspaceContext } from '../workspace-context.js';
import { WorkflowInstance } from '../../models/workflow-instance.js';
import { prHandlerRegistry } from './pr-handler-registry.js';
import { workflowInstanceService } from './instance.js';
import type { EventCallbackPayload } from './pr-event-payload.js';

function oid(id: string) {
  return { toString: () => id } as import('mongoose').Types.ObjectId;
}

function node(nodeId: string, type: string, status: string, dependsOn: string[] = []) {
  return { nodeId, nodeKey: nodeId, type, name: `节点${nodeId}`, status, dependsOn };
}

function instance(nodes: ReturnType<typeof node>[], overrides: Record<string, unknown> = {}) {
  return { _id: oid('inst-1'), userId: oid('user-1'), nodes, ...overrides };
}

function handler(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'h1',
    workflowInstanceId: oid('inst-1'),
    nodeId: 'n1',
    lastEventId: null,
    ...overrides,
  };
}

function event(reviewState: string, overrides: Partial<EventCallbackPayload> = {}): EventCallbackPayload {
  return {
    eventType: 'pull_request',
    eventId: 'evt-1',
    payload: {
      pullRequestId: 'a/b#1',
      prUrl: 'https://github.com/a/b/pull/1',
      reviewState,
      comment: '请调整',
      reviewer: 'alice',
      submittedAt: '2026-10-23T06:00:00Z',
    },
    ...overrides,
  };
}

const linear = () => instance([
  node('n1', 'AI', 'DONE'),
  node('n2', 'HUMAN', 'RUNNING', ['n1']),
  node('n3', 'AI', 'INITIALIZING', ['n2']),
]);

function loadInstance(value: unknown) {
  vi.mocked(WorkflowInstance.findById).mockReturnValue({
    lean: vi.fn().mockResolvedValue(value),
  } as never);
}

describe('handlePullRequestEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prHandlerRegistry.findByPullRequestId).mockResolvedValue([handler()] as never);
    vi.mocked(prHandlerRegistry.findById).mockResolvedValue(handler() as never);
    vi.mocked(prHandlerRegistry.markEventHandled).mockResolvedValue(undefined as never);
    loadInstance(linear());
    vi.mocked(workflowInstanceService.setSystemAdditionalPrompt).mockResolvedValue({} as never);
    vi.mocked(workflowInstanceService.removeSystemAdditionalPrompt).mockResolvedValue(undefined as never);
    vi.mocked(workflowInstanceService.completeHumanNode).mockResolvedValue({} as never);
    vi.mocked(workflowInstanceService.rejectNode).mockResolvedValue({} as never);
    ws.systemWorkspaceContext.mockResolvedValue(undefined);
  });

  it('NO_HANDLER', async () => {
    vi.mocked(prHandlerRegistry.findByPullRequestId).mockResolvedValue([] as never);
    const result = await handlePullRequestEvent(event('approved'));
    expect(result).toEqual({ handled: false, reason: 'NO_HANDLER', results: [] });
  });

  it.each([
    ['INSTANCE_NOT_FOUND', null],
    ['INSTANCE_DELETED', instance([], { deletedAt: new Date() })],
    ['INSTANCE_ARCHIVED', instance([], { archivedAt: new Date() })],
    ['INSTANCE_FINISHED', instance([node('n1', 'AI', 'DONE')])],
    ['INSTANCE_FINISHED', instance([node('n1', 'AI', 'DONE')], { finishedAt: new Date() })],
  ])('%s', async (reason, value) => {
    loadInstance(value);
    const result = await handlePullRequestEvent(event('approved'));
    expect(result.results[0].reason).toBe(reason);
    expect(prHandlerRegistry.unregisterByInstance).toHaveBeenCalled();
  });

  it('DUPLICATE_EVENT 优先于节点判定', async () => {
    vi.mocked(prHandlerRegistry.findByPullRequestId).mockResolvedValue([
      handler(),
    ] as never);
    vi.mocked(prHandlerRegistry.findById).mockResolvedValue(
      handler({ lastEventId: 'evt-1' }) as never,
    );
    loadInstance(instance([node('n9', 'AI', 'RUNNING')]));
    const result = await handlePullRequestEvent(event('approved'));
    expect(result.results[0].reason).toBe('DUPLICATE_EVENT');
  });

  it('CURRENT_NODE_NOT_HUMAN', async () => {
    loadInstance(instance([node('n1', 'AI', 'RUNNING')]));
    const result = await handlePullRequestEvent(event('approved'));
    expect(result.results[0].reason).toBe('CURRENT_NODE_NOT_HUMAN');
  });

  it('CURRENT_NODE_AMBIGUOUS', async () => {
    loadInstance(
      instance([node('n1', 'AI', 'DONE'), node('n2', 'HUMAN', 'RUNNING', ['n1']), node('n3', 'HUMAN', 'READY', ['n1'])]),
    );
    const result = await handlePullRequestEvent(event('approved'));
    expect(result.results[0].reason).toBe('CURRENT_NODE_AMBIGUOUS');
  });

  it('LINK_BROKEN（登记节点不是当前人类节点的上游 AI）', async () => {
    loadInstance(
      instance([node('n1', 'HUMAN', 'DONE'), node('n2', 'HUMAN', 'RUNNING', ['n1'])]),
    );
    const result = await handlePullRequestEvent(event('approved'));
    expect(result.results[0].reason).toBe('LINK_BROKEN');
  });

  it('HUMAN_NODE_IN_BETWEEN', async () => {
    loadInstance(
      instance([
        node('n1', 'AI', 'DONE'),
        node('h2', 'HUMAN', 'DONE', ['n1']),
        node('n2', 'HUMAN', 'RUNNING', ['h2']),
      ]),
    );
    const result = await handlePullRequestEvent(event('approved'));
    expect(result.results[0].reason).toBe('HUMAN_NODE_IN_BETWEEN');
  });

  it('UNSUPPORTED_REVIEW_STATE', async () => {
    const result = await handlePullRequestEvent(event('commented'));
    expect(result.results[0].reason).toBe('UNSUPPORTED_REVIEW_STATE');
  });

  it('approved：先写 github-pr-review 再完成人类节点', async () => {
    const result = await handlePullRequestEvent(event('approved'));

    expect(result.handled).toBe(true);
    expect(result.results[0]).toMatchObject({
      action: 'COMPLETE_HUMAN_NODE',
      nodeId: 'n2',
      promptKey: 'github-pr-review',
    });
    expect(workflowInstanceService.setSystemAdditionalPrompt).toHaveBeenCalledWith(
      'inst-1', 'github-pr-review', expect.stringContaining('Pull Request审核通过'),
    );
    expect(workflowInstanceService.completeHumanNode).toHaveBeenCalledWith('user-1', 'inst-1', 'n2');
    expect(
      vi.mocked(workflowInstanceService.setSystemAdditionalPrompt).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(workflowInstanceService.completeHumanNode).mock.invocationCallOrder[0]);
    expect(prHandlerRegistry.markEventHandled).toHaveBeenCalledWith('h1', 'evt-1', expect.any(Date));
  });

  it('T-EVT-TEAM: 团队租户实例在系统工作区上下文中完成节点', async () => {
    loadInstance(
      instance(
        [node('n1', 'AI', 'DONE'), node('n2', 'HUMAN', 'RUNNING', ['n1'])],
        { resourceWorkspaceId: oid('ws-team') },
      ),
    );
    ws.systemWorkspaceContext.mockResolvedValue({
      id: 'ws-team',
      tenantId: 'team-1',
      type: 'normal',
      role: 'admin',
      readOnly: false,
      globalWorkspaceId: 'ws-global',
    });

    let seen: ReturnType<typeof getWorkspaceContext> | undefined;
    vi.mocked(workflowInstanceService.completeHumanNode).mockImplementation(async () => {
      seen = getWorkspaceContext();
      return {} as never;
    });

    const result = await handlePullRequestEvent(event('approved'));

    expect(result.handled).toBe(true);
    expect(ws.systemWorkspaceContext).toHaveBeenCalledWith('ws-team');
    expect(seen?.tenantId).toBe('team-1');
    expect(seen?.role).toBe('admin');
    // 打回分支同样在上下文内
    vi.mocked(workflowInstanceService.rejectNode).mockImplementation(async () => {
      seen = getWorkspaceContext();
      return {} as never;
    });
    await handlePullRequestEvent(event('changes_requested'));
    expect(seen?.tenantId).toBe('team-1');
  });

  it.each(['changes_requested', 'rejected', 'dismissed'])('%s → 打回并携带 A.3 文案', async (state) => {
    const result = await handlePullRequestEvent(event(state));
    expect(result.results[0].action).toBe('REJECT_HUMAN_NODE');
    expect(workflowInstanceService.rejectNode).toHaveBeenCalledWith(
      'user-1', 'inst-1', 'n2', expect.stringContaining('注意检查pr的inline comment'),
    );
  });

  it('HANDLER_FAILED（驱动异常被捕获）', async () => {
    vi.mocked(workflowInstanceService.completeHumanNode).mockRejectedValue(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await handlePullRequestEvent(event('approved'));
    expect(result.handled).toBe(false);
    expect(result.results[0].reason).toBe('HANDLER_FAILED');
    expect(result.results[0].registeredNodeId).toBe('n1');
    expect(warn).toHaveBeenCalled();
    // C-3：流转失败回滚已写入的系统提示词
    expect(workflowInstanceService.removeSystemAdditionalPrompt).toHaveBeenCalledWith(
      'inst-1',
      'github-pr-review',
    );
  });

  it('R-8: 同一 eventId 并发重复投递恰一次完成，另一次 DUPLICATE_EVENT（无 HANDLER_FAILED）', async () => {
    let lastEventId: string | null = null;
    vi.mocked(prHandlerRegistry.findById).mockImplementation(async () =>
      handler({ lastEventId }) as never,
    );
    vi.mocked(prHandlerRegistry.markEventHandled).mockImplementation(
      async (_id, eventId) => {
        lastEventId = eventId;
      },
    );

    const [first, second] = await Promise.all([
      handlePullRequestEvent(event('approved')),
      handlePullRequestEvent(event('approved')),
    ]);

    const results = [...first.results, ...second.results];
    expect(results.filter((r) => r.action === 'COMPLETE_HUMAN_NODE')).toHaveLength(1);
    expect(results.filter((r) => r.reason === 'DUPLICATE_EVENT')).toHaveLength(1);
    expect(results.some((r) => r.reason === 'HANDLER_FAILED')).toBe(false);
    expect(workflowInstanceService.completeHumanNode).toHaveBeenCalledTimes(1);
  });

  it('同一 PR 关联两个实例：各自处理并汇总 results', async () => {
    vi.mocked(prHandlerRegistry.findByPullRequestId).mockResolvedValue([
      handler({ _id: 'h1', workflowInstanceId: oid('inst-1') }),
      handler({ _id: 'h2', workflowInstanceId: oid('inst-2') }),
    ] as never);
    vi.mocked(prHandlerRegistry.findById).mockImplementation(async (id) =>
      (id === 'h2'
        ? handler({ _id: 'h2', workflowInstanceId: oid('inst-2') })
        : handler({ _id: 'h1', workflowInstanceId: oid('inst-1') })) as never,
    );
    vi.mocked(WorkflowInstance.findById).mockImplementation(((id: string) =>
      ({
        lean: vi.fn().mockResolvedValue(
          id === 'inst-1'
            ? linear()
            : { ...linear(), _id: oid('inst-2') },
        ),
      }) as never) as never);

    const result = await handlePullRequestEvent(event('approved'));
    expect(result.handled).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.action === 'COMPLETE_HUMAN_NODE')).toBe(true);
  });
});
