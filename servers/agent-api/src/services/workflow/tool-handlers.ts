import { WorkflowInstance } from '../../models/workflow-instance.js';
import { workflowEngine, type TransitionPayload, type WorkflowInstanceDoc, type WorkflowNodeDoc } from './engine.js';
import { getArtifactKeys, getValue, listKeys, removeKey } from './blackboard.js';
import { prHandlerRegistry, normalizePullRequestId, PullRequestIdError } from './pr-handler-registry.js';
import { syncNodeStatus } from './pr-check-run-sync.js';
import { getWorkspaceContext } from '../workspace-context.js';

/** 平台内置工作流工具服务名（transport: platform / source: platform） */
export const PLATFORM_SERVER_NAME = 'agent-workflow-tools';

/** 工具错误：code + 面向 LLM 可读的中文 message */
export class WorkflowToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowToolError';
  }
}

/** 节点作用域（从 scoped token 的 workflow payload 解析） */
export interface WorkflowToolScope {
  instanceId: string;
  nodeId: string;
  userId: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const ARTIFACTS_PARAM = {
  artifacts: {
    type: 'array',
    items: {
      type: 'object',
      properties: { title: { type: 'string' }, value: { type: 'string' } },
      required: ['title', 'value'],
    },
    description: '产物列表，写入工作流黑板（key 为 {节点ID}-{节点名称}-产物-{title}）',
  },
} as const;

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'getCurrentNodeId',
    description: '获得当前节点 ID（节点作用域映射）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'getParentNodeIds',
    description: '获得当前节点的父节点（上游）ID 列表',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'getNodeInfo',
    description: '按节点 ID 获得节点信息（默认当前节点）',
    inputSchema: {
      type: 'object',
      properties: { nodeId: { type: 'string', description: '节点 ID，缺省为当前节点' } },
    },
  },
  {
    name: 'getNodeArtifactKeys',
    description: '获得某节点的所有产物黑板 keys（前缀匹配 {节点ID}-{节点名称}-产物，默认当前节点）',
    inputSchema: {
      type: 'object',
      properties: { nodeId: { type: 'string', description: '节点 ID，缺省为当前节点' } },
    },
  },
  {
    name: 'getBlackboardKeys',
    description: '获得工作流黑板 keys（可用 prefix 过滤）',
    inputSchema: {
      type: 'object',
      properties: { prefix: { type: 'string', description: 'key 前缀过滤' } },
    },
  },
  {
    name: 'getBlackboardValue',
    description: '按 key 读取工作流黑板 value',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'removeBlackboardKey',
    description: '移除一个工作流黑板 key（被移除的信息挪入黑板垃圾桶）',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'completeCurrentNode',
    description: '操作当前节点「节点完成」（RUNNING→DONE），产物写入黑板并触发下游节点开始',
    inputSchema: { type: 'object', properties: { ...ARTIFACTS_PARAM } },
  },
  {
    name: 'rejectCurrentNode',
    description: '操作当前节点「节点打回」（RUNNING/REWORK→REJECT），必须给出打回原因；targetNodeId 可限定返工的直接上游（默认全部直接上游）',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '打回原因（必填）' },
        targetNodeId: { type: 'string', description: '限定返工的上游节点 ID（必须是当前节点的直接上游）' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'completeCurrentRework',
    description: '操作当前节点「节点返工完成」（REWORK→DONE），重置产物并通知下游复工',
    inputSchema: { type: 'object', properties: { ...ARTIFACTS_PARAM } },
  },
  {
    name: 'failCurrentNode',
    description:
      '操作当前节点「标记失败」（RUNNING→FAILED）。当你判断任务无法继续（缺少关键信息、环境不可用、需要人类决策）时调用；' +
      '失败后工作流阻断并提醒人类介入。人类在对话中给出明确指示后，调用 resumeFailedNode 恢复运行',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '失败原因（必填），面向人类可读，说明为何无法继续' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'resumeFailedNode',
    description:
      '操作当前节点「恢复运行」（FAILED→RUNNING）。仅在人类已在对话中给出明确处理指示后调用',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'linkPullRequest',
    description:
      '将 GitHub Pull Request 关联到当前工作流实例与当前节点（注册 PR 联动处理器）。工作流完成/归档后自动解除。同一节点重复关联以最后一次为准。只需传 pullRequestId（形如 owner/repo#123 或 PR 链接）。',
    inputSchema: {
      type: 'object',
      properties: {
        pullRequestId: {
          type: 'string',
          description: 'Pull Request 标识：owner/repo#编号 或完整 PR 链接（必填）',
        },
        workflowId: {
          type: 'string',
          description: '可选；缺省为当前会话的工作流实例 ID，提供时必须一致',
        },
        nodeId: {
          type: 'string',
          description: '可选；缺省为当前节点 ID，提供时必须一致',
        },
      },
      required: ['pullRequestId'],
    },
  },
];

