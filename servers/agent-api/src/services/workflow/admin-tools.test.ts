import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../models/controller.js', () => ({
  Controller: {
    find: vi.fn(),
  },
}));

vi.mock('../../models/mcp-server.js', () => ({
  McpServer: {
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock('./template.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./template.js')>();
  return {
    ...actual,
    workflowTemplateService: {
      create: vi.fn(),
      listForUser: vi.fn(),
      findById: vi.fn(),
      delete: vi.fn(),
    },
  };
});

vi.mock('./configured.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./configured.js')>();
  return {
    ...actual,
    configuredWorkflowService: {
      configure: vi.fn(),
      configureFromContent: vi.fn(),
      listForUser: vi.fn(),
      findById: vi.fn(),
      delete: vi.fn(),
    },
  };
});

vi.mock('./instance.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./instance.js')>();
  return {
    ...actual,
    workflowInstanceService: {
      instantiate: vi.fn(),
    },
  };
});

import {
  callAdminTool,
  getAdminToolDefinitions,
  handleAdminPlatformMcpRequest,
  ADMIN_PLATFORM_SERVER_NAME,
  AdminToolError,
} from './admin-tools.js';
import { workflowTemplateService } from './template.js';
import { configuredWorkflowService } from './configured.js';
import { workflowInstanceService } from './instance.js';
import { Controller } from '../../models/controller.js';
import {
  ADMIN_PROMPT_RESOURCES,
  ADMIN_PROMPT_RESOURCE_URI_PREFIX,
  getAdminPromptText,
  listAdminPromptNames,
} from './admin-prompts.js';

function oid(id: string) {
  return { toString: () => id } as import('mongoose').Types.ObjectId;
}

function leanQuery(result: unknown) {
  return { lean: vi.fn().mockResolvedValue(result) } as never;
}

const caller = { userId: 'user-1', sessionId: 'sess-1' };

function validNodes() {
  return [
    { nodeKey: 'requirement', type: 'HUMAN', name: '需求', stage: '需求', dependsOn: [], requiresWorktree: false },
    {
      nodeKey: 'design',
      type: 'AI',
      name: '技术方案',
      stage: '设计',
      prompts: ['产出方案'],
      dependsOn: ['requirement'],
      requiresWorktree: true,
      agentConfig: { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: true },
    },
  ];
}

describe('admin-tools 工具定义', () => {
  it('暴露 13 个工具，且 getWorkflowToolInputSchema 是其中之一', () => {
    const defs = getAdminToolDefinitions();
    const names = defs.map((d) => d.name);
    expect(names).toHaveLength(13);
    for (const expected of [
      'createWorkflowTemplate',
      'listWorkflowTemplates',
      'getWorkflowTemplate',
      'deleteWorkflowTemplate',
      'listControllers',
      'createConfiguredWorkflow',
      'listConfiguredWorkflows',
      'getConfiguredWorkflow',
      'deleteConfiguredWorkflow',
      'instantiateWorkflowFromTemplate',
      'instantiateWorkflowFromConfigured',
      'instantiateWorkflowFromContent',
      'getWorkflowToolInputSchema',
    ]) {
      expect(names).toContain(expected);
    }
    // 每个工具都有 inputSchema
    for (const d of defs) {
      expect(d.inputSchema).toBeTruthy();
    }
  });

  it('M10: getWorkflowToolInputSchema 返回与工具定义一致的入参 JSON Schema', async () => {
    const def = getAdminToolDefinitions().find((d) => d.name === 'createConfiguredWorkflow')!;
    const out = await callAdminTool(caller, 'getWorkflowToolInputSchema', { toolName: 'createConfiguredWorkflow' });
    expect(out).toMatchObject({ toolName: 'createConfiguredWorkflow', inputSchema: def.inputSchema });
  });

  it('M11: getWorkflowToolInputSchema 传非法工具名返回可读错误并列出可用工具', async () => {
    await expect(callAdminTool(caller, 'getWorkflowToolInputSchema', { toolName: 'foo' })).rejects.toThrow(
      AdminToolError,
    );
    await expect(callAdminTool(caller, 'getWorkflowToolInputSchema', { toolName: 'foo' })).rejects.toThrow(
      /未知工具|foo/,
    );
  });
});

