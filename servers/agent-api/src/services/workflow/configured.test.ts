import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../models/configured-workflow.js', () => ({
  ConfiguredWorkflow: {
    find: vi.fn(),
    findOne: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock('../../models/workflow-template.js', () => ({
  WorkflowTemplate: {
    findOne: vi.fn(),
  },
}));

vi.mock('../../models/workflow-instance.js', () => ({
  WorkflowInstance: {
    exists: vi.fn(),
  },
}));

vi.mock('../../models/controller.js', () => ({
  Controller: {
    findOne: vi.fn(),
  },
}));

vi.mock('../../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

import { copyFromTemplate, configuredWorkflowService } from './configured.js';
import { ConfiguredWorkflow } from '../../models/configured-workflow.js';
import { WorkflowTemplate } from '../../models/workflow-template.js';
import { WorkflowInstance } from '../../models/workflow-instance.js';
import { Controller } from '../../models/controller.js';
import { getRedisClient } from '../../middleware/redis.js';

const mockRedis = { get: vi.fn() };

function oid(id: string) {
  return { toString: () => id } as import('mongoose').Types.ObjectId;
}

function leanQuery(result: unknown) {
  return { lean: vi.fn().mockResolvedValue(result) } as never;
}

function makeTemplate() {
  const nodes: {
    nodeKey: string;
    type: string;
    name: string;
    description?: string | null;
    stage: string;
    prompts?: string[];
    artifactTitles?: string[];
    dependsOn: string[];
    requiresWorktree: boolean;
  }[] = [
    {
      nodeKey: 'requirement',
      type: 'HUMAN',
      name: '产品需求',
      description: '输入需求',
      stage: '需求',
      dependsOn: [],
      requiresWorktree: false,
    },
    {
      nodeKey: 'tech-design',
      type: 'AI',
      name: '技术方案',
      description: null,
      stage: '设计',
      prompts: ['产出技术方案'],
      artifactTitles: ['技术方案文档'],
      dependsOn: ['requirement'],
      requiresWorktree: true,
    },
  ];
  return {
    _id: oid('tpl-1'),
    userId: oid('user-1'),
    name: '开发工作流',
    version: 3,
    isBuiltin: false,
    nodes,
  };
}

function makeInput(overrides: Record<string, unknown> = {}) {
  const nodes: {
    nodeKey: string;
    agentConfig?: { acpServerType: string; modeId?: string | null; modelId?: string | null; initNewWorktree: boolean } | null;
  }[] = [
    { nodeKey: 'requirement' },
    {
      nodeKey: 'tech-design',
      agentConfig: { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: true },
    },
  ];
  return {
    name: '我的开发流',
    controllerId: 'ctrl-1',
    nodes,
    ...overrides,
  };
}

function mockControllerFound() {
  vi.mocked(Controller.findOne).mockReturnValue(leanQuery({ _id: oid('ctrl-1'), userId: oid('user-1'), name: 'dev-machine' }));
}

function mockCapabilities(types: string[]) {
  mockRedis.get.mockResolvedValue(
    JSON.stringify({ servers: types.map((t) => ({ type: t, available: true })), checkedAt: new Date().toISOString() }),
  );
}

describe('copyFromTemplate', () => {
  it('生成快照副本：深拷贝 nodes、记录来源模板与版本', () => {
    const template = makeTemplate();
    const snapshot = copyFromTemplate(template as never, makeInput() as never);

    expect(snapshot.sourceTemplateId).toBe('tpl-1');
    expect(snapshot.sourceTemplateVersion).toBe(3);
    expect(snapshot.name).toBe('我的开发流');
    expect(snapshot.nodes).toHaveLength(2);
    expect(snapshot.nodes[0]).toMatchObject({ nodeKey: 'requirement', type: 'HUMAN', agentConfig: null });
    expect(snapshot.nodes[1]).toMatchObject({
      nodeKey: 'tech-design',
      prompts: ['产出技术方案'],
      artifactTitles: ['技术方案文档'],
      agentConfig: { acpServerType: 'opencode', initNewWorktree: true },
    });
  });

  it('快照隔离：复制后修改模板不影响副本', () => {
    const template = makeTemplate();
    const snapshot = copyFromTemplate(template as never, makeInput() as never);

    // 修改模板的标量字段与数组内容
    template.nodes[1].name = '被改掉的模板节点';
    template.nodes[1].prompts!.push('新增提示词');
    template.nodes[1].dependsOn.push('extra');

    expect(snapshot.nodes[1].name).toBe('技术方案');
    expect(snapshot.nodes[1].prompts).toEqual(['产出技术方案']);
    expect(snapshot.nodes[1].dependsOn).toEqual(['requirement']);
  });
});

describe('ConfiguredWorkflowService.configure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
    mockControllerFound();
    mockCapabilities(['opencode', 'claude_code']);
    vi.mocked(WorkflowTemplate.findOne).mockReturnValue(leanQuery(makeTemplate()));
  });

  it('成功：创建快照副本并记录来源', async () => {
    vi.mocked(ConfiguredWorkflow.create).mockResolvedValue({ _id: oid('cfg-1') } as never);

    await configuredWorkflowService.configure('user-1', 'tpl-1', makeInput() as never);

    expect(ConfiguredWorkflow.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        controllerId: 'ctrl-1',
        name: '我的开发流',
        sourceTemplateVersion: 3,
      }),
    );
  });

  it('模板不存在时拒绝', async () => {
    vi.mocked(WorkflowTemplate.findOne).mockReturnValue(leanQuery(null));
    await expect(configuredWorkflowService.configure('user-1', 'tpl-x', makeInput() as never)).rejects.toThrow(
      /模板不存在/,
    );
  });

  it('controllerId 不属于当前用户时拒绝', async () => {
    vi.mocked(Controller.findOne).mockReturnValue(leanQuery(null));
    await expect(configuredWorkflowService.configure('user-1', 'tpl-1', makeInput() as never)).rejects.toThrow(
      /控制器/,
    );
    expect(ConfiguredWorkflow.create).not.toHaveBeenCalled();
  });

  it('AI 节点缺少 agentConfig 时拒绝并指出节点', async () => {
    const input = makeInput({ nodes: [{ nodeKey: 'requirement' }, { nodeKey: 'tech-design' }] });
    await expect(configuredWorkflowService.configure('user-1', 'tpl-1', input as never)).rejects.toThrow(
      /技术方案.*Agent 配置|Agent 配置.*技术方案/,
    );
    expect(ConfiguredWorkflow.create).not.toHaveBeenCalled();
  });

  it('acpServerType 不在 controller capabilities 可用列表内时拒绝', async () => {
    const input = makeInput({
      nodes: [
        { nodeKey: 'requirement' },
        { nodeKey: 'tech-design', agentConfig: { acpServerType: 'gemini_cli', initNewWorktree: true } },
      ],
    });
    await expect(configuredWorkflowService.configure('user-1', 'tpl-1', input as never)).rejects.toThrow(
      /gemini_cli.*不在|不可用/,
    );
  });

  it('capabilities 缓存缺失（控制器离线）时拒绝', async () => {
    mockRedis.get.mockResolvedValue(null);
    await expect(configuredWorkflowService.configure('user-1', 'tpl-1', makeInput() as never)).rejects.toThrow(
      /能力|capabilities|离线/,
    );
  });

  it('输入包含模板中不存在的节点时拒绝', async () => {
    const input = makeInput({
      nodes: [
        ...makeInput().nodes,
        { nodeKey: 'ghost', agentConfig: { acpServerType: 'opencode', initNewWorktree: false } },
      ],
    });
    await expect(configuredWorkflowService.configure('user-1', 'tpl-1', input as never)).rejects.toThrow(/ghost/);
  });
});

