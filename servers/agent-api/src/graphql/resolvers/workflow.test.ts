import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/workflow/template.js', () => ({
  workflowTemplateService: {
    listForUser: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../services/workflow/configured.js', () => ({
  configuredWorkflowService: {
    listForUser: vi.fn(),
    findById: vi.fn(),
    configure: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../services/workflow/instance.js', () => ({
  workflowInstanceService: {
    list: vi.fn(),
    listForWorkspace: vi.fn(),
    findById: vi.fn(),
    instantiate: vi.fn(),
    updateNode: vi.fn(),
    completeHumanNode: vi.fn(),
    rejectNode: vi.fn(),
    setAdditionalPrompt: vi.fn(),
    removeAdditionalPrompt: vi.fn(),
  },
}));

vi.mock('../../services/workflow/pr-handler-registry.js', () => ({
  prHandlerRegistry: { listByInstance: vi.fn() },
}));

vi.mock('../../services/controller.js', () => ({
  controllerService: {
    findById: vi.fn(),
  },
}));

vi.mock('../../services/controller-workspace.js', () => ({
  controllerWorkspaceService: {
    findById: vi.fn(),
  },
}));

import { workflowResolvers } from './workflow.js';
import { workflowTemplateService } from '../../services/workflow/template.js';
import { configuredWorkflowService } from '../../services/workflow/configured.js';
import { workflowInstanceService } from '../../services/workflow/instance.js';
import { controllerService } from '../../services/controller.js';
import { controllerWorkspaceService } from '../../services/controller-workspace.js';
import { prHandlerRegistry } from '../../services/workflow/pr-handler-registry.js';
import { mapInstance } from './workflow.js';

const ctx = { currentUser: { id: 'user-1', username: 'u' } } as never;
const emptyCtx = { currentUser: null } as never;

function oid(id: string) {
  return { toString: () => id } as import('mongoose').Types.ObjectId;
}

const templateDoc = {
  _id: oid('tpl-1'),
  name: '开发工作流',
  description: '内置模板',
  version: 2,
  isBuiltin: true,
  nodes: [
    {
      nodeKey: 'requirement',
      type: 'HUMAN',
      name: '产品需求',
      description: null,
      stage: '方案阶段',
      prompts: undefined,
      artifactTitles: undefined,
      dependsOn: [],
      requiresWorktree: false,
    },
  ],
  createdAt: new Date('2026-08-01'),
  updatedAt: new Date('2026-08-02'),
};

const configuredDoc = {
  _id: oid('cfg-1'),
  name: '我的配置',
  controllerId: oid('ctrl-1'),
  sourceTemplateId: oid('tpl-1'),
  sourceTemplateVersion: 2,
  nodes: [
    { nodeKey: 'requirement', type: 'HUMAN', name: '产品需求', stage: '方案阶段', dependsOn: [], requiresWorktree: false, agentConfig: null },
    {
      nodeKey: 'design',
      type: 'AI',
      name: '技术方案',
      stage: '方案阶段',
      prompts: ['产出方案'],
      artifactTitles: ['方案文档'],
      dependsOn: ['requirement'],
      requiresWorktree: true,
      agentConfig: { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: true },
    },
  ],
  createdAt: new Date('2026-08-01'),
  updatedAt: new Date('2026-08-02'),
};

const instanceDoc = {
  _id: oid('inst-1'),
  configuredWorkflowId: oid('cfg-1'),
  controllerId: oid('ctrl-1'),
  workspaceId: oid('ws-1'),
  name: '需求A开发',
  currentNodeNames: ['技术方案'],
  nodes: [
    {
      nodeId: 'n1',
      nodeKey: 'requirement',
      type: 'HUMAN',
      name: '产品需求',
      status: 'DONE',
      stage: '方案阶段',
      sessionId: null,
      createdAt: new Date('2026-08-01'),
      startedAt: new Date('2026-08-01'),
      reworkedAt: null,
      reworkCount: 0,
      rejectInfo: {},
    },
  ],
  blackboard: new Map([['n1-产品需求-产物-输入', '需求文本']]),
  blackboardTrash: new Map([['old-key', '旧值']]),
  blackboardUpdatedAt: new Map([['n1-产品需求-产物-输入', new Date('2026-08-01')]]),
  createdAt: new Date('2026-08-01'),
  updatedAt: new Date('2026-08-02'),
};