export function getWorkflowToolDefinitions(): ToolDefinition[] {
  return TOOL_DEFINITIONS;
}

/** 加载实例并校验 token 作用域（实例归属 + 节点存在） */
async function loadScopeContext(
  scope: WorkflowToolScope | undefined,
): Promise<{ instance: WorkflowInstanceDoc; node: WorkflowNodeDoc }> {
  if (!scope) {
    throw new WorkflowToolError(
      'UNAUTHORIZED',
      '当前会话不是工作流节点会话（token 无 workflow 作用域），无法使用工作流工具',
    );
  }
  const instance = (await WorkflowInstance.findById(scope.instanceId)) as unknown as WorkflowInstanceDoc | null;
  if (!instance) {
    throw new WorkflowToolError('NOT_FOUND', `工作流实例不存在或无权限：${scope.instanceId}`);
  }
  // 多租户二期（F11）：归属校验以「实例所属租户工作区 = 会话工作区」为准；
  // 无请求上下文（引擎/内部）时退回创建者校验。
  const workspaceContext = getWorkspaceContext();
  if (workspaceContext) {
    if (instance.resourceWorkspaceId && instance.resourceWorkspaceId.toString() !== workspaceContext.id) {
      throw new WorkflowToolError('NOT_FOUND', `工作流实例不存在或无权限：${scope.instanceId}`);
    }
  } else if (instance.userId.toString() !== scope.userId) {
    throw new WorkflowToolError('NOT_FOUND', `工作流实例不存在或无权限：${scope.instanceId}`);
  }
  const node = instance.nodes.find((n) => n.nodeId === scope.nodeId);
  if (!node) {
    throw new WorkflowToolError('NODE_NOT_FOUND', `当前会话绑定的节点 ${scope.nodeId} 不在实例中`);
  }
  return { instance, node };
}

function findNode(instance: WorkflowInstanceDoc, nodeId: string): WorkflowNodeDoc {
  const node = instance.nodes.find((n) => n.nodeId === nodeId);
  if (!node) {
    throw new WorkflowToolError('NODE_NOT_FOUND', `实例中不存在节点：${nodeId}`);
  }
  return node;
}

function requireString(args: Record<string, unknown>, field: string, hint: string): string {
  const value = args[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkflowToolError('INVALID_PARAMS', `参数 ${field} 必填且为非空字符串。${hint}`);
  }
  return value;
}

function parseArtifacts(args: Record<string, unknown>, required: boolean): { title: string; value: string }[] {
  const raw = args.artifacts;
  if (raw === undefined || raw === null) {
    if (required) {
      throw new WorkflowToolError(
        'INVALID_PARAMS',
        '参数 artifacts 必填：产物列表 [{title, value}]。请将你的工作成果作为产物提交。',
      );
    }
    return [];
  }
  if (!Array.isArray(raw) || (required && raw.length === 0)) {
    throw new WorkflowToolError('INVALID_PARAMS', '参数 artifacts 必须为数组：[{title, value}]。');
  }
  for (const item of raw) {
    if (
      typeof item !== 'object' || item === null ||
      typeof (item as Record<string, unknown>).title !== 'string' ||
      typeof (item as Record<string, unknown>).value !== 'string'
    ) {
      throw new WorkflowToolError('INVALID_PARAMS', 'artifacts 的每一项必须包含字符串字段 title 与 value。');
    }
  }
  return raw as { title: string; value: string }[];
}

/** 引擎错误统一包装为 INVALID_STATE（保留可读 message） */
async function transition(
  scope: WorkflowToolScope,
  event: 'complete' | 'reject' | 'completeRework' | 'fail' | 'resumeFailed',
  payload: TransitionPayload,
): Promise<unknown> {
  try {
    const node = await workflowEngine.transition(scope.instanceId, scope.nodeId, event, payload);
    return { nodeId: node.nodeId, status: node.status };
  } catch (err) {
    throw new WorkflowToolError('INVALID_STATE', err instanceof Error ? err.message : String(err));
  }
}

