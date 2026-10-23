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
      unregisterByInstance: vi.fn(),
      markEventHandled: vi.fn(),
    },
  };
});

vi.mock('./instance.js', () => ({
  workflowInstanceService: {
    setAdditionalPrompt: vi.fn(),
    completeHumanNode: vi.fn(),
    rejectNode: vi.fn(),
  },
}));

import { handlePullRequestEvent } from './pr-event-handler.js';
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
    loadInstance(linear());
    vi.mocked(workflowInstanceService.setAdditionalPrompt).mockResolvedValue({} as never);
    vi.mocked(workflowInstanceService.completeHumanNode).mockResolvedValue({} as never);
    vi.mocked(workflowInstanceService.rejectNode).mockResolvedValue({} as never);
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
      handler({ lastEventId: 'evt-1' }),
    ] as never);
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
    expect(workflowInstanceService.setAdditionalPrompt).toHaveBeenCalledWith(
      'user-1', 'inst-1', 'github-pr-review', expect.stringContaining('Pull Request审核通过'),
    );
    expect(workflowInstanceService.completeHumanNode).toHaveBeenCalledWith('user-1', 'inst-1', 'n2');
    expect(
      vi.mocked(workflowInstanceService.setAdditionalPrompt).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(workflowInstanceService.completeHumanNode).mock.invocationCallOrder[0]);
    expect(prHandlerRegistry.markEventHandled).toHaveBeenCalledWith('h1', 'evt-1', expect.any(Date));
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
    expect(warn).toHaveBeenCalled();
  });

  it('同一 PR 关联两个实例：各自处理并汇总 results', async () => {
    vi.mocked(prHandlerRegistry.findByPullRequestId).mockResolvedValue([
      handler({ _id: 'h1', workflowInstanceId: oid('inst-1') }),
      handler({ _id: 'h2', workflowInstanceId: oid('inst-2') }),
    ] as never);
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
