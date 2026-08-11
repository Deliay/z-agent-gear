import { ConfiguredWorkflow } from '../../models/configured-workflow.js';
import { WorkflowTemplate } from '../../models/workflow-template.js';
import { WorkflowInstance } from '../../models/workflow-instance.js';
import { Controller } from '../../models/controller.js';
import { getRedisClient } from '../../middleware/redis.js';

export interface AgentNodeConfigInput {
  acpServerType: string;
  modeId?: string | null;
  modelId?: string | null;
  initNewWorktree: boolean;
}

export interface ConfiguredWorkflowNodeInput {
  nodeKey: string;
  agentConfig?: AgentNodeConfigInput | null;
}

export interface ConfigureWorkflowInput {
  name: string;
  controllerId: string;
  nodes: ConfiguredWorkflowNodeInput[];
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
 * 校验配置输入与模板快照节点的一致性（纯函数）：
 * - nodeKey 集合必须与模板/现有快照一致（不允许增删节点）
 * - 所有 AI 节点必须有完整 agentConfig
 * - acpServerType 必须在控制器 capabilities 可用列表内（modeId/modelId 允许为空）
 */
export function validateAgentConfigs(
  sourceNodes: SourceNodeLike[],
  inputNodes: ConfiguredWorkflowNodeInput[],
  availableServerTypes: string[],
): void {
  const sourceKeys = new Set(sourceNodes.map((n) => n.nodeKey));
  const inputKeys = new Set(inputNodes.map((n) => n.nodeKey));

  for (const node of sourceNodes) {
    if (!inputKeys.has(node.nodeKey)) {
      throw new Error(`配置缺少节点「${node.name}」（${node.nodeKey}），不允许增删节点`);
    }
  }
  for (const node of inputNodes) {
    if (!sourceKeys.has(node.nodeKey)) {
      throw new Error(`配置包含模板中不存在的节点「${node.nodeKey}」，不允许增删节点`);
    }
  }

  const configByKey = new Map(inputNodes.map((n) => [n.nodeKey, n.agentConfig ?? null]));
  for (const node of sourceNodes) {
    if (node.type !== 'AI') continue;
    const config = configByKey.get(node.nodeKey);
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
  async configure(userId: string, templateId: string, input: ConfigureWorkflowInput) {
    const template = await WorkflowTemplate.findOne({
      _id: templateId,
      $or: [{ userId }, { isBuiltin: true }],
    }).lean();
    if (!template) {
      throw new Error('工作流模板不存在或无权限');
    }
    const availableServerTypes = await this.getAvailableServerTypes(input.controllerId, userId);
    validateAgentConfigs(template.nodes, input.nodes, availableServerTypes);
    const snapshot = copyFromTemplate(template, input);
    return ConfiguredWorkflow.create({
      userId,
      controllerId: input.controllerId,
      name: snapshot.name,
      sourceTemplateId: template._id,
      sourceTemplateVersion: snapshot.sourceTemplateVersion,
      nodes: snapshot.nodes,
    });
  }

  /** 更新已配置工作流：仅允许修改 name/controllerId/agentConfig，不允许增删节点 */
  async update(userId: string, id: string, input: ConfigureWorkflowInput) {
    const workflow = await ConfiguredWorkflow.findOne({ _id: id, userId });
    if (!workflow) {
      throw new Error('已配置工作流不存在或无权限');
    }

    const existingKeys = workflow.nodes.map((n) => n.nodeKey).sort();
    const inputKeys = input.nodes.map((n) => n.nodeKey).sort();
    const sameKeys =
      existingKeys.length === inputKeys.length && existingKeys.every((key, i) => key === inputKeys[i]);
    if (!sameKeys) {
      throw new Error('不允许增删节点（nodeKey 集合必须与现有配置一致），如需改图请重新从模板复制');
    }

    const availableServerTypes = await this.getAvailableServerTypes(input.controllerId, userId);
    validateAgentConfigs(workflow.nodes, input.nodes, availableServerTypes);

    workflow.name = input.name;
    workflow.controllerId = input.controllerId as never;
    const configByKey = new Map(input.nodes.map((n) => [n.nodeKey, n.agentConfig ?? null]));
    for (const node of workflow.nodes) {
      const config = configByKey.get(node.nodeKey);
      (node as { agentConfig?: unknown }).agentConfig = config ? { ...config } : null;
    }
    await workflow.save();
    return workflow;
  }

  /**
   * 删除已配置工作流。
   * 删除约束：存在未终结实例（引用该配置且仍有节点非 DONE 终态）时拒绝删除。
   */
  async delete(userId: string, id: string): Promise<boolean> {
    const workflow = await ConfiguredWorkflow.findOne({ _id: id, userId });
    if (!workflow) {
      throw new Error('已配置工作流不存在或无权限');
    }
    // 注意：数组字段上 'nodes.status': { $ne } 的语义是「没有任何节点为该状态」，
    // 无法表达「存在未终结节点」；必须用 $elemMatch 匹配任一非终结态节点。
    const activeInstance = await WorkflowInstance.exists({
      configuredWorkflowId: id,
      nodes: { $elemMatch: { status: { $nin: ['DONE', 'REJECT'] } } },
    });
    if (activeInstance) {
      throw new Error('存在未终结的工作流实例引用该配置，无法删除；请先等待实例全部节点终结');
    }
    await workflow.deleteOne();
    return true;
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
