import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../models/controller.js', () => ({
  Controller: {
    findOne: vi.fn(),
  },
}));

vi.mock('../controller-workspace.js', () => ({
  controllerWorkspaceService: {
    findById: vi.fn(),
  },
}));

vi.mock('../../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('../../middleware/publish.js', () => ({
  publish: vi.fn(),
}));

import {
  parseRepoTemplate,
  isRepoTemplateScanSupported,
  repoTemplateService,
  REPO_TEMPLATE_POLL_INTERVAL_MS,
  REPO_TEMPLATE_POLL_ATTEMPTS,
} from './repo-templates.js';
import { Controller } from '../../models/controller.js';
import { controllerWorkspaceService } from '../controller-workspace.js';
import { getRedisClient } from '../../middleware/redis.js';
import { publish } from '../../middleware/publish.js';

const VALID_TEMPLATE = {
  name: '开发流程',
  description: '仓库内开发流程',
  nodes: [
    {
      nodeKey: 'requirement',
      type: 'HUMAN',
      name: '产品需求',
      stage: '需求',
      dependsOn: [],
      requiresWorktree: false,
    },
    {
      nodeKey: 'design',
      type: 'AI',
      name: '技术方案',
      stage: '设计',
      prompts: ['产出技术方案'],
      artifactTitles: ['技术方案文档'],
      dependsOn: ['requirement'],
      requiresWorktree: true,
    },
  ],
};

function lean(value: unknown) {
  return { lean: vi.fn().mockResolvedValue(value) } as never;
}

describe('parseRepoTemplate', () => {
  it('T-RT1 合法模板 → name/description/nodes 解析成功', () => {
    const parsed = parseRepoTemplate(JSON.stringify(VALID_TEMPLATE));

    expect(parsed.errors).toEqual([]);
    expect(parsed.name).toBe('开发流程');
    expect(parsed.description).toBe('仓库内开发流程');
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.nodes[1]).toMatchObject({
      nodeKey: 'design',
      type: 'AI',
      dependsOn: ['requirement'],
      prompts: ['产出技术方案'],
    });
  });

  it('T-RT2 非法 JSON → errors=[不是合法的 JSON 文件]', () => {
    const parsed = parseRepoTemplate('{ not json');
    expect(parsed.errors).toEqual(['不是合法的 JSON 文件']);
    expect(parsed.nodes).toEqual([]);
  });

  it('T-RT3 顶层/节点形状错误 → 汇总一条中文文案', () => {
    expect(parseRepoTemplate(JSON.stringify({ nodes: [] })).errors[0]).toContain('name');
    expect(parseRepoTemplate(JSON.stringify({ name: 'x', nodes: [] })).errors[0]).toContain('nodes');
    const badType = parseRepoTemplate(
      JSON.stringify({
        name: 'x',
        nodes: [{ nodeKey: 'a', type: 'ROBOT', name: 'a', stage: 's' }],
      }),
    );
    expect(badType.errors).toHaveLength(1);
    expect(badType.errors[0]).toContain('type');
  });

  it('T-RT4 图校验失败 → Error.message 原样进 errors', () => {
    const aiFirst = {
      name: 'x',
      nodes: [
        {
          nodeKey: 'ai',
          type: 'AI',
          name: 'AI 首节点',
          stage: 's',
          prompts: ['p'],
          dependsOn: [],
          requiresWorktree: false,
        },
      ],
    };
    const parsed = parseRepoTemplate(JSON.stringify(aiFirst));
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toBe(
      '首节点必须是人类节点（HUMAN），当前节点「AI 首节点」（ai）类型为 AI',
    );
  });

  it('T-RT5 逐文件隔离：一个非法文件不影响其他文件', () => {
    const broken = parseRepoTemplate('not-json');
    const good = parseRepoTemplate(JSON.stringify(VALID_TEMPLATE));
    expect(broken.errors).toEqual(['不是合法的 JSON 文件']);
    expect(good.errors).toEqual([]);
  });
});

describe('isRepoTemplateScanSupported', () => {
  it('版本 ≥2.18.0 为 true，低于/缺失/非法为 false', () => {
    expect(isRepoTemplateScanSupported('2.18.0')).toBe(true);
    expect(isRepoTemplateScanSupported('2.19.1')).toBe(true);
    expect(isRepoTemplateScanSupported('2.17.9')).toBe(false);
    expect(isRepoTemplateScanSupported('')).toBe(false);
    expect(isRepoTemplateScanSupported(null)).toBe(false);
    expect(isRepoTemplateScanSupported(undefined)).toBe(false);
  });
});

