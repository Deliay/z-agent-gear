import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../github.js', () => ({
  githubService: { createRepoScopedTokenForUser: vi.fn() },
}));

vi.mock('./pr-handler-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pr-handler-registry.js')>();
  return {
    ...actual,
    prHandlerRegistry: {
      findByNode: vi.fn(),
      markCheckRunSynced: vi.fn(),
      markTodoSynced: vi.fn(),
      markSyncError: vi.fn(),
    },
  };
});

vi.mock('./github-checks-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github-checks-client.js')>();
  return {
    ...actual,
    createCheckRun: vi.fn(),
    updateCheckRun: vi.fn(),
    getPullRequestHead: vi.fn(),
  };
});

vi.mock('./engine.js', () => ({
  workflowEngine: { registerHooks: vi.fn() },
}));

import {
  mapNodeStatusToCheckRun,
  renderTodoMarkdown,
  computeTodoDigest,
  syncNodeStatus,
  syncTodoPanel,
  parseTodoEntries,
  captureSnapshot,
  resetTodoThrottle,
  TODO_MIN_INTERVAL_MS,
  type PrSyncSnapshot,
  type TodoEntry,
} from './pr-check-run-sync.js';
import { githubService } from '../github.js';
import { prHandlerRegistry } from './pr-handler-registry.js';
import {
  createCheckRun,
  updateCheckRun,
  getPullRequestHead,
  GitHubChecksError,
} from './github-checks-client.js';
import type { WorkflowInstanceDoc, WorkflowNodeDoc } from './engine.js';

function oid(id: string) {
  return { toString: () => id };
}

function makeNode(overrides: Partial<WorkflowNodeDoc> = {}): WorkflowNodeDoc {
  return {
    nodeId: 'n1',
    nodeKey: 'impl',
    type: 'AI',
    name: '代码实现',
    stage: '实现阶段',
    status: 'RUNNING',
    dependsOn: [],
    reworkCount: 0,
    ...overrides,
  };
}