describe('admin-tools 模板管理', () => {
  beforeEach(() => vi.clearAllMocks());

  it('M1: createWorkflowTemplate 写入 createdBy=AI + createdBySessionId，返回 id/name', async () => {
    vi.mocked(workflowTemplateService.create).mockResolvedValue({ _id: oid('tpl-1'), name: '我的模板' } as never);

    const out = await callAdminTool(caller, 'createWorkflowTemplate', {
      name: '我的模板',
      nodes: validNodes(),
    });

    expect(workflowTemplateService.create).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ name: '我的模板' }),
      { createdBy: 'AI', createdBySessionId: 'sess-1' },
    );
    expect(out).toMatchObject({ id: 'tpl-1', name: '我的模板' });
  });

  it('M2: deleteWorkflowTemplate（AI 创建）成功', async () => {
    vi.mocked(workflowTemplateService.delete).mockResolvedValue(true);
    const out = await callAdminTool(caller, 'deleteWorkflowTemplate', { id: 'tpl-1' });
    expect(workflowTemplateService.delete).toHaveBeenCalledWith('tpl-1', 'user-1', { requireAiOwned: true });
    expect(out).toMatchObject({ deleted: true, id: 'tpl-1' });
  });

  it('M3: 缺失 userId 拒绝', async () => {
    await expect(callAdminTool({ sessionId: 's' }, 'listWorkflowTemplates', {})).rejects.toThrow(AdminToolError);
  });
});

describe('admin-tools 控制器列表', () => {
  it('M4: listControllers 仅返回当前用户控制器摘要', async () => {
    const controllers = [
      { _id: oid('c1'), name: 'dev', status: 'online', lastHeartbeatAt: new Date('2026-01-01') },
      { _id: oid('c2'), name: 'cloud', status: 'offline', lastHeartbeatAt: null },
    ];
    const lean = vi.fn().mockResolvedValue(controllers);
    const select = vi.fn().mockReturnValue({ lean });
    vi.mocked(Controller.find).mockReturnValue({ select } as never);

    const out = await callAdminTool(caller, 'listControllers', {});

    expect(Controller.find).toHaveBeenCalledWith({ userId: 'user-1' });
    expect(out).toMatchObject({ controllers: [{ id: 'c1', name: 'dev', status: 'online' }, { id: 'c2', name: 'cloud', status: 'offline' }] });
  });
});

describe('admin-tools 已配置工作流', () => {
  beforeEach(() => vi.clearAllMocks());

  it('M5: createConfiguredWorkflow 基于模板复制，写入 AI 归属', async () => {
    vi.mocked(configuredWorkflowService.configure).mockResolvedValue({ _id: oid('cfg-1'), name: '我的配置' } as never);

    const out = await callAdminTool(caller, 'createConfiguredWorkflow', {
      name: '我的配置',
      controllerId: 'ctrl-1',
      templateId: 'tpl-1',
      nodes: [{ nodeKey: 'requirement', type: 'HUMAN', name: '需求', stage: '需求', dependsOn: [], requiresWorktree: false }],
    });

    expect(configuredWorkflowService.configure).toHaveBeenCalledWith(
      'user-1',
      'tpl-1',
      expect.objectContaining({ name: '我的配置', controllerId: 'ctrl-1' }),
      { createdBy: 'AI', createdBySessionId: 'sess-1' },
    );
    expect(out).toMatchObject({ id: 'cfg-1', name: '我的配置' });
  });

  it('M5b: createConfiguredWorkflow 无模板时走 configureFromContent', async () => {
    vi.mocked(configuredWorkflowService.configureFromContent).mockResolvedValue({ _id: oid('cfg-2'), name: '直建配置' } as never);

    const out = await callAdminTool(caller, 'createConfiguredWorkflow', {
      name: '直建配置',
      controllerId: 'ctrl-1',
      nodes: validNodes(),
    });

    expect(configuredWorkflowService.configureFromContent).toHaveBeenCalled();
    expect(out).toMatchObject({ id: 'cfg-2' });
  });

  it('M6: deleteConfiguredWorkflow（AI 创建）成功，即使有实例引用', async () => {
    vi.mocked(configuredWorkflowService.delete).mockResolvedValue(true);
    const out = await callAdminTool(caller, 'deleteConfiguredWorkflow', { id: 'cfg-1' });
    expect(configuredWorkflowService.delete).toHaveBeenCalledWith('user-1', 'cfg-1', { requireAiOwned: true });
    expect(out).toMatchObject({ deleted: true });
  });
});