describe('repoTemplateService.scan', () => {
  const redis = {
    get: vi.fn(),
    del: vi.fn().mockResolvedValue(1),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(getRedisClient).mockReturnValue(redis as never);
    vi.mocked(controllerWorkspaceService.findById).mockResolvedValue({
      id: 'ws-1',
      controllerId: 'ctrl-1',
      path: '/home/worker/workspace/project',
    } as never);
    vi.mocked(Controller.findOne).mockReturnValue(
      lean({ _id: 'ctrl-1', status: 'online', version: '2.18.0' }),
    );
    vi.mocked(publish).mockResolvedValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('T-SCAN1 工作区不可见 → 抛 Workspace not found', async () => {
    vi.mocked(controllerWorkspaceService.findById).mockResolvedValue(null);

    await expect(repoTemplateService.scan('user-1', 'ws-x')).rejects.toThrow('Workspace not found');
    expect(publish).not.toHaveBeenCalled();
  });

  it('T-SCAN2 控制器离线 / 版本不足 / version 缺失 → 返回 [] 且不发事件', async () => {
    vi.mocked(Controller.findOne).mockReturnValueOnce(lean({ _id: 'ctrl-1', status: 'offline', version: '2.18.0' }));
    expect(await repoTemplateService.scan('user-1', 'ws-1')).toEqual([]);

    vi.mocked(Controller.findOne).mockReturnValueOnce(lean({ _id: 'ctrl-1', status: 'online', version: '2.17.0' }));
    expect(await repoTemplateService.scan('user-1', 'ws-1')).toEqual([]);

    vi.mocked(Controller.findOne).mockReturnValueOnce(lean({ _id: 'ctrl-1', status: 'online' }));
    expect(await repoTemplateService.scan('user-1', 'ws-1')).toEqual([]);

    expect(publish).not.toHaveBeenCalled();
  });

  it('T-SCAN3 扫描超时 / success:false → 返回 []', async () => {
    redis.get.mockResolvedValue(null);
    const timeoutPromise = repoTemplateService.scan('user-1', 'ws-1');
    await vi.advanceTimersByTimeAsync(REPO_TEMPLATE_POLL_INTERVAL_MS * (REPO_TEMPLATE_POLL_ATTEMPTS + 1));
    expect(await timeoutPromise).toEqual([]);

    redis.get.mockResolvedValue(JSON.stringify({ success: false, templates: [], truncated: false }));
    const failedPromise = repoTemplateService.scan('user-1', 'ws-1');
    await vi.advanceTimersByTimeAsync(REPO_TEMPLATE_POLL_INTERVAL_MS);
    expect(await failedPromise).toEqual([]);
  });

  it('T-SCAN4 publish 载荷与结果键正确；逐文件解析并稳定排序', async () => {
    redis.get.mockResolvedValue(
      JSON.stringify({
        success: true,
        truncated: false,
        templates: [
          { fileName: 'b.json', content: JSON.stringify(VALID_TEMPLATE) },
          { fileName: 'a.json', content: 'not-json' },
          { fileName: 'c.json', error: 'file too large' },
        ],
      }),
    );

    const promise = repoTemplateService.scan('user-1', 'ws-1');
    await vi.advanceTimersByTimeAsync(REPO_TEMPLATE_POLL_INTERVAL_MS);
    const result = await promise;

    expect(publish).toHaveBeenCalledWith(
      'session:command',
      expect.objectContaining({
        type: 'workflow-templates:scan',
        controllerId: 'ctrl-1',
        path: '/home/worker/workspace/project',
        requestId: expect.any(String),
      }),
    );
    const requestId = vi.mocked(publish).mock.calls[0][1].requestId as string;
    expect(redis.get).toHaveBeenCalledWith(`workflow-templates:scan:${requestId}`);
    expect(redis.del).toHaveBeenCalledWith(`workflow-templates:scan:${requestId}`);

    expect(result.map((r) => r.fileName)).toEqual(['a.json', 'b.json', 'c.json']);
    expect(result[0]).toMatchObject({ valid: false, errors: ['不是合法的 JSON 文件'] });
    expect(result[1]).toMatchObject({
      valid: true,
      name: '开发流程',
      nodeCount: 2,
      errors: [],
    });
    expect(result[1].nodes).toHaveLength(2);
    expect(result[2]).toMatchObject({ valid: false, errors: ['file too large'] });
  });
});
