import { ConfiguredWorkflow } from '../../models/configured-workflow.js';
import { WorkflowTemplate } from '../../models/workflow-template.js';
import { Controller } from '../../models/controller.js';
import { getRedisClient } from '../../middleware/redis.js';
import { validateTemplateGraph, assertAiOwned, type WorkflowCreatedBy } from './template.js';

export interface AgentNodeConfigInput {
  acpServerType: string;
  modeId?: string | null;
  modelId?: string | null;
  initNewWorktree: boolean;
}

/** 已配置工作流节点入参（全量节点字段，与模板节点同构 + agentConfig） */
export interface ConfiguredWorkflowNodeInput {
  nodeKey: string;
  type?: 'HUMAN' | 'AI' | 'FLAG';
  name?: string;
  description?: string | null;
  stage?: string;
  prompts?: string[] | null;
  artifactTitles?: string[] | null;
  dependsOn?: string[];
  requiresWorktree?: boolean;
  agentConfig?: AgentNodeConfigInput | null;
}

export interface ConfigureWorkflowInput {
  name: string;
  controllerId: string;
  nodes: ConfiguredWorkflowNodeInput[];
}

export interface ConfiguredWorkflowCreationMeta {
  createdBy?: WorkflowCreatedBy;
  createdBySessionId?: string | null;
}

/** 模板/已配置工作流节点的最小结构（供纯函数使用，兼容 lean 文档） */
interface SourceNodeLike {
  nodeKey: string;
  type: string;
  name: string;
  description?: string | null;
  stage: string;
  prompts?: string[] | null;
  artifactTitles?: string[] | null;
  dependsOn?: string[] | null;
  requiresWorktree: boolean;
}

interface TemplateLike {
  _id?: { toString(): string } | string;
  version?: number;
  nodes: SourceNodeLike[];
}

/**
 * 从模板生成快照副本（纯函数）：深拷贝 nodes，按 nodeKey 合入 agentConfig，
 * 记录 sourceTemplateId / sourceTemplateVersion（仅展示用，无强关联）。
 */
export function copyFromTemplate(template: TemplateLike, input: ConfigureWorkflowInput) {
  const configByKey = new Map(input.nodes.map((n) => [n.nodeKey, n.agentConfig ?? null]));
  return {
    name: input.name,
    controllerId: input.controllerId,
    sourceTemplateId: template._id?.toString(),
    sourceTemplateVersion: template.version,
    nodes: template.nodes.map((node) => ({
      nodeKey: node.nodeKey,
      type: node.type,
      name: node.name,
      description: node.description ?? null,
      stage: node.stage,
      prompts: node.prompts ? [...node.prompts] : null,
      artifactTitles: node.artifactTitles ? [...node.artifactTitles] : null,
      dependsOn: [...(node.dependsOn ?? [])],
      requiresWorktree: node.requiresWorktree,
      agentConfig: configByKey.get(node.nodeKey) ? { ...configByKey.get(node.nodeKey)! } : null,
    })),
  };
}

/**
 * 校验配置/实例化输入中的 Agent 配置（纯函数）：
 * 遍历节点图，所有 AI 节点必须有完整 agentConfig（acpServerType），
 * 且 acpServerType 必须在控制器 capabilities 可用列表内（modeId/modelId 允许为空）。
 */
export function validateAgentConfigs(
  nodes: SourceNodeLike[],
  availableServerTypes: string[],
): void {
  for (const node of nodes) {
    if (node.type !== 'AI') continue;
    const config = (node as { agentConfig?: AgentNodeConfigInput | null }).agentConfig;
    if (!config || !config.acpServerType) {
      throw new Error(`AI 节点「${node.name}」（${node.nodeKey}）缺少 Agent 配置（agentConfig.acpServerType）`);
    }
    if (!availableServerTypes.includes(config.acpServerType)) {
      throw new Error(
        `AI 节点「${node.name}」（${node.nodeKey}）的 acpServerType「${config.acpServerType}」` +
          `不在该控制器可用列表内：${availableServerTypes.join('、') || '（空）'}`,
      );
    }
  }
}

class ConfiguredWorkflowService {
  async listForUser(userId: string, controllerId?: string) {
    const filter: Record<string, unknown> = { userId };
    if (controllerId) filter.controllerId = controllerId;
    return ConfiguredWorkflow.find(filter).sort({ createdAt: -1 }).lean();
  }

  async findById(id: string, userId: string) {
    return ConfiguredWorkflow.findOne({ _id: id, userId }).lean();
  }