describe('ConfiguredWorkflowService.update', () => {
  const existingDoc = () => ({
    _id: oid('cfg-1'),
    userId: oid('user-1'),
    name: '旧名字',
    controllerId: oid('ctrl-1'),
    nodes: [
      { nodeKey: 'requirement', type: 'HUMAN', name: '产品需求', agentConfig: null },
      {
        nodeKey: 'tech-design',
        type: 'AI',
        name: '技术方案',
        agentConfig: { acpServerType: 'opencode', initNewWorktree: true },
      },
    ],
    save: vi.fn().mockResolvedValue(undefined),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
    mockControllerFound();
    mockCapabilities(['opencode', 'claude_code']);
  });

  it('禁止增删节点：nodeKey 集合不一致时拒绝', async () => {
    const doc = existingDoc();
    vi.mocked(ConfiguredWorkflow.findOne).mockResolvedValue(doc as never);

    // 少一个节点
    await expect(
      configuredWorkflowService.update('user-1', 'cfg-1', makeInput({ nodes: [{ nodeKey: 'requirement' }] }) as never),
    ).rejects.toThrow(/不允许增删节点/);

    // 多一个节点
    await expect(
      configuredWorkflowService.update(
        'user-1',
        'cfg-1',
        makeInput({
          nodes: [
            ...makeInput().nodes,
            { nodeKey: 'extra', agentConfig: { acpServerType: 'opencode', initNewWorktree: false } },
          ],
        }) as never,
      ),
    ).rejects.toThrow(/不允许增删节点/);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('成功：仅更新 name/controllerId/agentConfig', async () => {
    const doc = existingDoc();
    vi.mocked(ConfiguredWorkflow.findOne).mockResolvedValue(doc as never);

    await configuredWorkflowService.update(
      'user-1',
      'cfg-1',
      makeInput({
        name: '新名字',
        nodes: [
          { nodeKey: 'requirement' },
          { nodeKey: 'tech-design', agentConfig: { acpServerType: 'claude_code', modeId: 'plan', initNewWorktree: false } },
        ],
      }) as never,
    );

    expect(doc.name).toBe('新名字');
    expect(doc.nodes[1].agentConfig).toMatchObject({ acpServerType: 'claude_code', modeId: 'plan' });
    expect(doc.save).toHaveBeenCalled();
  });

  it('已配置工作流不存在时拒绝', async () => {
    vi.mocked(ConfiguredWorkflow.findOne).mockResolvedValue(null as never);
    await expect(configuredWorkflowService.update('user-1', 'cfg-x', makeInput() as never)).rejects.toThrow(
      /不存在/,
    );
  });
});

describe('ConfiguredWorkflowService.delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('存在未终结实例引用时拒绝删除', async () => {
    const doc = { _id: oid('cfg-1'), deleteOne: vi.fn() };
    vi.mocked(ConfiguredWorkflow.findOne).mockResolvedValue(doc as never);
    vi.mocked(WorkflowInstance.exists).mockResolvedValue({ _id: oid('inst-1') } as never);

    await expect(configuredWorkflowService.delete('user-1', 'cfg-1')).rejects.toThrow(/未终结|无法删除/);
    expect(doc.deleteOne).not.toHaveBeenCalled();
    // 校验查询条件包含 configuredWorkflowId 与非 DONE 节点
    expect(WorkflowInstance.exists).toHaveBeenCalledWith(
      expect.objectContaining({ configuredWorkflowId: 'cfg-1' }),
    );
  });

  it('活跃实例判定使用 $elemMatch（数组上 $ne 语义为「没有任何节点为该状态」）', async () => {
    const doc = { _id: oid('cfg-1'), deleteOne: vi.fn() };
    vi.mocked(ConfiguredWorkflow.findOne).mockResolvedValue(doc as never);
    vi.mocked(WorkflowInstance.exists).mockResolvedValue(null as never);

    await configuredWorkflowService.delete('user-1', 'cfg-1');
    // 终结态 = DONE / REJECT；任一节点处于其他状态即视为活跃实例
    expect(WorkflowInstance.exists).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: { $elemMatch: { status: { $nin: ['DONE', 'REJECT'] } } },
      }),
    );
  });

  it('实例全部终结（或无实例）时允许删除', async () => {
    const doc = { _id: oid('cfg-1'), deleteOne: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(ConfiguredWorkflow.findOne).mockResolvedValue(doc as never);
    vi.mocked(WorkflowInstance.exists).mockResolvedValue(null as never);

    await expect(configuredWorkflowService.delete('user-1', 'cfg-1')).resolves.toBe(true);
    expect(doc.deleteOne).toHaveBeenCalled();
  });

  it('已配置工作流不存在时拒绝', async () => {
    vi.mocked(ConfiguredWorkflow.findOne).mockResolvedValue(null as never);
    await expect(configuredWorkflowService.delete('user-1', 'cfg-x')).rejects.toThrow(/不存在/);
  });
});
