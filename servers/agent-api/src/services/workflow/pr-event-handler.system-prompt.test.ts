import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * P0 回归：不 mock instance.ts，验证事件处理器能写入系统键 `github-pr-review`，
 * 而人工入口 setAdditionalPrompt 仍拒绝系统键。
 */

const h = vi.hoisted(() => ({
  instance: {
    _id: { toString: () => 'inst-1' },
    userId: { toString: () => 'user-1' },
    nodes: [
      { nodeId: 'n1', nodeKey: 'exec', type: 'AI', name: '执行', status: 'DONE', dependsOn: [] },
      { nodeId: 'n2', nodeKey: 'review', type: 'HUMAN', name: '审核', status: 'RUNNING', dependsOn: ['n1'] },
    ],
    deletedAt: null,
    archivedAt: null,
    finishedAt: null,
  },
}));

vi.mock('../../models/workflow-instance.js', () => ({
  WorkflowInstance: {
    findById: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
  },
}));

vi.mock('../../middleware/redis.js', () => ({
  getRedisClient: () => ({ del: vi.fn().mockResolvedValue(1) }),
}));

vi.mock('./engine.js', () => ({
  workflowEngine: { transition: vi.fn().mockResolvedValue({}) },
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

import { WorkflowInstance } from '../../models/workflow-instance.js';
import { workflowEngine } from './engine.js';
import { prHandlerRegistry } from './pr-handler-registry.js';
import { workflowInstanceService } from './instance.js';
import { handlePullRequestEvent } from './pr-event-handler.js';

function lean(value: unknown) {
  return { lean: vi.fn().mockResolvedValue(value) };
}

const event = {
  eventType: 'pull_request' as const,
  eventId: 'evt-p0',
  payload: {
    pullRequestId: 'Deliay/z-agent-gear#264',
    prUrl: 'https://github.com/Deliay/z-agent-gear/pull/264',
    reviewState: 'approved',
    comment: 'LGTM',
    reviewer: 'alice',
    submittedAt: '2026-10-23T06:00:00Z',
  },
};

describe('系统键写入通道（不 mock instance.ts）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(WorkflowInstance.findById).mockReturnValue(lean(h.instance) as never);
    vi.mocked(WorkflowInstance.findOne).mockReturnValue(lean(h.instance) as never);
    vi.mocked(WorkflowInstance.findOneAndUpdate).mockReturnValue(lean(h.instance) as never);
    vi.mocked(WorkflowInstance.updateOne).mockResolvedValue({} as never);
    vi.mocked(prHandlerRegistry.findByPullRequestId).mockResolvedValue([
      {
        _id: 'h1',
        workflowInstanceId: { toString: () => 'inst-1' },
        nodeId: 'n1',
        lastEventId: null,
      },
    ] as never);
  });

  it('approved 事件可写入 github-pr-review 并完成人类节点', async () => {
    const result = await handlePullRequestEvent(event);

    expect(result.handled).toBe(true);
    expect(result.results[0]).toMatchObject({
      action: 'COMPLETE_HUMAN_NODE',
      promptKey: 'github-pr-review',
      nodeId: 'n2',
      registeredNodeId: 'n1',
    });
    expect(WorkflowInstance.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'inst-1', deletedAt: null },
      {
        $set: {
          'additionalPrompts.github-pr-review': expect.stringContaining('Pull Request审核通过'),
        },
      },
      { new: true },
    );
    expect(workflowEngine.transition).toHaveBeenCalledWith('inst-1', 'n2', 'complete', {
      artifacts: [],
    });
  });

  it('人工 setAdditionalPrompt 仍拒绝系统键与 github-pr', async () => {
    await expect(
      workflowInstanceService.setAdditionalPrompt('user-1', 'inst-1', 'github-pr-review', 'x'),
    ).rejects.toThrow(/系统保留/);
    await expect(
      workflowInstanceService.setAdditionalPrompt('user-1', 'inst-1', 'github-pr', 'x'),
    ).rejects.toThrow(/系统保留/);
    expect(WorkflowInstance.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('系统写入口拒绝非系统键', async () => {
    await expect(
      workflowInstanceService.setSystemAdditionalPrompt('inst-1', 'my-note', 'x'),
    ).rejects.toThrow(/仅允许系统内部写入/);
  });
});