  /** 从模板复制生成已配置工作流（快照副本） */
  async configure(userId: string, templateId: string, input: ConfigureWorkflowInput, meta?: ConfiguredWorkflowCreationMeta) {
    const template = await WorkflowTemplate.findOne({
      _id: templateId,
      $or: [{ userId }, { isBuiltin: true }],
    }).lean();
    if (!template) {
      throw new Error('工作流模板不存在或无权限');
    }
    const availableServerTypes = await this.getAvailableServerTypes(input.controllerId, userId);
    const snapshot = copyFromTemplate(template, input);
    // 校验模板节点图的 agentConfig 完整性 + capabilities
    validateAgentConfigs(snapshot.nodes as unknown as SourceNodeLike[], availableServerTypes);
    return ConfiguredWorkflow.create({
      userId,
      controllerId: input.controllerId,
      name: snapshot.name,
      sourceTemplateId: template._id,
      sourceTemplateVersion: snapshot.sourceTemplateVersion,
      nodes: snapshot.nodes,
      createdBy: meta?.createdBy ?? 'HUMAN',
      createdBySessionId: meta?.createdBySessionId ?? undefined,
    });
  }

  /** 更新已配置工作流：接受全量节点图（完整图校验），nodeKey 集合可变；实例保有自身快照不受影响 */
  async update(userId: string, id: string, input: ConfigureWorkflowInput, meta?: ConfiguredWorkflowCreationMeta) {
    const workflow = await ConfiguredWorkflow.findOne({ _id: id, userId });
    if (!workflow) {
      throw new Error('已配置工作流不存在或无权限');
    }

    const availableServerTypes = await this.getAvailableServerTypes(input.controllerId, userId);
    const fullNodes = this.normalizeConfiguredNodes(input.nodes);
    // 完整图校验 + agentConfig 校验（与模板一致）
    validateTemplateGraph(fullNodes as never);
    validateAgentConfigs(fullNodes as unknown as SourceNodeLike[], availableServerTypes);

    workflow.name = input.name;
    workflow.controllerId = input.controllerId as never;
    workflow.nodes = fullNodes as never;
    if (meta?.createdBy) workflow.createdBy = meta.createdBy as never;
    if (meta?.createdBySessionId) workflow.createdBySessionId = meta.createdBySessionId as never;
    await workflow.save();
    return workflow;
  }

  /**
   * 删除已配置工作流。
   * 快照模型下实例自包含，删除配置不影响任何实例，不再校验活跃实例引用。
   */
  async delete(userId: string, id: string, opts?: { requireAiOwned?: boolean }): Promise<boolean> {
    const workflow = await ConfiguredWorkflow.findOne({ _id: id, userId });
    if (!workflow) {
      throw new Error('已配置工作流不存在或无权限');
    }
    if (opts?.requireAiOwned) {
      assertAiOwned(workflow as { createdBy?: string | null }, '已配置工作流');
    }
    await workflow.deleteOne();
    return true;
  }

  /** 将输入节点归一化为完整节点结构（补默认值，供图校验与落库） */
  private normalizeConfiguredNodes(nodes: ConfiguredWorkflowNodeInput[]) {
    return nodes.map((n) => ({
      nodeKey: n.nodeKey,
      type: n.type ?? 'AI',
      name: n.name ?? n.nodeKey,
      description: n.description ?? null,
      stage: n.stage ?? '默认阶段',
      prompts: n.prompts ? [...n.prompts] : undefined,
      artifactTitles: n.artifactTitles ? [...n.artifactTitles] : undefined,
      dependsOn: [...(n.dependsOn ?? [])],
      requiresWorktree: n.requiresWorktree ?? false,
      agentConfig: n.agentConfig ? { ...n.agentConfig } : null,
    }));
  }

  /** 校验 controller 归属并读取其 ACP capabilities（Redis `acp:capability:<controllerId>`） */
  private async getAvailableServerTypes(controllerId: string, userId: string): Promise<string[]> {
    const controller = await Controller.findOne({ _id: controllerId, userId }).lean();
    if (!controller) {
      throw new Error('控制器不存在或不属于当前用户');
    }
    const redis = getRedisClient();
    const cached = await redis.get(`acp:capability:${controllerId}`);
    if (!cached) {
      throw new Error(`控制器「${controller.name || controllerId}」的 Agent 能力信息不可用（可能离线），请确认控制器在线后重试`);
    }
    const parsed = JSON.parse(cached) as { servers?: { type: string; available: boolean }[] };
    return (parsed.servers ?? []).filter((s) => s.available).map((s) => s.type);
  }
}

export const configuredWorkflowService = new ConfiguredWorkflowService();
