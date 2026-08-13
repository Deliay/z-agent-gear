import { Controller } from '../../models/controller.js';
import { workflowTemplateService } from './template.js';
import { configuredWorkflowService } from './configured.js';
import { workflowInstanceService, type InstantiateSource } from './instance.js';

/** 工作流管理平台服务名（transport/source: platform） */
export const ADMIN_PLATFORM_SERVER_NAME = 'agent-workflow-admin-tools';

/** 工具错误：code + 面向 LLM 可读的中文 message */
export class AdminToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AdminToolError';
  }
}

export interface AdminCaller {
  userId?: string;
  sessionId?: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * 入参 JSON Schema 单一来源：同时服务于 tools/list 的 inputSchema、
 * 调用前参数校验、以及 getWorkflowToolInputSchema 查表返回。
 */
const ADMIN_TOOL_SCHEMAS: Record<string, Record<string, unknown>> = {
  createWorkflowTemplate: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '模板名称（必填）' },
      description: { type: 'string', description: '模板描述（可选）' },
      nodes: {
        type: 'array',
        description: '节点列表（至少 1 个，首节点必须为人类节点）',
        items: {
          type: 'object',
          properties: {
            nodeKey: { type: 'string', description: '节点唯一标识（必填）' },
            type: { type: 'string', enum: ['HUMAN', 'AI', 'FLAG'], description: '节点类型' },
            name: { type: 'string', description: '节点名称' },
            description: { type: 'string', description: '节点描述（可选）' },
            stage: { type: 'string', description: '所属阶段' },
            prompts: { type: 'array', items: { type: 'string' }, description: 'AI 节点提示词数组（必填，至少 1 条）' },
            artifactTitles: { type: 'array', items: { type: 'string' }, description: 'AI 节点产物标题数组（可选）' },
            dependsOn: { type: 'array', items: { type: 'string' }, description: '上游节点 nodeKey 列表（空数组=首节点候选）' },
            requiresWorktree: { type: 'boolean', description: '该节点会话是否需要 worktree 隔离' },
          },
          required: ['nodeKey', 'type', 'name', 'stage', 'dependsOn', 'requiresWorktree'],
        },
      },
    },
    required: ['name', 'nodes'],
  },
  listWorkflowTemplates: { type: 'object', properties: {} },
  getWorkflowTemplate: {
    type: 'object',
    properties: { id: { type: 'string', description: '模板 ID（必填）' } },
    required: ['id'],
  },
  deleteWorkflowTemplate: {
    type: 'object',
    properties: { id: { type: 'string', description: '模板 ID（必填）；仅可删除 AI 创建的模板' } },
    required: ['id'],
  },
  listControllers: { type: 'object', properties: {} },
  createConfiguredWorkflow: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '已配置工作流名称（必填）' },
      controllerId: { type: 'string', description: '控制器 ID（必填）' },
      templateId: { type: 'string', description: '来源模板 ID（复制其节点图）' },
      nodes: {
        type: 'array',
        description: '节点图（含 agentConfig）。若提供 templateId 可不传完整节点图',
        items: {
          type: 'object',
          properties: {
            nodeKey: { type: 'string' },
            type: { type: 'string', enum: ['HUMAN', 'AI', 'FLAG'] },
            name: { type: 'string' },
            description: { type: 'string' },
            stage: { type: 'string' },
            prompts: { type: 'array', items: { type: 'string' } },
            artifactTitles: { type: 'array', items: { type: 'string' } },
            dependsOn: { type: 'array', items: { type: 'string' } },
            requiresWorktree: { type: 'boolean' },
            agentConfig: {
              type: 'object',
              description: 'AI 节点 Agent 配置（必填）',
              properties: {
                acpServerType: { type: 'string', description: 'ACP 服务器类型（在控制器可用能力内）' },
                modeId: { type: 'string' },
                modelId: { type: 'string' },
                initNewWorktree: { type: 'boolean' },
              },
              required: ['acpServerType', 'initNewWorktree'],
            },
          },
          required: ['nodeKey'],
        },
      },
    },
    required: ['name', 'controllerId', 'nodes'],
  },
  listConfiguredWorkflows: {
    type: 'object',
    properties: { controllerId: { type: 'string', description: '按控制器过滤（可选）' } },
  },
  getConfiguredWorkflow: {
    type: 'object',
    properties: { id: { type: 'string', description: '已配置工作流 ID（必填）' } },
    required: ['id'],
  },
  deleteConfiguredWorkflow: {
    type: 'object',
    properties: { id: { type: 'string', description: '已配置工作流 ID（必填）；仅可删除 AI 创建的配置' } },
    required: ['id'],
  },
  instantiateWorkflowFromTemplate: {
    type: 'object',
    properties: {
      templateId: { type: 'string', description: '模板 ID（必填）' },
      controllerId: { type: 'string', description: '控制器 ID（必填）' },
      workspaceId: { type: 'string', description: '工作区 ID（必填）' },
      name: { type: 'string', description: '实例名称（必填）' },
      nodes: {
        type: 'array',
        description: '最终节点图（实例化前可编辑，须含 AI 节点 agentConfig）',
        items: { type: 'object' },
      },
    },
    required: ['templateId', 'controllerId', 'workspaceId', 'name', 'nodes'],
  },
  instantiateWorkflowFromConfigured: {
    type: 'object',
    properties: {
      configuredWorkflowId: { type: 'string', description: '已配置工作流 ID（必填）' },
      controllerId: { type: 'string', description: '控制器 ID（必填）' },
      workspaceId: { type: 'string', description: '工作区 ID（必填）' },
      name: { type: 'string', description: '实例名称（必填）' },
      nodes: {
        type: 'array',
        description: '最终节点图（实例化前可编辑，须含 AI 节点 agentConfig）',
        items: { type: 'object' },
      },
    },
    required: ['configuredWorkflowId', 'controllerId', 'workspaceId', 'name', 'nodes'],
  },
  instantiateWorkflowFromContent: {
    type: 'object',
    description: '从原始工作流内容直接实例化（不落库模板/已配置工作流）',
    properties: {
      controllerId: { type: 'string', description: '控制器 ID（必填）' },
      workspaceId: { type: 'string', description: '工作区 ID（必填）' },
      name: { type: 'string', description: '实例名称（必填）' },
      nodes: {
        type: 'array',
        description: '完整节点图（必填；AI 节点须含 agentConfig）',
        items: {
          type: 'object',
          properties: {
            nodeKey: { type: 'string' },
            type: { type: 'string', enum: ['HUMAN', 'AI', 'FLAG'] },
            name: { type: 'string' },
            description: { type: 'string' },
            stage: { type: 'string' },
            prompts: { type: 'array', items: { type: 'string' } },
            artifactTitles: { type: 'array', items: { type: 'string' } },
            dependsOn: { type: 'array', items: { type: 'string' } },
            requiresWorktree: { type: 'boolean' },
            agentConfig: { type: 'object' },
          },
          required: ['nodeKey', 'type', 'name', 'stage', 'dependsOn', 'requiresWorktree'],
        },
      },
    },
    required: ['controllerId', 'workspaceId', 'name', 'nodes'],
  },
  getWorkflowToolInputSchema: {
    type: 'object',
    properties: { toolName: { type: 'string', description: '管理工具集内的工具名（必填）' } },
    required: ['toolName'],
  },
};

