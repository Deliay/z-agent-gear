import { ConfiguredWorkflow } from '../../models/configured-workflow.js';
import type { WorkflowInstanceDoc, WorkflowNodeDoc } from './engine.js';

/**
 * 实例节点配置解析（从 orchestrator 抽取，供 orchestrator 与中断重试调度器共用）。
 *
 * 循环依赖约束：调度器需要节点初始 mode/model，但不能 import orchestrator
 * （orchestrator 依赖引擎与重试核心）。本模块只依赖模型与引擎类型（类型导入）。
 */

export interface ConfiguredNodeLike {
  nodeKey: string;
  prompts?: string[] | null;
  requiresWorktree: boolean;
  agentConfig?: {
    acpServerType: string;
    modeId?: string | null;
    modelId?: string | null;
    initNewWorktree: boolean;
  } | null;
}

/**
 * 读取节点配置：优先使用实例节点快照（prompts/agentConfig/requiresWorktree）；
 * 快照字段缺失（一期旧实例）时回退 loadConfiguredNode 按 nodeKey 回查配置。
 */
export async function loadNodeConfig(
  instance: WorkflowInstanceDoc,
  node: WorkflowNodeDoc,
): Promise<ConfiguredNodeLike> {
  const nodeWithSnapshot = node as unknown as {
    prompts?: string[] | null;
    requiresWorktree?: boolean;
    agentConfig?: ConfiguredNodeLike['agentConfig'];
  };
  if (nodeWithSnapshot.prompts !== undefined || nodeWithSnapshot.agentConfig !== undefined) {
    return {
      nodeKey: node.nodeKey,
      prompts: nodeWithSnapshot.prompts ?? null,
      requiresWorktree: nodeWithSnapshot.requiresWorktree ?? false,
      agentConfig: nodeWithSnapshot.agentConfig ?? null,
    };
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
  return configuredNode;
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
