import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../models/workflow-pr-handler.js', () => ({
  WorkflowPrHandler: {
    find: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    deleteMany: vi.fn(),
    updateOne: vi.fn(),
  },
}));

vi.mock('./engine.js', () => ({
  workflowEngine: { registerHooks: vi.fn() },
}));

import { prHandlerRegistry, normalizePullRequestId, PullRequestIdError } from './pr-handler-registry.js';
import { WorkflowPrHandler } from '../../models/workflow-pr-handler.js';
import { workflowEngine } from './engine.js';

function lean(result: unknown) {
  return { lean: vi.fn().mockResolvedValue(result) };
}

function sortable(result: unknown) {
  return { sort: vi.fn().mockReturnValue(lean(result)) };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'h1',
    userId: 'user-1',
    workflowInstanceId: 'inst-1',
    nodeId: 'n2',
    pullRequestId: 'Deliay/z-agent-gear#264',
    prUrl: 'https://github.com/Deliay/z-agent-gear/pull/264',
    ...overrides,
  };
}

const input = {
  userId: 'user-1',
  workflowInstanceId: 'inst-1',
  nodeId: 'n2',
  nodeKey: 'design',
  pullRequestId: 'Deliay/z-agent-gear#264',
  sessionId: 'sess-1',
};

describe('normalizePullRequestId', () => {
  it.each([
    ['https://github.com/Deliay/z-agent-gear/pull/264', 'Deliay/z-agent-gear#264'],
    ['https://github.com/Deliay/z-agent-gear/pull/264/', 'Deliay/z-agent-gear#264'],
    ['Deliay/z-agent-gear#264', 'Deliay/z-agent-gear#264'],
    ['Deliay/z-agent-gear/pull/264', 'Deliay/z-agent-gear#264'],
    ['  deliay/z-agent-gear#264  ', 'deliay/z-agent-gear#264'],
  ])('归一化 %s', (raw, expected) => {
    const result = normalizePullRequestId(raw);
    expect(result.pullRequestId).toBe(expected);
    expect(result.prUrl).toMatch(/^https:\/\/github\.com\/.+\/pull\/264$/);
  });

  it.each(['', 'foo', 'foo/bar', 'https://gitlab.com/a/b/pull/1', 'a/b#0', 'a/b#x'])(
    '拒绝非法标识 %s',
    (raw) => {
      expect(() => normalizePullRequestId(raw)).toThrow(PullRequestIdError);
    },
  );
});

describe('prHandlerRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(WorkflowPrHandler.deleteMany).mockResolvedValue({ deletedCount: 0 } as never);
  });

  it('register 先删除同节点其他 PR，再 upsert 当前 PR', async () => {
    vi.mocked(WorkflowPrHandler.findOneAndUpdate).mockReturnValue(lean(row()) as never);

    const result = await prHandlerRegistry.register(input);

    expect(WorkflowPrHandler.deleteMany).toHaveBeenCalledWith({
      workflowInstanceId: 'inst-1',
      nodeId: 'n2',
      pullRequestId: { $ne: 'Deliay/z-agent-gear#264' },
    });
    expect(WorkflowPrHandler.findOneAndUpdate).toHaveBeenCalledWith(
      { workflowInstanceId: 'inst-1', nodeId: 'n2', pullRequestId: 'Deliay/z-agent-gear#264' },
      { $set: expect.objectContaining({ nodeKey: 'design', registeredBySessionId: 'sess-1' }) },
      { upsert: true, new: true },
    );
    expect(result.pullRequestId).toBe('Deliay/z-agent-gear#264');
  });

  it('register 唯一键冲突时读取已存在行', async () => {
    vi.mocked(WorkflowPrHandler.findOneAndUpdate).mockReturnValue({
      lean: vi.fn().mockRejectedValue({ code: 11000 }),
    } as never);
    vi.mocked(WorkflowPrHandler.findOne).mockReturnValue(lean(row()) as never);

    const result = await prHandlerRegistry.register(input);
    expect(result._id).toBe('h1');
  });

  it('findByPullRequestId 大小写不敏感并返回空数组', async () => {
    vi.mocked(WorkflowPrHandler.find).mockReturnValue(sortable([row()]) as never);
    await expect(prHandlerRegistry.findByPullRequestId('deliay/z-agent-gear#264')).resolves.toHaveLength(1);

    vi.mocked(WorkflowPrHandler.find).mockReturnValue(sortable([]) as never);
    await expect(prHandlerRegistry.findByPullRequestId('a/b#1')).resolves.toEqual([]);
  });

  it('unregisterByInstance 返回删除条数', async () => {
    vi.mocked(WorkflowPrHandler.deleteMany).mockResolvedValue({ deletedCount: 2 } as never);
    await expect(prHandlerRegistry.unregisterByInstance('inst-1', 'ARCHIVED')).resolves.toBe(2);
  });

  it('rebuild 装载全部行，异常时只告警', async () => {
    vi.mocked(WorkflowPrHandler.find).mockReturnValue(lean([row(), row({ _id: 'h2' })]) as never);
    await expect(prHandlerRegistry.rebuild()).resolves.toBe(2);

    vi.mocked(WorkflowPrHandler.find).mockReturnValue({
      lean: vi.fn().mockRejectedValue(new Error('mongo down')),
    } as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(prHandlerRegistry.rebuild()).resolves.toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('registerPrHandlerLifecycleHooks 在完成时注销', async () => {
    vi.mocked(WorkflowPrHandler.deleteMany).mockResolvedValue({ deletedCount: 1 } as never);
    prHandlerRegistry.registerPrHandlerLifecycleHooks();

    const hooks = vi.mocked(workflowEngine.registerHooks).mock.calls.at(-1)?.[0];
    await hooks?.onWorkflowFinished?.({ _id: { toString: () => 'inst-9' } } as never);

    expect(WorkflowPrHandler.deleteMany).toHaveBeenCalledWith({ workflowInstanceId: 'inst-9' });
  });
});