const ADMIN_TOOL_DEFINITIONS: ToolDefinition[] = Object.entries(ADMIN_TOOL_SCHEMAS).map(([name, inputSchema]) => ({
  name,
  description: toolDescription(name),
  inputSchema,
}));

function toolDescription(name: string): string {
  const map: Record<string, string> = {
    createWorkflowTemplate: '创建工作流模板（归属 AI）',
    listWorkflowTemplates: '列出当前用户可见的工作流模板',
    getWorkflowTemplate: '获取指定工作流模板详情',
    deleteWorkflowTemplate: '删除工作流模板（仅可删除 AI 创建的模板）',
    listControllers: '列出当前用户的控制器（id/name/在线状态/acpServerTypes 摘要）',
    createConfiguredWorkflow: '创建已配置工作流（归属 AI，可基于模板复制）',
    listConfiguredWorkflows: '列出当前用户的已配置工作流',
    getConfiguredWorkflow: '获取指定已配置工作流详情',
    deleteConfiguredWorkflow: '删除已配置工作流（仅可删除 AI 创建的配置）',
    instantiateWorkflowFromTemplate: '从模板实例化工作流',
    instantiateWorkflowFromConfigured: '从已配置工作流实例化工作流',
    instantiateWorkflowFromContent: '从原始工作流内容直接实例化（不落库）',
    getWorkflowToolInputSchema: '查询指定管理工具的入参 JSON Schema',
  };
  return map[name] ?? name;
}

export function getAdminToolDefinitions(): ToolDefinition[] {
  return ADMIN_TOOL_DEFINITIONS;
}

/** 校验入参必填字段（缺失报可读参数错误） */
function requireArgs(args: Record<string, unknown>, required: string[], toolName: string): void {
  for (const field of required) {
    const value = args[field];
    if (value === undefined || value === null || value === '') {
      throw new AdminToolError('INVALID_PARAMS', `工具 ${toolName} 参数 ${field} 必填。`);
    }
  }
}