function mapNodeInfo(node: WorkflowNodeDoc, instanceId?: string): Record<string, unknown> {
  return {
    nodeId: node.nodeId,
    // 供 AI 在需要显式传参时自查所属工作流实例
    workflowInstanceId: instanceId ?? null,
    nodeKey: node.nodeKey,
    type: node.type,
    name: node.name,
    description: node.description ?? null,
    stage: node.stage,
    status: node.status,
    sessionId: node.sessionId ? node.sessionId.toString() : null,
    createdAt: node.createdAt ?? null,
    startedAt: node.startedAt ?? null,
    reworkedAt: node.reworkedAt ?? null,
    reworkCount: node.reworkCount ?? 0,
    rejectInfo: node.rejectInfo ?? null,
    failInfo: node.failInfo ?? null,
  };
}

/** 工作流工具统一入口：参数校验 + 作用域校验 + 状态转移校验 */
export async function callWorkflowTool(
  scope: WorkflowToolScope | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { instance, node } = await loadScopeContext(scope);
  const toolScope = scope!;

  switch (name) {
    case 'getCurrentNodeId':
      return { nodeId: node.nodeId };

    case 'getParentNodeIds':
      return { parentNodeIds: [...(node.dependsOn ?? [])] };

    case 'getNodeInfo': {
      const target = typeof args.nodeId === 'string' && args.nodeId ? findNode(instance, args.nodeId) : node;
      return mapNodeInfo(target, instance._id.toString());
    }

    case 'getNodeArtifactKeys': {
      const target = typeof args.nodeId === 'string' && args.nodeId ? findNode(instance, args.nodeId) : node;
      return { keys: getArtifactKeys(instance, target.nodeId, target.name) };
    }

    case 'getBlackboardKeys': {
      const keys = listKeys(instance);
      const prefix = typeof args.prefix === 'string' && args.prefix ? args.prefix : null;
      return { keys: prefix ? keys.filter((k) => k.startsWith(prefix)) : keys };
    }

    case 'getBlackboardValue': {
      const key = requireString(args, 'key', '可用 getBlackboardKeys 查看全部 keys。');
      const value = getValue(instance, key);
      if (value === null) {
        throw new WorkflowToolError('KEY_NOT_FOUND', `黑板中不存在 key「${key}」，可用 getBlackboardKeys 查看全部 keys。`);
      }
      return { key, value };
    }

    case 'removeBlackboardKey': {
      const key = requireString(args, 'key', '可用 getBlackboardKeys 查看全部 keys。');
      try {
        await removeKey(instance, key);
      } catch (err) {
        throw new WorkflowToolError('KEY_NOT_FOUND', err instanceof Error ? err.message : String(err));
      }
      return { removed: true, key };
    }

    case 'completeCurrentNode': {
      const artifacts = parseArtifacts(args, false);
      return transition(toolScope, 'complete', { artifacts });
    }

    case 'rejectCurrentNode': {
      const reason = requireString(args, 'reason', '打回必须给出明确原因，供上游节点返工参考。');
      let targetNodeIds: string[] | undefined;
      if (typeof args.targetNodeId === 'string' && args.targetNodeId) {
        if (!(node.dependsOn ?? []).includes(args.targetNodeId)) {
          throw new WorkflowToolError(
            'INVALID_PARAMS',
            `targetNodeId「${args.targetNodeId}」不是当前节点的直接上游（可选：${(node.dependsOn ?? []).join('、') || '无'}）。`,
          );
        }
        targetNodeIds = [args.targetNodeId];
      }
      return transition(toolScope, 'reject', { reason, fromNodeId: node.nodeId, targetNodeIds });
    }

    case 'completeCurrentRework': {
      const artifacts = parseArtifacts(args, false);
      return transition(toolScope, 'completeRework', { artifacts });
    }

    case 'failCurrentNode': {
      const reason = requireString(args, 'reason', '标记失败必须给出人类可读的失败原因，供人工介入参考。');
      return transition(toolScope, 'fail', { reason, source: 'LLM_REPORTED' });
    }

    case 'resumeFailedNode': {
      return transition(toolScope, 'resumeFailed', {});
    }

    case 'linkPullRequest': {
      const rawPullRequestId = requireString(
        args,
        'pullRequestId',
        '请传入 Pull Request 标识（owner/repo#编号 或完整 PR 链接）。',
      );
      // 可选显式参数必须与 token 作用域一致
      if (typeof args.workflowId === 'string' && args.workflowId && args.workflowId !== toolScope.instanceId) {
        throw new WorkflowToolError(
          'INVALID_PARAMS',
          `workflowId「${args.workflowId}」与当前会话所属工作流实例「${toolScope.instanceId}」不一致`,
        );
      }
      if (typeof args.nodeId === 'string' && args.nodeId && args.nodeId !== toolScope.nodeId) {
        throw new WorkflowToolError(
          'INVALID_PARAMS',
          `nodeId「${args.nodeId}」与当前会话所属节点「${toolScope.nodeId}」不一致`,
        );
      }
      if (instance.deletedAt) {
        throw new WorkflowToolError('INVALID_STATE', '工作流实例已删除，无法关联 Pull Request');
      }
      if (instance.archivedAt) {
        throw new WorkflowToolError('INVALID_STATE', '工作流实例已归档，无法关联 Pull Request');
      }
      if (instance.finishedAt) {
        throw new WorkflowToolError('INVALID_STATE', '工作流已完成，无法关联 Pull Request');
      }
      let normalized: { pullRequestId: string; prUrl: string };
      try {
        normalized = normalizePullRequestId(rawPullRequestId);
      } catch (err) {
        if (err instanceof PullRequestIdError) {
          throw new WorkflowToolError('INVALID_PARAMS', err.message);
        }
        throw err;
      }
      const handler = await prHandlerRegistry.register({
        userId: toolScope.userId,
        workflowInstanceId: toolScope.instanceId,
        nodeId: node.nodeId,
        nodeKey: node.nodeKey,
        pullRequestId: normalized.pullRequestId,
        prUrl: normalized.prUrl,
        sessionId: node.sessionId ? node.sessionId.toString() : null,
      });
      // 绑定即同步：fire-and-forget，失败只记 lastSyncError，不影响工具返回
      void syncNodeStatus(instance, node).catch((err: unknown) => {
        console.warn('[workflow] first check-run sync failed:', (err as Error)?.message);
      });
      return {
        registered: true,
        pullRequestId: handler.pullRequestId,
        prUrl: handler.prUrl ?? normalized.prUrl,
        workflowInstanceId: toolScope.instanceId,
        nodeId: node.nodeId,
      };
    }

    default:
      throw new WorkflowToolError(
        'UNKNOWN_TOOL',
        `未知工具「${name}」。可用工具：${TOOL_DEFINITIONS.map((t) => t.name).join('、')}。`,
      );
  }
}

