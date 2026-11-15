import { ConfiguredWorkflow } from '../../models/configured-workflow.js';
import type { WorkflowInstanceDoc, WorkflowNodeDoc } from './engine.js';
import type { WorkflowNodeSessionBehavior } from '../../models/workflow-template.js';

/**
 * 实例节点配置解析（从 orchestrator 抽取，供 orchestrator 与中断重试调度器共用）。
 *
 * 循环依赖约束：调度器需要节点初始 mode/model，但不能 import orchestrator
 * （orchestrator 依赖引擎与重试核心）。本模块只依赖模型与引擎类型（类型导入）。
 */

/** 归一后的会话行为（HUMAN/FLAG 四字段恒 null） */
export interface NodeSessionBehavior {
  reworkSessionBehavior: WorkflowNodeSessionBehavior | null;
  reworkCompactOriginalContext: boolean | null;
  resumeSessionBehavior: WorkflowNodeSessionBehavior | null;
  resumeCompactOriginalContext: boolean | null;
}

/** 会话行为缺省值（= 现状）：返工继续原始会话、打回后新会话 */
export const DEFAULT_REWORK_SESSION_BEHAVIOR: WorkflowNodeSessionBehavior = 'ORIGINAL_SESSION';
export const DEFAULT_RESUME_SESSION_BEHAVIOR: WorkflowNodeSessionBehavior = 'NEW_SESSION';

/**
 * 会话行为唯一归一事实源（configured/instance 写入与 mapXxx/loadNodeConfig 读取共用）。
 *
 * 规则：
 * - HUMAN/FLAG：四字段恒 null（与 agentConfig 同纪律）；
 * - AI：行为缺省值见上；`compact=true` 仅在对应行为为 ORIGINAL_SESSION 时保留，
 *   行为为 NEW_SESSION 时强制归一为 false（不报错）。
 */
export function normalizeNodeSessionBehavior(node: {
  type?: string | null;
  reworkSessionBehavior?: string | null;
  reworkCompactOriginalContext?: boolean | null;
  resumeSessionBehavior?: string | null;
  resumeCompactOriginalContext?: boolean | null;
}): NodeSessionBehavior {
  if (node.type !== 'AI') {
    return {
      reworkSessionBehavior: null,
      reworkCompactOriginalContext: null,
      resumeSessionBehavior: null,
      resumeCompactOriginalContext: null,
    };
  }
  const reworkSessionBehavior: WorkflowNodeSessionBehavior =
    node.reworkSessionBehavior === 'NEW_SESSION' ? 'NEW_SESSION' : DEFAULT_REWORK_SESSION_BEHAVIOR;
  const resumeSessionBehavior: WorkflowNodeSessionBehavior =
    node.resumeSessionBehavior === 'ORIGINAL_SESSION' ? 'ORIGINAL_SESSION' : DEFAULT_RESUME_SESSION_BEHAVIOR;
  return {
    reworkSessionBehavior,
    reworkCompactOriginalContext:
      reworkSessionBehavior === 'ORIGINAL_SESSION' ? (node.reworkCompactOriginalContext ?? false) : false,
    resumeSessionBehavior,
    resumeCompactOriginalContext:
      resumeSessionBehavior === 'ORIGINAL_SESSION' ? (node.resumeCompactOriginalContext ?? false) : false,
  };
}

export interface ConfiguredNodeLike {
  nodeKey: string;
  type?: string | null;
  prompts?: string[] | null;
  requiresWorktree: boolean;
  agentConfig?: {
    acpServerType: string;
    modeId?: string | null;
    modelId?: string | null;
    initNewWorktree: boolean;
  } | null;
  reworkSessionBehavior?: WorkflowNodeSessionBehavior | null;
  reworkCompactOriginalContext?: boolean | null;
  resumeSessionBehavior?: WorkflowNodeSessionBehavior | null;
  resumeCompactOriginalContext?: boolean | null;
}

/** 附加归一后的会话行为（快照/回查两路共用） */
function withSessionBehavior<T extends { nodeKey: string; requiresWorktree: boolean }>(
  node: T & Parameters<typeof normalizeNodeSessionBehavior>[0],
): T & NodeSessionBehavior {
  return { ...node, ...normalizeNodeSessionBehavior(node) };
}

/**
 * 读取节点配置：优先使用实例节点快照（prompts/agentConfig/requiresWorktree）；
 * 快照字段缺失（一期旧实例）时回退 loadConfiguredNode 按 nodeKey 回查配置。
 * 两路返回值均附加归一后的会话行为。
 */
export async function loadNodeConfig(
  instance: WorkflowInstanceDoc,
  node: WorkflowNodeDoc,
): Promise<ConfiguredNodeLike> {
  const nodeWithSnapshot = node as unknown as {
    type?: string | null;
    prompts?: string[] | null;
    requiresWorktree?: boolean;
    agentConfig?: ConfiguredNodeLike['agentConfig'];
    reworkSessionBehavior?: string | null;
    reworkCompactOriginalContext?: boolean | null;
    resumeSessionBehavior?: string | null;
    resumeCompactOriginalContext?: boolean | null;
  };
  if (nodeWithSnapshot.prompts !== undefined || nodeWithSnapshot.agentConfig !== undefined) {
    return withSessionBehavior({
      nodeKey: node.nodeKey,
      type: nodeWithSnapshot.type ?? node.type,
      prompts: nodeWithSnapshot.prompts ?? null,
      requiresWorktree: nodeWithSnapshot.requiresWorktree ?? false,
      agentConfig: nodeWithSnapshot.agentConfig ?? null,
      reworkSessionBehavior: nodeWithSnapshot.reworkSessionBehavior,
      reworkCompactOriginalContext: nodeWithSnapshot.reworkCompactOriginalContext,
      resumeSessionBehavior: nodeWithSnapshot.resumeSessionBehavior,
      resumeCompactOriginalContext: nodeWithSnapshot.resumeCompactOriginalContext,
    });
  }
  return loadConfiguredNode(instance, node);
}

export async function loadConfiguredNode(
  instance: WorkflowInstanceDoc,
  node: WorkflowNodeDoc,
): Promise<ConfiguredNodeLike> {
  const configured = await ConfiguredWorkflow.findById(instance.configuredWorkflowId.toString()).lean();
  if (!configured) {
    throw new Error(`实例引用的已配置工作流不存在：${instance.configuredWorkflowId.toString()}`);
  }
  const configuredNode = (configured.nodes as ConfiguredNodeLike[]).find((n) => n.nodeKey === node.nodeKey);
  if (!configuredNode) {
    throw new Error(`已配置工作流中不存在节点「${node.name}」（${node.nodeKey}）`);
  }
  return withSessionBehavior({ ...configuredNode, type: configuredNode.type ?? node.type });
}

/** 提取节点配置的初始 mode/model（随 acp:start/acp:resume 带内下发）；无配置返回 undefined */
export function initialModeModel(
  agentConfig?: ConfiguredNodeLike['agentConfig'],
): { modeId?: string; modelId?: string } | undefined {
  if (!agentConfig || (!agentConfig.modeId && !agentConfig.modelId)) return undefined;
  return {
    ...(agentConfig.modeId ? { modeId: agentConfig.modeId } : {}),
    ...(agentConfig.modelId ? { modelId: agentConfig.modelId } : {}),
  };
}