function requireString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AdminToolError('INVALID_PARAMS', `参数 ${field} 必填且为非空字符串。`);
  }
  return value;
}

function toId(value: unknown): string | null {
  return value ? (value as { toString(): string }).toString() : null;
}

function requireUser(caller: AdminCaller): string {
  if (!caller.userId) {
    throw new AdminToolError('UNAUTHORIZED', '缺少用户身份（token 无 userId），无法执行工作流管理操作');
  }
  return caller.userId;
}

function requireSession(caller: AdminCaller): string | undefined {
  return caller.sessionId ?? undefined;
}

/** 工作流管理工具统一入口（会话作用域，仅需 {userId, sessionId} token） */
export async function callAdminTool(
  caller: AdminCaller,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const userId = requireUser(caller);
  const sessionId = requireSession(caller);

  switch (name) {
    // ---- 模板管理 ----
    case 'createWorkflowTemplate': {
      requireArgs(args, ['name', 'nodes'], name);
      const created = await workflowTemplateService.create(
        userId,
        {
          name: requireString(args, 'name'),
          description: typeof args.description === 'string' ? args.description : undefined,
          nodes: args.nodes as never,
        },
        { createdBy: 'AI', createdBySessionId: sessionId },
      );
      return { id: toId((created as unknown as { _id: unknown })._id), name: (created as unknown as { name: string }).name };
    }

    case 'listWorkflowTemplates': {
      const docs = await workflowTemplateService.listForUser(userId);
      return {
        templates: docs.map((d) => {
          const doc = d as unknown as { _id: unknown; name: string; description?: string | null; version?: number; isBuiltin?: boolean };
          return { id: toId(doc._id), name: doc.name, description: doc.description ?? null, version: doc.version ?? 1, isBuiltin: doc.isBuiltin ?? false };
        }),
      };
    }

    case 'getWorkflowTemplate': {
      const id = requireString(args, 'id');
      const doc = await workflowTemplateService.findById(id, userId);
      if (!doc) throw new AdminToolError('NOT_FOUND', '工作流模板不存在或无权限');
      return { template: doc };
    }

    case 'deleteWorkflowTemplate': {
      const id = requireString(args, 'id');
      try {
        await workflowTemplateService.delete(id, userId, { requireAiOwned: true });
      } catch (err) {
        throw new AdminToolError('FORBIDDEN', err instanceof Error ? err.message : String(err));
      }
      return { deleted: true, id };
    }

    // ---- 控制器列表 ----
    case 'listControllers': {
      const controllers = await Controller.find({ userId }).select('_id name status lastHeartbeatAt').lean();
      return { controllers: controllers.map((c) => ({ id: toId(c._id), name: c.name, status: c.status, lastHeartbeatAt: c.lastHeartbeatAt ?? null })) };
    }

    // ---- 已配置工作流 ----
    case 'createConfiguredWorkflow': {
      requireArgs(args, ['name', 'controllerId', 'nodes'], name);
      const controllerId = requireString(args, 'controllerId');
      const templateId = typeof args.templateId === 'string' && args.templateId ? args.templateId : undefined;
      let created: { _id: unknown; name: string };
      if (templateId) {
        created = (await configuredWorkflowService.configure(
          userId,
          templateId,
          { name: requireString(args, 'name'), controllerId, nodes: args.nodes as never },
          { createdBy: 'AI', createdBySessionId: sessionId },
        )) as unknown as { _id: unknown; name: string };
      } else {
        created = (await configuredWorkflowService.configureFromContent(
          userId,
          { name: requireString(args, 'name'), controllerId, nodes: args.nodes as never },
          { createdBy: 'AI', createdBySessionId: sessionId },
        )) as unknown as { _id: unknown; name: string };
      }
      return { id: toId(created._id), name: created.name };
    }

    case 'listConfiguredWorkflows': {
      const controllerId = typeof args.controllerId === 'string' && args.controllerId ? args.controllerId : undefined;
      const docs = await configuredWorkflowService.listForUser(userId, controllerId);
      return { configuredWorkflows: docs };
    }

    case 'getConfiguredWorkflow': {
      const id = requireString(args, 'id');
      const doc = await configuredWorkflowService.findById(id, userId);
      if (!doc) throw new AdminToolError('NOT_FOUND', '已配置工作流不存在或无权限');
      return { configuredWorkflow: doc };
    }

    case 'deleteConfiguredWorkflow': {
      const id = requireString(args, 'id');
      try {
        await configuredWorkflowService.delete(userId, id, { requireAiOwned: true });
      } catch (err) {
        throw new AdminToolError('FORBIDDEN', err instanceof Error ? err.message : String(err));
      }
      return { deleted: true, id };
    }

    // ---- 实例化 ----
    case 'instantiateWorkflowFromTemplate': {
      requireArgs(args, ['templateId', 'controllerId', 'workspaceId', 'name', 'nodes'], name);
      return instantiateFromSource(userId, 'TEMPLATE', args);
    }

    case 'instantiateWorkflowFromConfigured': {
      requireArgs(args, ['configuredWorkflowId', 'controllerId', 'workspaceId', 'name', 'nodes'], name);
      return instantiateFromSource(userId, 'CONFIGURED', args);
    }

    case 'instantiateWorkflowFromContent': {
      requireArgs(args, ['controllerId', 'workspaceId', 'name', 'nodes'], name);
      return instantiateFromSource(userId, 'BLANK', args);
    }

    // ---- 入参 schema 查询 ----
    case 'getWorkflowToolInputSchema': {
      const toolName = requireString(args, 'toolName');
      const schema = ADMIN_TOOL_SCHEMAS[toolName];
      if (!schema) {
        throw new AdminToolError(
          'INVALID_PARAMS',
          `未知工具「${toolName}」。管理工具集可用工具：${Object.keys(ADMIN_TOOL_SCHEMAS).join('、')}。`,
        );
      }
      return { toolName, inputSchema: schema };
    }

    default:
      throw new AdminToolError('UNKNOWN_TOOL', `未知工具「${name}」。可用工具：${Object.keys(ADMIN_TOOL_SCHEMAS).join('、')}。`);
  }
}

