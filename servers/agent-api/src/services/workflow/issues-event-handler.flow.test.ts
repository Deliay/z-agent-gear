import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  findLean: vi.fn(),
  createTrigger: vi.fn(),
  findByIdLean: vi.fn(),
}));

vi.mock('../../models/cloud-host-issues-linkage.js', () => ({
  CloudHostIssuesLinkage: { find: vi.fn() },
}));
vi.mock('../../models/issue-workflow-trigger.js', () => ({
  ISSUE_TRIGGER_STATUSES: [],
  IssueWorkflowTrigger: {
    find: vi.fn(),
    findById: vi.fn(),
    create: h.createTrigger,
    updateOne: vi.fn(),
  },
}));

import { handleIssuesEvent } from './issues-event-handler.js';
import { CloudHostIssuesLinkage } from '../../models/cloud-host-issues-linkage.js';
import { IssueWorkflowTrigger } from '../../models/issue-workflow-trigger.js';

const { findLean, createTrigger, findByIdLean } = h;

const event = {
  action: 'labeled',
  repoFullName: 'Deliay/z-agent-gear',
  issueId: '123',
  issueNumber: 42,
  title: '接入联动',
  body: '正文',
  issueUrl: 'https://github.com/Deliay/z-agent-gear/issues/42',
  author: 'octocat',
  labels: ['start-dev'],
};

function linkage(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'link-1',
    userId: 'user-1',
    tenantId: 'team-1',
    controllerId: 'ctrl-1',
    configuredWorkflowId: 'wf-1',
    labelName: 'start-dev',
    labelNameLower: 'start-dev',
    repoFullNames: ['Deliay/z-agent-gear'],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(CloudHostIssuesLinkage.find).mockReturnValue({
    lean: findLean,
  } as never);
  vi.mocked(IssueWorkflowTrigger.findById).mockReturnValue({ lean: findByIdLean } as never);
  findByIdLean.mockResolvedValue(null);
  createTrigger.mockResolvedValue({ _id: 'trigger-1' });
});

describe('handleIssuesEvent 判定链', () => {
  it('仓库无任何配置 → REPO_NOT_ENABLED', async () => {
    findLean.mockResolvedValue([]);
    await expect(handleIssuesEvent(event)).resolves.toEqual({
      handled: false,
      reason: 'REPO_NOT_ENABLED',
      results: [],
    });
  });

  it('有配置但标签不命中 → NO_MATCHING_LINKAGE', async () => {
    findLean.mockResolvedValue([linkage({ labelNameLower: 'other' })]);
    const result = await handleIssuesEvent(event);
    expect(result.handled).toBe(false);
    expect(result.reason).toBe('NO_MATCHING_LINKAGE');
  });

  it('命中 → 创建触发记录并返回 CREATE_TRIGGER', async () => {
    findLean.mockResolvedValue([linkage()]);
    const result = await handleIssuesEvent(event);
    expect(result.handled).toBe(true);
    expect(result.results).toEqual([
      {
        controllerId: 'ctrl-1',
        linkageId: 'link-1',
        labelName: 'start-dev',
        action: 'CREATE_TRIGGER',
      },
    ]);
    expect(createTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        // 事件入口无上下文：租户必须显式继承联动配置，否则会被写成 tenantId=userId
        tenantId: 'team-1',
        issueId: '123',
        issueNumber: 42,
        issueTitle: '接入联动',
        issueBody: '正文',
        status: 'PENDING_WORKSPACE',
      }),
    );
  });

  it('唯一索引冲突 → ALREADY_TRIGGERED', async () => {
    findLean.mockResolvedValue([linkage()]);
    createTrigger.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    const result = await handleIssuesEvent(event);
    expect(result.handled).toBe(false);
    expect(result.results[0].reason).toBe('ALREADY_TRIGGERED');
  });

  it('多配置各自独立触发一次（大小写不敏感标签匹配）', async () => {
    findLean.mockResolvedValue([
      linkage(),
      linkage({ _id: 'link-2', labelName: 'Start-Dev', labelNameLower: 'start-dev' }),
      linkage({ _id: 'link-3', labelName: 'bug', labelNameLower: 'bug' }),
    ]);
    const result = await handleIssuesEvent(event);
    expect(result.results.filter((item) => item.action === 'CREATE_TRIGGER')).toHaveLength(2);
    expect(createTrigger).toHaveBeenCalledTimes(2);
  });
});