/** MCP 请求级调用方上下文（来自 scoped token payload） */
export interface McpCaller {
  userId?: string;
  workflow?: { instanceId: string; nodeId: string };
}

interface JsonRpcRequest {
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

/**
 * 平台 MCP 服务请求处理（不经 Redis 转发，本地直接处理）。
 * 工具级错误以 MCP 约定返回 isError 结果（LLM 可读），协议级错误返回 error。
 */
export async function handlePlatformMcpRequest(
  caller: McpCaller,
  request: JsonRpcRequest,
): Promise<{ result?: unknown; error?: { code: string; message: string } }> {
  switch (request.method) {
    case 'initialize':
      return {
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: PLATFORM_SERVER_NAME, version: '1.0.0' },
        },
      };
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { result: {} };
    case 'ping':
      return { result: {} };
    case 'tools/list':
      return { result: { tools: getWorkflowToolDefinitions() } };
    case 'tools/call': {
      const toolName = request.params?.name;
      if (!toolName) {
        return { error: { code: 'INVALID_PARAMS', message: 'tools/call 缺少 params.name' } };
      }
      const scope: WorkflowToolScope | undefined = caller.workflow
        ? { instanceId: caller.workflow.instanceId, nodeId: caller.workflow.nodeId, userId: caller.userId ?? '' }
        : undefined;
      try {
        const output = await callWorkflowTool(scope, toolName, request.params?.arguments ?? {});
        return { result: { content: [{ type: 'text', text: JSON.stringify(output) }] } };
      } catch (err) {
        if (err instanceof WorkflowToolError) {
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
