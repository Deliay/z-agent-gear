import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/controller.js', () => ({ Controller: { findOne: vi.fn() } }));
vi.mock('../models/configured-workflow.js', () => ({
  ConfiguredWorkflow: { findOne: vi.fn() },
}));
vi.mock('./github.js', () => ({
  githubService: {
    resolveRepoAccount: vi.fn(),
    ensureIssueLabel: vi.fn(),
    deleteIssueLabel: vi.fn(),
  },
}));
vi.mock('../models/cloud-host-issues-linkage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../models/cloud-host-issues-linkage.js')>();
  return {
    ...actual,
    CloudHostIssuesLinkage: {
      find: vi.fn(),
      findOne: vi.fn(),
      create: vi.fn(),
      updateOne: vi.fn(),
      deleteOne: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
});

import { cloudHostIssuesLinkageService } from './cloud-host-issues-linkage.js';
import { Controller } from '../models/controller.js';
import { ConfiguredWorkflow } from '../models/configured-workflow.js';
import { CloudHostIssuesLinkage } from '../models/cloud-host-issues-linkage.js';
import { githubService } from './github.js';

const userId = 'user-1';
const controllerId = '507f1f77bcf86cd799439011';
const workflowId = '507f1f77bcf86cd799439012';
const linkageId = '507f1f77bcf86cd799439013';

const lean = (result: unknown) => ({ lean: vi.fn().mockResolvedValue(result) });

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    controllerId,
    configuredWorkflowId: workflowId,
    labelName: 'start-开发',
    repoFullNames: ['Deliay/z-agent-gear'],
    ...overrides,
  };
}

function mockCloudController() {
  vi.mocked(Controller.findOne).mockReturnValue(
    lean({ _id: controllerId, type: 'cloud' }) as never,
  );
}

function mockWorkflow(nodes = [{ type: 'HUMAN' }]) {
  vi.mocked(ConfiguredWorkflow.findOne).mockReturnValue(
    lean({ _id: workflowId, name: '开发流程', nodes }) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCloudController();
  mockWorkflow();
  vi.mocked(githubService.resolveRepoAccount).mockResolvedValue('account-1');
  vi.mocked(githubService.ensureIssueLabel).mockResolvedValue(undefined);
});

describe('cloudHostIssuesLinkageService.create 校验', () => {
  it('控制器不存在 → cloud host not found', async () => {
    vi.mocked(Controller.findOne).mockReturnValue(lean(null) as never);
    await expect(cloudHostIssuesLinkageService.create(userId, baseInput())).rejects.toThrow(
      'cloud host not found',
    );
  });

  it.each([['', 'invalid label name'], ['x'.repeat(51), 'invalid label name'], ['a,b', 'invalid label name']])(
    '标签非法 %s',
    async (labelName, message) => {
      await expect(
        cloudHostIssuesLinkageService.create(userId, baseInput({ labelName })),
      ).rejects.toThrow(message);
    },
  );

  it('仓库为空 → at least one repo is required', async () => {
    await expect(
      cloudHostIssuesLinkageService.create(userId, baseInput({ repoFullNames: ['  '] })),
    ).rejects.toThrow('at least one repo is required');
  });

  it('工作流无 HUMAN → workflow must contain a human node', async () => {
    mockWorkflow([{ type: 'AI' }]);
    await expect(cloudHostIssuesLinkageService.create(userId, baseInput())).rejects.toThrow(
      'workflow must contain a human node',
    );
  });
});

describe('cloudHostIssuesLinkageService.create 标签同步', () => {
  it('创建成功并逐仓库同步标签', async () => {
    vi.mocked(CloudHostIssuesLinkage.findOne).mockReturnValue(lean(null) as never);
    vi.mocked(CloudHostIssuesLinkage.create).mockResolvedValue({
      _id: linkageId,
      controllerId,
      configuredWorkflowId: workflowId,
      configuredWorkflowName: '开发流程',
      labelName: 'start-开发',
      repoFullNames: ['Deliay/z-agent-gear'],
      createdAt: new Date('2026-10-25T00:00:00Z'),
      updatedAt: new Date('2026-10-25T00:00:00Z'),
    } as never);

    const result = await cloudHostIssuesLinkageService.create(userId, baseInput());

    expect(githubService.ensureIssueLabel).toHaveBeenCalledWith(
      userId,
      'Deliay/z-agent-gear',
      'start-开发',
    );
    expect(result).toMatchObject({
      id: linkageId,
      configuredWorkflowName: '开发流程',
      labelName: 'start-开发',
      createdAt: '2026-10-25T00:00:00.000Z',
    });
  });

  it('部分仓库同步失败汇总报错（配置已保存）', async () => {
    vi.mocked(CloudHostIssuesLinkage.findOne).mockReturnValue(lean(null) as never);
    vi.mocked(CloudHostIssuesLinkage.create).mockResolvedValue({
      _id: linkageId,
      labelName: 'start-开发',
      repoFullNames: ['a/b', 'c/d'],
    } as never);
    vi.mocked(githubService.ensureIssueLabel).mockImplementation(async (_u, repo) => {
      if (repo === 'c/d') throw new Error('boom');
    });

    await expect(
      cloudHostIssuesLinkageService.create(userId, baseInput({ repoFullNames: ['a/b', 'c/d'] })),
    ).rejects.toThrow('label sync failed: c/d');
    expect(CloudHostIssuesLinkage.create).toHaveBeenCalled();
  });

  it('同标签同工作流同仓库重发视为幂等重试（不重复建行）', async () => {
    vi.mocked(CloudHostIssuesLinkage.findOne).mockReturnValue(
      lean({
        _id: linkageId,
        configuredWorkflowId: workflowId,
        labelName: 'start-开发',
        repoFullNames: ['Deliay/z-agent-gear'],
        createdAt: new Date('2026-10-25T00:00:00Z'),
        updatedAt: new Date('2026-10-25T00:00:00Z'),
      }) as never,
    );

    await cloudHostIssuesLinkageService.create(userId, baseInput());
    expect(CloudHostIssuesLinkage.create).not.toHaveBeenCalled();
    expect(githubService.ensureIssueLabel).toHaveBeenCalled();
  });

  it('同标签不同工作流 → label name already exists', async () => {
    vi.mocked(CloudHostIssuesLinkage.findOne).mockReturnValue(
      lean({ _id: linkageId, configuredWorkflowId: 'other', repoFullNames: ['a/b'] }) as never,
    );
    await expect(cloudHostIssuesLinkageService.create(userId, baseInput())).rejects.toThrow(
      'label name already exists: start-开发',
    );
  });
});