describe('admin-tools 实例化', () => {
  beforeEach(() => vi.clearAllMocks());

  it('M7: 三个实例化工具缺 controllerId 报参数错误', async () => {
    for (const [tool, args] of [
      ['instantiateWorkflowFromTemplate', { templateId: 't1', workspaceId: 'w1', name: 'n', nodes: [] }],
      ['instantiateWorkflowFromConfigured', { configuredWorkflowId: 'c1', workspaceId: 'w1', name: 'n', nodes: [] }],
      ['instantiateWorkflowFromContent', { workspaceId: 'w1', name: 'n', nodes: [] }],
    ] as const) {
      await expect(callAdminTool(caller, tool, args as never)).rejects.toThrow(/controllerId/);
    }
    expect(workflowInstanceService.instantiate).not.toHaveBeenCalled();
  });

  it('M7b: FromTemplate 传递 templateId 并实例化', async () => {
    vi.mocked(workflowInstanceService.instantiate).mockResolvedValue({ _id: oid('inst-1'), name: '实例', nodes: [] } as never);
    const out = await callAdminTool(caller, 'instantiateWorkflowFromTemplate', {
      templateId: 't1',
      controllerId: 'c1',
      workspaceId: 'w1',
      name: '实例',
      nodes: validNodes(),
    });
    expect(workflowInstanceService.instantiate).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ source: 'TEMPLATE', templateId: 't1', controllerId: 'c1', workspaceId: 'w1' }),
    );
    expect(out).toMatchObject({ id: 'inst-1' });
  });

  it('M8: instantiateWorkflowFromContent 传完整图直接建实例（不落库模板/配置）', async () => {
    vi.mocked(workflowInstanceService.instantiate).mockResolvedValue({ _id: oid('inst-2'), name: '直建', nodes: [] } as never);
    const out = await callAdminTool(caller, 'instantiateWorkflowFromContent', {
      controllerId: 'c1',
      workspaceId: 'w1',
      name: '直建',
      nodes: validNodes(),
    });
    expect(workflowInstanceService.instantiate).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ source: 'BLANK', templateId: null, configuredWorkflowId: null }),
    );
    expect(out).toMatchObject({ id: 'inst-2' });
  });
});