function makeInstance(overrides: Partial<WorkflowInstanceDoc> = {}): WorkflowInstanceDoc {
  return {
    _id: oid('inst-1'),
    userId: oid('user-1'),
    controllerId: oid('ctrl-1'),
    workspaceId: oid('ws-1'),
    configuredWorkflowId: oid('cfg-1'),
    name: '需求工作流',
    nodes: [],
    currentNodeNames: [],
    blackboard: new Map(),
    blackboardTrash: new Map(),
    blackboardUpdatedAt: new Map(),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function handlerRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'h1',
    userId: 'user-1',
    pullRequestId: 'Deliay/z-agent-gear#285',
    lastCheckRunId: null,
    lastWrittenCommitSha: null,
    lastSyncedNodeStatus: null,
    lastTodoDigest: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<PrSyncSnapshot> = {}): PrSyncSnapshot {
  return {
    handlerId: 'h1',
    userId: 'user-1',
    pullRequestId: 'Deliay/z-agent-gear#285',
    workflowInstanceId: 'inst-1',
    nodeId: 'n1',
    nodeName: '代码实现',
    nodeStatus: 'RUNNING',
    stage: '实现阶段',
    instanceName: '需求工作流',
    lastCheckRunId: 1001,
    lastWrittenCommitSha: 'sha-old',
    lastSyncedNodeStatus: null,
    lastTodoDigest: null,
    ...overrides,
  };
}

function entry(content: string, status: TodoEntry['status']): TodoEntry {
  return { content, status };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetTodoThrottle();
  vi.mocked(githubService.createRepoScopedTokenForUser).mockResolvedValue({
    token: 'ghs_test',
    expiresAt: new Date('2099-01-01'),
  });
  vi.mocked(getPullRequestHead).mockResolvedValue({ sha: 'sha-old', state: 'open', merged: false });
  vi.mocked(createCheckRun).mockResolvedValue({ id: 2002, htmlUrl: 'https://github.test/runs/2002' });
  vi.mocked(updateCheckRun).mockResolvedValue({ id: 1001, htmlUrl: 'https://github.test/runs/1001' });
  vi.mocked(prHandlerRegistry.markSyncError).mockResolvedValue(undefined);
  vi.mocked(prHandlerRegistry.markCheckRunSynced).mockResolvedValue(undefined);
  vi.mocked(prHandlerRegistry.markTodoSynced).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('mapNodeStatusToCheckRun', () => {
  it.each([
    ['INITIALIZING', 'queued', undefined, '排队中'],
    ['READY', 'queued', undefined, '排队中'],
    ['RUNNING', 'in_progress', undefined, '执行中'],
    ['REWORK', 'in_progress', undefined, '返工中'],
    ['DONE', 'completed', 'success', '已完成'],
    ['REJECT', 'completed', 'action_required', '被打回，待处理'],
    ['FAILED', 'completed', 'failure', '执行失败'],
  ])('%s → %s/%s（%s）', (nodeStatus, status, conclusion, label) => {
    expect(mapNodeStatusToCheckRun(nodeStatus)).toEqual({ status, conclusion, label });
  });
});

describe('syncNodeStatus', () => {
  it('未绑定 PR 时零调用', async () => {
    vi.mocked(prHandlerRegistry.findByNode).mockResolvedValue(null);

    await syncNodeStatus(makeInstance(), makeNode());

    expect(githubService.createRepoScopedTokenForUser).not.toHaveBeenCalled();
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it('同 commit 原地 PATCH（无 create）', async () => {
    vi.mocked(prHandlerRegistry.findByNode).mockResolvedValue(
      handlerRow({
        lastCheckRunId: 1001,
        lastWrittenCommitSha: 'sha-old',
        lastSyncedNodeStatus: 'READY',
      }) as never,
    );

    await syncNodeStatus(makeInstance(), makeNode({ status: 'RUNNING' }));

    expect(createCheckRun).not.toHaveBeenCalled();
    expect(updateCheckRun).toHaveBeenCalledWith(
      'ghs_test',
      'Deliay/z-agent-gear',
      1001,
      expect.objectContaining({ status: 'in_progress' }),
    );
    expect(prHandlerRegistry.markCheckRunSynced).toHaveBeenCalledWith(
      'h1',
      expect.objectContaining({ commitSha: 'sha-old', checkRunId: 1001, nodeStatus: 'RUNNING' }),
    );
  });

  it('commit 前进：旧 check-run 置 stale + 新 commit create', async () => {
    vi.mocked(prHandlerRegistry.findByNode).mockResolvedValue(
      handlerRow({ lastCheckRunId: 1001, lastWrittenCommitSha: 'sha-old' }) as never,
    );
    vi.mocked(getPullRequestHead).mockResolvedValue({ sha: 'sha-new', state: 'open', merged: false });

    await syncNodeStatus(makeInstance(), makeNode({ status: 'DONE' }));

    expect(updateCheckRun).toHaveBeenCalledWith(
      'ghs_test',
      'Deliay/z-agent-gear',
      1001,
      expect.objectContaining({ status: 'completed', conclusion: 'stale' }),
    );
    expect(createCheckRun).toHaveBeenCalledWith(
      'ghs_test',
      'Deliay/z-agent-gear',
      expect.objectContaining({
        head_sha: 'sha-new',
        status: 'completed',
        conclusion: 'success',
        name: 'ZAG 工作流 · 代码实现',
        external_id: 'inst-1:n1',
      }),
    );
    expect(prHandlerRegistry.markCheckRunSynced).toHaveBeenCalledWith(
      'h1',
      expect.objectContaining({ commitSha: 'sha-new', checkRunId: 2002 }),
    );
  });

  it('无旧 check-run 时直接 create', async () => {
    vi.mocked(prHandlerRegistry.findByNode).mockResolvedValue(handlerRow() as never);

    await syncNodeStatus(makeInstance(), makeNode({ status: 'READY' }));

    expect(updateCheckRun).not.toHaveBeenCalled();
    expect(createCheckRun).toHaveBeenCalledWith(
      'ghs_test',
      'Deliay/z-agent-gear',
      expect.objectContaining({ head_sha: 'sha-old', status: 'queued' }),
    );
  });

  it('幂等：状态与 commit 均未变时零 GitHub 调用', async () => {
    vi.mocked(prHandlerRegistry.findByNode).mockResolvedValue(
      handlerRow({
        lastCheckRunId: 1001,
        lastWrittenCommitSha: 'sha-old',
        lastSyncedNodeStatus: 'RUNNING',
      }) as never,
    );

    await syncNodeStatus(makeInstance(), makeNode({ status: 'RUNNING' }));

    expect(updateCheckRun).not.toHaveBeenCalled();
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it('PR 关闭：停止同步且 lastSyncError 清空', async () => {
    vi.mocked(prHandlerRegistry.findByNode).mockResolvedValue(
      handlerRow({ lastCheckRunId: 1001, lastWrittenCommitSha: 'sha-old' }) as never,
    );
    vi.mocked(getPullRequestHead).mockResolvedValue({ sha: 'sha-old', state: 'closed', merged: false });

    await syncNodeStatus(makeInstance(), makeNode());

    expect(updateCheckRun).not.toHaveBeenCalled();
    expect(createCheckRun).not.toHaveBeenCalled();
    expect(prHandlerRegistry.markSyncError).toHaveBeenCalledWith('h1', null);
  });

  it('403 失败记白名单文案且不抛出', async () => {
    vi.mocked(prHandlerRegistry.findByNode).mockResolvedValue(handlerRow() as never);
    vi.mocked(createCheckRun).mockRejectedValue(new GitHubChecksError('FORBIDDEN', 'forbidden'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(syncNodeStatus(makeInstance(), makeNode())).resolves.toBeUndefined();

    expect(prHandlerRegistry.markSyncError).toHaveBeenCalledWith('h1', '检查项写入权限不足');
    warn.mockRestore();
  });

  it('仓库未授权同样收敛为权限文案', async () => {
    vi.mocked(prHandlerRegistry.findByNode).mockResolvedValue(handlerRow() as never);
    vi.mocked(githubService.createRepoScopedTokenForUser).mockRejectedValue(
      new Error('repository is not authorized'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await syncNodeStatus(makeInstance(), makeNode());

    expect(prHandlerRegistry.markSyncError).toHaveBeenCalledWith('h1', '检查项写入权限不足');
    warn.mockRestore();
  });
});

describe('renderTodoMarkdown / digest', () => {
  const now = new Date('2026-10-25T08:09:10');

  it('三态标记 + 汇总行 + 顺序一致', () => {
    const text = renderTodoMarkdown(
      [entry('已完成任务', 'completed'), entry('进行中任务', 'in_progress'), entry('等待中任务', 'pending')],
      now,
    );
    expect(text).toBe(
      [
        '**任务清单**（1/3 完成 · 更新于 08:09:10）',
        '- [x] 已完成任务',
        '- 🔄 进行中任务',
        '- [ ] 等待中任务',
      ].join('\n'),
    );
  });

  it('空清单渲染（暂无任务）', () => {
    expect(renderTodoMarkdown([], now)).toBe('**任务清单**（0/0 完成 · 更新于 08:09:10）\n（暂无任务）');
  });

  it('条数上限 100、单条截断 500', () => {
    const entries = Array.from({ length: 120 }, (_, i) => entry(`任务${i}-${'x'.repeat(600)}`, 'pending'));
    const text = renderTodoMarkdown(entries, now);
    expect(text).toContain('0/100 完成');
    expect(text).not.toContain('任务100');
    expect(text.split('\n')[1].length).toBeLessThan(520);
  });

  it('digest 不含时间戳（内容未变即相同）', () => {
    const entries = [entry('a', 'completed')];
    expect(computeTodoDigest(entries)).toBe(computeTodoDigest(entries));
    expect(computeTodoDigest(entries)).not.toBe(computeTodoDigest([entry('b', 'completed')]));
  });
});

describe('parseTodoEntries', () => {
  it('接受 SessionUpdate.plan 载荷（字符串或对象）', () => {
    const payload = {
      sessionUpdate: 'plan',
      entries: [{ content: 'a', status: 'in_progress', priority: 'high' }],
    };
    expect(parseTodoEntries(JSON.stringify(payload))).toEqual([
      { content: 'a', status: 'in_progress', priority: 'high' },
    ]);
    expect(parseTodoEntries(payload)).toEqual([
      { content: 'a', status: 'in_progress', priority: 'high' },
    ]);
  });

  it('非法结构丢弃', () => {
    expect(parseTodoEntries('not json')).toBeNull();
    expect(parseTodoEntries({ sessionUpdate: 'agent_message', entries: [] })).toBeNull();
    expect(parseTodoEntries({ sessionUpdate: 'plan', entries: 'x' })).toBeNull();
    expect(
      parseTodoEntries({ sessionUpdate: 'plan', entries: [{ content: 'a', status: 'unknown' }] }),
    ).toEqual([]);
  });
});

describe('syncTodoPanel', () => {
  const entries = [entry('第一步', 'completed'), entry('第二步', 'in_progress')];

  it('满足条件时 PATCH output.text 并回写 digest', async () => {
    await syncTodoPanel(snapshot(), entries);

    expect(updateCheckRun).toHaveBeenCalledWith(
      'ghs_test',
      'Deliay/z-agent-gear',
      1001,
      expect.objectContaining({
        output: expect.objectContaining({
          title: '代码实现 · 执行中',
          text: expect.stringContaining('- 🔄 第二步'),
        }),
      }),
    );
    expect(prHandlerRegistry.markTodoSynced).toHaveBeenCalledWith(
      'h1',
      expect.objectContaining({ digest: computeTodoDigest(entries) }),
    );
  });

  it('未写入过 check-run 时零调用', async () => {
    await syncTodoPanel(snapshot({ lastCheckRunId: null }), entries);
    expect(updateCheckRun).not.toHaveBeenCalled();
  });

  it('内容未变（digest 相同）零写入', async () => {
    await syncTodoPanel(snapshot({ lastTodoDigest: computeTodoDigest(entries) }), entries);
    expect(updateCheckRun).not.toHaveBeenCalled();
  });

  it('3s 窗口内多次更新尾沿合并为最后一次', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T00:00:00Z'));

    await syncTodoPanel(snapshot(), [entry('A', 'pending')]);
    expect(updateCheckRun).toHaveBeenCalledTimes(1);

    await syncTodoPanel(snapshot(), [entry('B', 'pending')]);
    await syncTodoPanel(snapshot(), [entry('C', 'pending')]);
    expect(updateCheckRun).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TODO_MIN_INTERVAL_MS);

    expect(updateCheckRun).toHaveBeenCalledTimes(2);
    const lastPayload = vi.mocked(updateCheckRun).mock.calls.at(-1)?.[3] as {
      output?: { text?: string };
    };
    expect(lastPayload.output?.text).toContain('C');
    expect(lastPayload.output?.text).not.toContain('B');
  });

  it('PATCH 失败记白名单文案且不抛出', async () => {
    vi.mocked(updateCheckRun).mockRejectedValue(new GitHubChecksError('RATE_LIMITED', 'rate'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(syncTodoPanel(snapshot(), entries)).resolves.toBeUndefined();

    expect(prHandlerRegistry.markSyncError).toHaveBeenCalledWith('h1', 'GitHub 限流，稍后自动重试');
    warn.mockRestore();
  });
});

describe('captureSnapshot', () => {
  it('解析登记行可空字段', () => {
    const snap = captureSnapshot(makeInstance(), makeNode(), handlerRow() as never);
    expect(snap).toMatchObject({
      handlerId: 'h1',
      pullRequestId: 'Deliay/z-agent-gear#285',
      nodeName: '代码实现',
      nodeStatus: 'RUNNING',
      lastCheckRunId: null,
      lastWrittenCommitSha: null,
    });
  });
});
