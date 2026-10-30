import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  linkageFind: vi.fn(),
  triggerCreate: vi.fn(),
  triggerFindById: vi.fn(),
  githubAccountFindOne: vi.fn(),
}));

vi.mock('../../models/cloud-host-issues-linkage.js', () => ({
  CloudHostIssuesLinkage: { find: h.linkageFind },
}));
vi.mock('../../models/issue-workflow-trigger.js', () => ({
  ISSUE_TRIGGER_STATUSES: [],
  IssueWorkflowTrigger: {
    create: h.triggerCreate,
    findById: h.triggerFindById,
    find: vi.fn(),
    updateOne: vi.fn(),
  },
}));
vi.mock('../../models/github-account.js', () => ({
  GitHubAccount: { findOne: h.githubAccountFindOne },
}));

import { mapConfiguredNodes, resolveFirstHumanNode, handleIssuesEvent } from './issues-event-handler.js';
import type { IssuesEventPayload } from './github-issues-webhook-payload.js';

describe('resolveFirstHumanNode', () => {
  it('按拓扑序取第一个 HUMAN（跳过前置 AI）', () => {
    expect(
      resolveFirstHumanNode([
        { nodeId: 'ai', type: 'AI', dependsOn: [] },
        { nodeId: 'human', type: 'HUMAN', dependsOn: ['ai'] },
        { nodeId: 'human2', type: 'HUMAN', dependsOn: ['human'] },
      ]),
    ).toBe('human');
  });

  it('同层按 sortOrder 升序（再按快照顺序稳定）', () => {
    expect(
      resolveFirstHumanNode([
        { nodeId: 'ai', type: 'AI', dependsOn: [], sortOrder: 0 },
        { nodeId: 'human-late', type: 'HUMAN', dependsOn: [], sortOrder: 5 },
        { nodeId: 'human-early', type: 'HUMAN', dependsOn: [], sortOrder: 1 },
      ]),
    ).toBe('human-early');
  });

  it('无 HUMAN 返回 null；环状图不阻塞', () => {
    expect(resolveFirstHumanNode([{ nodeId: 'ai', type: 'AI', dependsOn: [] }])).toBeNull();
    expect(
      resolveFirstHumanNode([
        { nodeId: 'a', type: 'AI', dependsOn: ['b'] },
        { nodeId: 'b', type: 'AI', dependsOn: ['a'] },
      ]),
    ).toBeNull();
  });
});

describe('mapConfiguredNodes', () => {
  it('保留 nodeKey 依赖并补齐默认值', () => {
    const mapped = mapConfiguredNodes([
      {
        nodeKey: 'human',
        type: 'HUMAN',
        name: '确认',
        stage: '实现阶段',
        dependsOn: ['ai'],
        linkUpstreamPullRequest: true,
      },
    ]);
    expect(mapped[0]).toMatchObject({
      nodeKey: 'human',
      type: 'HUMAN',
      name: '确认',
      stage: '实现阶段',
      dependsOn: ['ai'],
      requiresWorktree: false,
      linkUpstreamPullRequest: true,
      agentConfig: null,
    });
  });
});

describe('handleIssuesEvent 触发人捕获（T-GH-S2）', () => {
  const CONTROLLER_ID = '507f1f77bcf86cd799439031';
  const LINKAGE_ID = '507f1f77bcf86cd799439032';
  const OWNER_ID = '507f1f77bcf86cd799439033';
  const TRIGGER_USER_ID = '507f1f77bcf86cd799439034';
  const WORKFLOW_ID = '507f1f77bcf86cd799439035';

  const lean = (value: unknown) => ({ lean: vi.fn().mockResolvedValue(value) });

  function linkage() {
    return {
      _id: LINKAGE_ID,
      userId: OWNER_ID,
      controllerId: CONTROLLER_ID,
      configuredWorkflowId: WORKFLOW_ID,
      labelName: 'start-dev',
      labelNameLower: 'start-dev',
    };
  }

  function event(overrides: Partial<IssuesEventPayload> = {}): IssuesEventPayload {
    return {
      action: 'labeled',
      repoFullName: 'Deliay/z-agent-gear',
      issueId: '123',
      issueNumber: 42,
      title: '接入联动',
      issueUrl: 'https://github.com/Deliay/z-agent-gear/issues/42',
      labels: ['start-dev'],
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    h.linkageFind.mockReturnValue(lean([linkage()]));
    h.triggerCreate.mockImplementation(async (doc: unknown) => doc);
    // advance() 预检读不到记录 → 直接返回，避免推进状态机
    h.triggerFindById.mockReturnValue(lean(null));
    h.githubAccountFindOne.mockReturnValue(lean(null));
  });

  it('S2a: sender 命中 GitHubAccount → 落 triggerSenderId/Login 与 triggerUserId', async () => {
    h.githubAccountFindOne.mockReturnValue(lean({ userId: TRIGGER_USER_ID, githubLogin: 'octocat' }));

    await handleIssuesEvent(event({ sender: { id: 583231, login: 'octocat' } }));

    expect(h.githubAccountFindOne).toHaveBeenCalledWith({ githubUserId: 583231 });
    const created = h.triggerCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(created).toMatchObject({
      triggerSenderId: 583231,
      triggerSenderLogin: 'octocat',
      userId: OWNER_ID,
    });
    expect(String(created.triggerUserId)).toBe(TRIGGER_USER_ID);
  });

  it('S2b: sender 未绑定平台成员 → triggerUserId 为 null（sender 快照仍留档）', async () => {
    h.githubAccountFindOne.mockReturnValue(lean(null));

    await handleIssuesEvent(event({ sender: { id: 583231, login: 'octocat' } }));

    expect(h.triggerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerSenderId: 583231,
        triggerSenderLogin: 'octocat',
        triggerUserId: null,
      }),
    );
  });

  it('S2c: 老 payload 无 sender → 三个触发人字段均为 null，且不查帐号', async () => {
    await handleIssuesEvent(event());

    expect(h.githubAccountFindOne).not.toHaveBeenCalled();
    expect(h.triggerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerSenderId: null,
        triggerSenderLogin: null,
        triggerUserId: null,
      }),
    );
  });
});