describe('workflow resolvers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('鉴权', () => {
    it('未登录访问全部 Query/Mutation 拒绝', async () => {
      await expect(workflowResolvers.Query.workflowTemplates({}, {}, emptyCtx)).rejects.toThrow('Not authenticated');
      await expect(workflowResolvers.Query.workflowInstance({}, { id: 'x' }, emptyCtx)).rejects.toThrow(
        'Not authenticated',
      );
      await expect(
        workflowResolvers.Mutation.createWorkflowTemplate({}, { input: {} as never }, emptyCtx),
      ).rejects.toThrow('Not authenticated');
      await expect(
        workflowResolvers.Mutation.instantiateWorkflow(
          {},
          { input: {} as never },
          emptyCtx,
        ),
      ).rejects.toThrow('Not authenticated');
    });
  });

  describe('Query', () => {
    it('workflowTemplates 按 userId 列出并正确映射', async () => {
      vi.mocked(workflowTemplateService.listForUser).mockResolvedValue([templateDoc] as never);

      const result = await workflowResolvers.Query.workflowTemplates({}, {}, ctx);

      expect(workflowTemplateService.listForUser).toHaveBeenCalledWith('user-1');
      expect(result[0]).toMatchObject({
        id: 'tpl-1',
        name: '开发工作流',
        version: 2,
        isBuiltin: true,
        createdAt: '2026-08-01T00:00:00.000Z',
      });
      expect(result[0].nodes[0]).toMatchObject({ nodeKey: 'requirement', prompts: null, artifactTitles: null });
    });

    it('workflowTemplate 他人/不存在资源返回 null（不泄漏存在性）', async () => {
      vi.mocked(workflowTemplateService.findById).mockResolvedValue(null as never);
      await expect(workflowResolvers.Query.workflowTemplate({}, { id: 'tpl-x' }, ctx)).resolves.toBeNull();
      expect(workflowTemplateService.findById).toHaveBeenCalledWith('tpl-x', 'user-1');
    });

    it('configuredWorkflows 透传 controllerId 过滤', async () => {
      vi.mocked(configuredWorkflowService.listForUser).mockResolvedValue([configuredDoc] as never);

      const result = await workflowResolvers.Query.configuredWorkflows({}, { controllerId: 'ctrl-1' }, ctx);

      expect(configuredWorkflowService.listForUser).toHaveBeenCalledWith('user-1', 'ctrl-1');
      expect(result[0]).toMatchObject({ id: 'cfg-1', controllerId: 'ctrl-1', sourceTemplateId: 'tpl-1' });
      // HUMAN 节点 agentConfig 归一化为 null；AI 节点保留
      expect(result[0].nodes[0].agentConfig).toBeNull();
      expect(result[0].nodes[1].agentConfig).toMatchObject({ acpServerType: 'opencode', initNewWorktree: true });
    });

    it('workflowInstances 按 workspaceId 列出，黑板映射为 entry 数组', async () => {
      vi.mocked(workflowInstanceService.list).mockResolvedValue([instanceDoc] as never);

      const result = await workflowResolvers.Query.workflowInstances({}, { workspaceId: 'ws-1' }, ctx);

      expect(workflowInstanceService.list).toHaveBeenCalledWith('user-1', {
        workspaceId: 'ws-1',
        controllerId: undefined,
        archived: false,
      });
      const inst = result[0];
      expect(inst).toMatchObject({ id: 'inst-1', currentNodeNames: ['技术方案'] });
      expect(inst.blackboard).toEqual([
        { key: 'n1-产品需求-产物-输入', value: '需求文本', updatedAt: '2026-08-01T00:00:00.000Z' },
      ]);
      expect(inst.blackboardTrash[0]).toMatchObject({ key: 'old-key', value: '旧值' });
      // rejectInfo 空对象归一化为 null
      expect(inst.nodes[0].rejectInfo).toBeNull();
      expect(inst.nodes[0]).toMatchObject({ id: 'n1', status: 'DONE', reworkCount: 0 });
    });

    it('workflowInstances 支持 controllerId / 无参全量与 archived 透传', async () => {
      vi.mocked(workflowInstanceService.list).mockResolvedValue([] as never);

      await workflowResolvers.Query.workflowInstances({}, {}, ctx);
      expect(workflowInstanceService.list).toHaveBeenCalledWith('user-1', {
        workspaceId: undefined,
        controllerId: undefined,
        archived: false,
      });

      await workflowResolvers.Query.workflowInstances({}, { controllerId: 'ctrl-1', archived: true }, ctx);
      expect(workflowInstanceService.list).toHaveBeenCalledWith('user-1', {
        workspaceId: undefined,
        controllerId: 'ctrl-1',
        archived: true,
      });
    });

    it('WorkflowInstance.workspace / controller 惰性解析归属（已删除返回 null）', async () => {
      vi.mocked(controllerWorkspaceService.findById).mockResolvedValue({ id: 'ws-1', name: 'project' } as never);
      vi.mocked(controllerService.findById).mockResolvedValue({ id: 'ctrl-1', name: '控制器' } as never);

      const workspace = await workflowResolvers.WorkflowInstance.workspace(
        { workspaceId: 'ws-1' },
        {},
        ctx,
      );
      const controller = await workflowResolvers.WorkflowInstance.controller(
        { controllerId: 'ctrl-1' },
        {},
        ctx,
      );
      expect(workspace).toMatchObject({ id: 'ws-1' });
      expect(controller).toMatchObject({ id: 'ctrl-1' });
      expect(controllerWorkspaceService.findById).toHaveBeenCalledWith('ws-1', 'user-1');
      expect(controllerService.findById).toHaveBeenCalledWith('ctrl-1', 'user-1');

      // 未认证 / 无归属 id → null，不查库
      await expect(
        workflowResolvers.WorkflowInstance.workspace({ workspaceId: 'ws-1' }, {}, emptyCtx),
      ).resolves.toBeNull();
      await expect(
        workflowResolvers.WorkflowInstance.controller({ controllerId: 'ctrl-1' }, {}, emptyCtx),
      ).resolves.toBeNull();
    });

    it('workflowInstance 不存在返回 null', async () => {
      vi.mocked(workflowInstanceService.findById).mockResolvedValue(null as never);
      await expect(workflowResolvers.Query.workflowInstance({}, { id: 'x' }, ctx)).resolves.toBeNull();
    });
  });

  describe('Mutation', () => {
    const input = { name: 't', nodes: [] };

    it('createWorkflowTemplate 委托服务并以 userId 作用域', async () => {
      vi.mocked(workflowTemplateService.create).mockResolvedValue(templateDoc as never);

      const result = await workflowResolvers.Mutation.createWorkflowTemplate({}, { input: input as never }, ctx);

      expect(workflowTemplateService.create).toHaveBeenCalledWith('user-1', input);
      expect(result).toMatchObject({ id: 'tpl-1' });
    });

    it('updateWorkflowTemplate 服务错误包装为 GraphQLError（内置模板拒绝）', async () => {
      vi.mocked(workflowTemplateService.update).mockRejectedValue(new Error('内置模板不允许修改，可通过「配置工作流」复制使用'));

      await expect(
        workflowResolvers.Mutation.updateWorkflowTemplate({}, { id: 'tpl-1', input: input as never }, ctx),
      ).rejects.toThrow(/内置模板不允许修改/);
    });

    it('deleteWorkflowTemplate 委托服务', async () => {
      vi.mocked(workflowTemplateService.delete).mockResolvedValue(true as never);
      await expect(
        workflowResolvers.Mutation.deleteWorkflowTemplate({}, { id: 'tpl-1' }, ctx),
      ).resolves.toBe(true);
      expect(workflowTemplateService.delete).toHaveBeenCalledWith('tpl-1', 'user-1');
    });

    it('configureWorkflow 委托服务', async () => {
      vi.mocked(configuredWorkflowService.configure).mockResolvedValue(configuredDoc as never);
      const cfgInput = { name: 'c', controllerId: 'ctrl-1', nodes: [] };

      const result = await workflowResolvers.Mutation.configureWorkflow(
        {},
        { templateId: 'tpl-1', input: cfgInput as never },
        ctx,
      );

      expect(configuredWorkflowService.configure).toHaveBeenCalledWith('user-1', 'tpl-1', cfgInput);
      expect(result).toMatchObject({ id: 'cfg-1' });
    });

    it('updateConfiguredWorkflow / deleteConfiguredWorkflow 委托服务', async () => {
      vi.mocked(configuredWorkflowService.update).mockResolvedValue(configuredDoc as never);
      vi.mocked(configuredWorkflowService.delete).mockResolvedValue(true as never);
      const cfgInput = { name: 'c', controllerId: 'ctrl-1', nodes: [] };

      await workflowResolvers.Mutation.updateConfiguredWorkflow({}, { id: 'cfg-1', input: cfgInput as never }, ctx);
      expect(configuredWorkflowService.update).toHaveBeenCalledWith('user-1', 'cfg-1', cfgInput);

      await expect(
        workflowResolvers.Mutation.deleteConfiguredWorkflow({}, { id: 'cfg-1' }, ctx),
      ).resolves.toBe(true);
      expect(configuredWorkflowService.delete).toHaveBeenCalledWith('user-1', 'cfg-1');
    });

    it('instantiateWorkflow 委托服务并映射实例', async () => {
      vi.mocked(workflowInstanceService.instantiate).mockResolvedValue(instanceDoc as never);

      const result = await workflowResolvers.Mutation.instantiateWorkflow(
        {},
        { input: { source: 'CONFIGURED', configuredWorkflowId: 'cfg-1', workspaceId: 'ws-1', name: '需求A开发', controllerId: 'ctrl-1', nodes: [] } as never },
        ctx,
      );

      expect(workflowInstanceService.instantiate).toHaveBeenCalledWith('user-1', {
        source: 'CONFIGURED',
        configuredWorkflowId: 'cfg-1',
        workspaceId: 'ws-1',
        name: '需求A开发',
        controllerId: 'ctrl-1',
        nodes: [],
      });
      expect(result).toMatchObject({ id: 'inst-1', name: '需求A开发' });
    });

    it('completeHumanNode / rejectNode 委托服务并映射节点', async () => {
      const node = instanceDoc.nodes[0];
      vi.mocked(workflowInstanceService.completeHumanNode).mockResolvedValue(node as never);
      vi.mocked(workflowInstanceService.rejectNode).mockResolvedValue(node as never);

      const completed = await workflowResolvers.Mutation.completeHumanNode(
        {},
        { instanceId: 'inst-1', nodeId: 'n1', input: '需求文本' },
        ctx,
      );
      expect(workflowInstanceService.completeHumanNode).toHaveBeenCalledWith('user-1', 'inst-1', 'n1', '需求文本');
      expect(completed).toMatchObject({ id: 'n1', status: 'DONE' });

      await workflowResolvers.Mutation.rejectNode({}, { instanceId: 'inst-1', nodeId: 'n1', reason: '不行' }, ctx);
      expect(workflowInstanceService.rejectNode).toHaveBeenCalledWith('user-1', 'inst-1', 'n1', '不行');
    });

    it('服务层非法图错误以可读 message 抛出', async () => {
      vi.mocked(workflowTemplateService.create).mockRejectedValue(
        new Error('工作流模板存在循环依赖，环上节点：A → B'),
      );
      await expect(
        workflowResolvers.Mutation.createWorkflowTemplate({}, { input: input as never }, ctx),
      ).rejects.toThrow(/环上节点/);
    });
  });
});

