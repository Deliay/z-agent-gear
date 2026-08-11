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
    type: string;
    name: string;
    stage: string;
    prompts?: string[];
    artifactTitles?: string[];
    dependsOn: string[];
    requiresWorktree: boolean;
    agentConfig?: { acpServerType: string; modeId?: string | null; modelId?: string | null; initNewWorktree: boolean } | null;
  }[] = [
    { nodeKey: 'requirement', type: 'HUMAN', name: '产品需求', stage: '需求', dependsOn: [], requiresWorktree: false },
    {
      nodeKey: 'tech-design',
      type: 'AI',
      name: '技术方案',
      stage: '设计',
      prompts: ['产出技术方案'],
      artifactTitles: ['技术方案文档'],
      dependsOn: ['requirement'],
      requiresWorktree: true,
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
    const input = makeInput({ nodes: [{ nodeKey: 'requirement', type: 'HUMAN', name: '产品需求', stage: '需求', dependsOn: [], requiresWorktree: false }, { nodeKey: 'tech-design', type: 'AI', name: '技术方案', stage: '设计', prompts: ['x'], dependsOn: ['requirement'], requiresWorktree: false }] });
    await expect(configuredWorkflowService.configure('user-1', 'tpl-1', input as never)).rejects.toThrow(
      /技术方案.*Agent 配置|Agent 配置.*技术方案/,
    );
    expect(ConfiguredWorkflow.create).not.toHaveBeenCalled();
  });

  it('acpServerType 不在 controller capabilities 可用列表内时拒绝', async () => {
    const input = makeInput({
      nodes: [
        { nodeKey: 'requirement', type: 'HUMAN', name: '产品需求', stage: '需求', dependsOn: [], requiresWorktree: false },
        { nodeKey: 'tech-design', type: 'AI', name: '技术方案', stage: '设计', prompts: ['x'], dependsOn: ['requirement'], requiresWorktree: false, agentConfig: { acpServerType: 'gemini_cli', initNewWorktree: true } },
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

  it('copyFromTemplate 以模板节点为准，input 仅提供 agentConfig', async () => {
    const input = makeInput({ nodes: [{ nodeKey: 'requirement' }, { nodeKey: 'tech-design', agentConfig: { acpServerType: 'opencode', initNewWorktree: true } }] });
    vi.mocked(ConfiguredWorkflow.create).mockResolvedValue({ _id: oid('cfg-1') } as never);
    await expect(configuredWorkflowService.configure('user-1', 'tpl-1', input as never)).resolves.toBeTruthy();
  });
});

describe('ConfiguredWorkflowService.update', () => {
  const existingDoc = () => ({
    _id: oid('cfg-1'),
    userId: oid('user-1'),
    name: '旧名字',
    controllerId: oid('ctrl-1'),
    nodes: [
      { nodeKey: 'requirement', type: 'HUMAN', name: '产品需求', stage: '需求', dependsOn: [], requiresWorktree: false, agentConfig: null },
      {
        nodeKey: 'tech-design',
        type: 'AI',
        name: '技术方案',
        stage: '设计',
        prompts: ['旧提示词'],
        artifactTitles: ['旧产物'],
        dependsOn: ['requirement'],
        requiresWorktree: true,
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

  it('C1: 成功修改 prompts/增删节点/调依赖，通过完整图校验后整体替换 nodes', async () => {
    const doc = existingDoc();
    vi.mocked(ConfiguredWorkflow.findOne).mockResolvedValue(doc as never);

    await configuredWorkflowService.update(
      'user-1',
      'cfg-1',
      makeInput({
        name: '新名字',
        nodes: [
          { nodeKey: 'requirement', type: 'HUMAN', name: '产品需求', stage: '需求', dependsOn: [], requiresWorktree: false },
          { nodeKey: 'tech-design', type: 'AI', name: '技术方案', stage: '设计', prompts: ['新提示词'], artifactTitles: ['新产物'], dependsOn: ['requirement'], requiresWorktree: true, agentConfig: { acpServerType: 'claude_code', modeId: 'plan', initNewWorktree: false } },
          { nodeKey: 'extra', type: 'AI', name: '额外', stage: '实现', prompts: ['做某事'], dependsOn: ['tech-design'], requiresWorktree: false, agentConfig: { acpServerType: 'opencode', initNewWorktree: false } },
        ],
      }) as never,
    );

    expect(doc.name).toBe('新名字');
    expect(doc.nodes).toHaveLength(3);
    expect(doc.nodes.map((n: { nodeKey: string }) => n.nodeKey)).toEqual(['requirement', 'tech-design', 'extra']);
    expect(doc.save).toHaveBeenCalled();
  });

  it('C2: 非法图（双首节点）报与模板校验一致的具体错误，不保存', async () => {
    const doc = existingDoc();
    vi.mocked(ConfiguredWorkflow.findOne).mockResolvedValue(doc as never);

    await expect(
      configuredWorkflowService.update(
        'user-1',
        'cfg-1',
        makeInput({
          nodes: [
            { nodeKey: 'requirement', type: 'HUMAN', name: '产品需求', stage: '需求', dependsOn: [], requiresWorktree: false },
            { nodeKey: 'tech-design', type: 'AI', name: '技术方案', stage: '设计', prompts: ['x'], dependsOn: [], requiresWorktree: false, agentConfig: { acpServerType: 'opencode', initNewWorktree: false } },
          ],
        }) as never,
      ),
    ).rejects.toThrow(/首节点必须唯一/);
    expect(doc.save).not.toHaveBeenCalled();
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

  it('A6: 存在活跃实例也可删除（快照模型下实例自包含，删除约束已移除）', async () => {
    const doc = { _id: oid('cfg-1'), deleteOne: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(ConfiguredWorkflow.findOne).mockResolvedValue(doc as never);

    await expect(configuredWorkflowService.delete('user-1', 'cfg-1')).resolves.toBe(true);
    expect(doc.deleteOne).toHaveBeenCalled();
  });

  it('requireAiOwned：人类创建的配置拒绝 AI 删除', async () => {
    const doc = { _id: oid('cfg-1'), createdBy: 'HUMAN', deleteOne: vi.fn() };
    vi.mocked(ConfiguredWorkflow.findOne).mockResolvedValue(doc as never);

    await expect(configuredWorkflowService.delete('user-1', 'cfg-1', { requireAiOwned: true })).rejects.toThrow(
      /人类创建，不允许 AI 删除/,
    );
    expect(doc.deleteOne).not.toHaveBeenCalled();
  });

  it('requireAiOwned：AI 创建的配置允许 AI 删除', async () => {
    const doc = { _id: oid('cfg-1'), createdBy: 'AI', deleteOne: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(ConfiguredWorkflow.findOne).mockResolvedValue(doc as never);

    await expect(configuredWorkflowService.delete('user-1', 'cfg-1', { requireAiOwned: true })).resolves.toBe(true);
    expect(doc.deleteOne).toHaveBeenCalled();
  });

  it('已配置工作流不存在时拒绝', async () => {
    vi.mocked(ConfiguredWorkflow.findOne).mockResolvedValue(null as never);
    await expect(configuredWorkflowService.delete('user-1', 'cfg-x')).rejects.toThrow(/不存在/);
  });
});