describe('cloudHostIssuesLinkageService.update / remove / cleanup', () => {
  it('update 以 id 定位并忽略入参 controllerId；重复校验排除自身', async () => {
    vi.mocked(CloudHostIssuesLinkage.findOne)
      .mockReturnValueOnce(lean({ _id: linkageId, controllerId }) as never)
      .mockReturnValueOnce(lean(null) as never)
      .mockReturnValueOnce(
        lean({
          _id: linkageId,
          controllerId,
          configuredWorkflowId: workflowId,
          configuredWorkflowName: '开发流程',
          labelName: 'start-新',
          repoFullNames: ['Deliay/z-agent-gear'],
          createdAt: new Date('2026-10-25T00:00:00Z'),
          updatedAt: new Date('2026-10-25T00:00:00Z'),
        }) as never,
      );
    vi.mocked(CloudHostIssuesLinkage.updateOne).mockResolvedValue({} as never);

    const result = await cloudHostIssuesLinkageService.update(
      userId,
      linkageId,
      baseInput({ controllerId: 'ignored', labelName: 'start-新' }),
    );

    expect(CloudHostIssuesLinkage.updateOne).toHaveBeenCalledWith(
      { _id: linkageId, userId },
      expect.objectContaining({ $set: expect.objectContaining({ labelName: 'start-新' }) }),
    );
    // 改名只同步新标签，不删除旧标签
    expect(githubService.ensureIssueLabel).toHaveBeenCalledWith(
      userId,
      'Deliay/z-agent-gear',
      'start-新',
    );
    expect(githubService.deleteIssueLabel).not.toHaveBeenCalled();
    expect(result.labelName).toBe('start-新');
  });

  it('remove 按 userId 过滤', async () => {
    vi.mocked(CloudHostIssuesLinkage.deleteOne).mockResolvedValue({ deletedCount: 1 } as never);
    await expect(cloudHostIssuesLinkageService.remove(userId, linkageId)).resolves.toBe(true);
    expect(CloudHostIssuesLinkage.deleteOne).toHaveBeenCalledWith({ _id: linkageId, userId });
  });

  it('cleanup 逐项收集 deleted/failed 并删除配置行（404 视为成功）', async () => {
    vi.mocked(CloudHostIssuesLinkage.find).mockReturnValue(
      lean([
        { labelName: 'start-开发', repoFullNames: ['a/b', 'c/d'] },
        { labelName: 'bug', repoFullNames: ['a/b'] },
      ]) as never,
    );
    vi.mocked(githubService.deleteIssueLabel).mockImplementation(async (_u, repo, label) => {
      if (repo === 'c/d' && label === 'start-开发') throw new Error('boom');
    });
    vi.mocked(CloudHostIssuesLinkage.deleteMany).mockResolvedValue({ deletedCount: 2 } as never);

    const result = await cloudHostIssuesLinkageService.cleanup(userId, controllerId);

    expect(result.deleted).toEqual(['a/b#start-开发', 'a/b#bug']);
    expect(result.failed).toEqual(['c/d#start-开发']);
    expect(CloudHostIssuesLinkage.deleteMany).toHaveBeenCalledWith({ userId, controllerId });
  });

  it('deleteByController 级联删除该控制器全部配置行', async () => {
    vi.mocked(CloudHostIssuesLinkage.deleteMany).mockResolvedValue({ deletedCount: 3 } as never);
    await expect(cloudHostIssuesLinkageService.deleteByController(controllerId)).resolves.toBe(3);
    expect(CloudHostIssuesLinkage.deleteMany).toHaveBeenCalledWith({ controllerId });
  });
});