describe('workflow PR 联动字段与 mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mapInstance 输出 additionalPrompts（Map/空态）并按 key 排序', () => {
    const withPrompts = mapInstance({
      ...instanceDoc,
      additionalPrompts: new Map([
        ['github-pr-review', '评审'],
        ['github-pr', '指引'],
      ]),
    });
    expect(withPrompts.additionalPrompts).toEqual([
      { key: 'github-pr', value: '指引' },
      { key: 'github-pr-review', value: '评审' },
    ]);

    const empty = mapInstance(instanceDoc);
    expect(empty.additionalPrompts).toEqual([]);
  });

  it('pullRequestLinks 按实例查询并映射节点名', async () => {
    vi.mocked(prHandlerRegistry.listByInstance).mockResolvedValue([
      {
        _id: 'h1',
        pullRequestId: 'Deliay/z-agent-gear#264',
        prUrl: 'https://github.com/Deliay/z-agent-gear/pull/264',
        nodeId: 'n1',
        createdAt: new Date('2026-10-23T06:00:00Z'),
        lastCheckRunUrl: 'https://github.com/Deliay/z-agent-gear/runs/1001',
        lastWrittenCommitSha: 'deadbeef',
        lastSyncAt: new Date('2026-10-25T00:00:00Z'),
        lastSyncError: null,
      },
    ] as never);
    const parent = mapInstance(instanceDoc);

    const links = await workflowResolvers.WorkflowInstance.pullRequestLinks(parent as never, {}, ctx);

    expect(prHandlerRegistry.listByInstance).toHaveBeenCalledWith('inst-1');
    expect(links).toEqual([
      {
        pullRequestId: 'Deliay/z-agent-gear#264',
        prUrl: 'https://github.com/Deliay/z-agent-gear/pull/264',
        nodeId: 'n1',
        nodeName: '产品需求',
        registeredAt: '2026-10-23T06:00:00.000Z',
        checkRunUrl: 'https://github.com/Deliay/z-agent-gear/runs/1001',
        lastSyncedCommitSha: 'deadbeef',
        lastSyncAt: '2026-10-25T00:00:00.000Z',
        lastSyncError: null,
      },
    ]);
  });

  it('pullRequestLinks 未同步时四个同步字段为 null（存量兼容）', async () => {
    vi.mocked(prHandlerRegistry.listByInstance).mockResolvedValue([
      {
        _id: 'h2',
        pullRequestId: 'Deliay/z-agent-gear#264',
        prUrl: null,
        nodeId: 'n1',
        createdAt: new Date('2026-10-23T06:00:00Z'),
        lastCheckRunUrl: null,
        lastWrittenCommitSha: null,
        lastSyncAt: null,
        lastSyncError: null,
      },
    ] as never);
    const parent = mapInstance(instanceDoc);

    const links = await workflowResolvers.WorkflowInstance.pullRequestLinks(parent as never, {}, ctx);

    expect(links[0]).toMatchObject({
      checkRunUrl: null,
      lastSyncedCommitSha: null,
      lastSyncAt: null,
      lastSyncError: null,
    });
  });

  it('set/removeWorkflowAdditionalPrompt 返回映射后的实例', async () => {
    vi.mocked(workflowInstanceService.setAdditionalPrompt).mockResolvedValue({
      ...instanceDoc,
      additionalPrompts: new Map([['my-note', 'v']]),
    } as never);
    const setResult = await workflowResolvers.Mutation.setWorkflowAdditionalPrompt(
      {},
      { instanceId: 'inst-1', key: 'my-note', value: 'v' },
      ctx,
    );
    expect(workflowInstanceService.setAdditionalPrompt).toHaveBeenCalledWith(
      'user-1', 'inst-1', 'my-note', 'v',
    );
    expect(setResult.additionalPrompts).toEqual([{ key: 'my-note', value: 'v' }]);

    vi.mocked(workflowInstanceService.removeAdditionalPrompt).mockResolvedValue(instanceDoc as never);
    await workflowResolvers.Mutation.removeWorkflowAdditionalPrompt(
      {},
      { instanceId: 'inst-1', key: 'my-note' },
      ctx,
    );
    expect(workflowInstanceService.removeAdditionalPrompt).toHaveBeenCalledWith(
      'user-1', 'inst-1', 'my-note',
    );
  });
});