describe('handleAdminPlatformMcpRequest', () => {
  it('initialize 返回平台服务信息', async () => {
    const out = await handleAdminPlatformMcpRequest(caller, { method: 'initialize' });
    expect(out.result).toMatchObject({ serverInfo: { name: ADMIN_PLATFORM_SERVER_NAME } });
  });

  it('tools/list 返回 13 个工具', async () => {
    const out = await handleAdminPlatformMcpRequest(caller, { method: 'tools/list' });
    expect((out.result as { tools: unknown[] }).tools).toHaveLength(13);
  });

  it('M9: tools/call 未知工具返回可读错误', async () => {
    const out = await handleAdminPlatformMcpRequest(caller, { method: 'tools/call', params: { name: 'foo', arguments: {} } });
    expect(out.result).toMatchObject({ isError: true });
  });

  it('T-AP6: initialize 声明 tools 与 resources 能力（不含 prompts），协议版本与服务信息不变', async () => {
    const out = await handleAdminPlatformMcpRequest(caller, { method: 'initialize' });
    expect(out.result).toMatchObject({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: ADMIN_PLATFORM_SERVER_NAME, version: '1.0.0' },
    });
    expect((out.result as { capabilities: Record<string, unknown> }).capabilities).not.toHaveProperty(
      'prompts',
    );
  });

  it('T-AP7: resources/list 输出与注册表逐项一致（长度 2、声明序稳定）', async () => {
    const out = await handleAdminPlatformMcpRequest(caller, { method: 'resources/list' });
    const resources = (
      out.result as {
        resources: Array<{ uri: string; name: string; description: string; mimeType: string }>;
      }
    ).resources;
    expect(resources).toHaveLength(2);
    expect(resources.map((item) => item.name)).toEqual(listAdminPromptNames());
    expect(resources).toEqual(ADMIN_PROMPT_RESOURCES);
    for (const item of resources) {
      expect(item.uri.startsWith(ADMIN_PROMPT_RESOURCE_URI_PREFIX)).toBe(true);
      expect(item.description.trim().length).toBeGreaterThan(0);
      expect(item.mimeType).toBe('text/markdown');
    }
  });

  it('T-AP8: resources/read 命中返回 text/markdown 且文本与注册表同源', async () => {
    for (const definition of ADMIN_PROMPT_RESOURCES) {
      const out = await handleAdminPlatformMcpRequest(caller, {
        method: 'resources/read',
        params: { uri: definition.uri },
      });
      const result = out.result as {
        contents: Array<{ uri: string; mimeType: string; text: string }>;
      };
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0]).toEqual({
        uri: definition.uri,
        mimeType: definition.mimeType,
        text: getAdminPromptText(definition.name),
      });
    }
  });

  it('T-AP9: resources/read 缺 uri 或空串返回 INVALID_PARAMS 并列出可用 URI', async () => {
    for (const params of [undefined, { uri: '' }]) {
      const out = await handleAdminPlatformMcpRequest(caller, { method: 'resources/read', params });
      expect(out.error?.code).toBe('INVALID_PARAMS');
      expect(out.error?.message).toContain('缺少 params.uri');
      for (const definition of ADMIN_PROMPT_RESOURCES) {
        expect(out.error?.message).toContain(definition.uri);
      }
    }
  });

  it('T-AP10: resources/read 未知 URI 返回 INVALID_PARAMS 并列出可用 URI', async () => {
    const out = await handleAdminPlatformMcpRequest(caller, {
      method: 'resources/read',
      params: { uri: 'zag://agent-workflow-admin-tools/prompt/foo' },
    });
    expect(out.error?.code).toBe('INVALID_PARAMS');
    expect(out.error?.message).toContain('未知资源');
    expect(out.error?.message).toContain('zag://agent-workflow-admin-tools/prompt/foo');
    for (const definition of ADMIN_PROMPT_RESOURCES) {
      expect(out.error?.message).toContain(definition.uri);
    }
  });

  it('T-AP11: prompts/list 与 prompts/get 已移除（METHOD_NOT_FOUND）', async () => {
    await expect(
      handleAdminPlatformMcpRequest(caller, { method: 'prompts/list' }),
    ).resolves.toMatchObject({ error: { code: 'METHOD_NOT_FOUND' } });
    await expect(
      handleAdminPlatformMcpRequest(caller, {
        method: 'prompts/get',
        params: { name: 'workflow-schema' },
      }),
    ).resolves.toMatchObject({ error: { code: 'METHOD_NOT_FOUND' } });
  });
});