async function instantiateFromSource(
  userId: string,
  source: InstantiateSource,
  args: Record<string, unknown>,
) {
  const inst = await workflowInstanceService.instantiate(userId, {
    source,
    configuredWorkflowId: source === 'CONFIGURED' ? requireString(args, 'configuredWorkflowId') : null,
    templateId: source === 'TEMPLATE' ? requireString(args, 'templateId') : null,
    controllerId: requireString(args, 'controllerId'),
    workspaceId: requireString(args, 'workspaceId'),
    name: requireString(args, 'name'),
    nodes: args.nodes as never,
  });
  return { id: toId((inst as unknown as { _id: unknown })._id), name: (inst as unknown as { name: string }).name, nodes: (inst as unknown as { nodes: unknown }).nodes };
}

/**
 * admin 平台 MCP 服务请求处理（不经 Redis 转发，本地直接处理）。
 */
export async function handleAdminPlatformMcpRequest(
  caller: AdminCaller,
  request: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } },
): Promise<{ result?: unknown; error?: { code: string; message: string } }> {
  switch (request.method) {
    case 'initialize':
      return {
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: ADMIN_PLATFORM_SERVER_NAME, version: '1.0.0' },
        },
      };
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { result: {} };
    case 'ping':
      return { result: {} };
    case 'tools/list':
      return { result: { tools: getAdminToolDefinitions() } };
    case 'tools/call': {
      const toolName = request.params?.name;
      if (!toolName) {
        return { error: { code: 'INVALID_PARAMS', message: 'tools/call 缺少 params.name' } };
      }
      try {
        const output = await callAdminTool(caller, toolName, request.params?.arguments ?? {});
        return { result: { content: [{ type: 'text', text: JSON.stringify(output) }] } };
      } catch (err) {
        if (err instanceof AdminToolError) {
          return {
            result: {
              content: [{ type: 'text', text: JSON.stringify({ code: err.code, message: err.message }) }],
              isError: true,
            },
          };
        }
        return { error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) } };
      }
    }
    default:
      return { error: { code: 'METHOD_NOT_FOUND', message: `不支持的方法：${request.method}` } };
  }
}

/** 幂等 upsert admin 平台服务（transport/source: platform），返回其 _id */
export async function ensureAdminToolsServer(userId: string): Promise<string> {
  const { McpServer } = await import('../../models/mcp-server.js');
  const server = await McpServer.findOneAndUpdate(
    { userId, name: ADMIN_PLATFORM_SERVER_NAME },
    {
      $setOnInsert: {
        userId,
        name: ADMIN_PLATFORM_SERVER_NAME,
        transport: 'platform',
        source: 'platform',
        enabled: true,
        tools: getAdminToolDefinitions().map((t) => ({ name: t.name, description: t.description })),
      },
    },
    { upsert: true, new: true },
  );
  return server._id.toString();
}
