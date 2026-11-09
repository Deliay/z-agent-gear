import { ConfiguredWorkflow } from '../../models/configured-workflow.js';
import { actorFilter, actorOrBuiltinFilter, getWorkspaceContext } from '../workspace-context.js';
import { WorkflowTemplate } from '../../models/workflow-template.js';
import { Controller } from '../../models/controller.js';
import { controllerWorkspaceService } from '../controller-workspace.js';
import { validateTemplateGraph, assertAiOwned, type WorkflowCreatedBy } from './template.js';
import { getAvailableServerTypes } from './capability.js';

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
  /** 人类节点：是否联动上游 Pull Request */
  linkUpstreamPullRequest?: boolean;
  agentConfig?: AgentNodeConfigInput | null;
  sortOrder?: number | null;
}

export interface ConfigureWorkflowInput {
  name: string;
  controllerId: string;
  nodes: ConfiguredWorkflowNodeInput[];
}

/** 从项目（仓库）模板配置工作流入参 */
export interface ConfigureRepoWorkflowInput {
  workspaceId: string;
  fileName: string;
  name: string;
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
  linkUpstreamPullRequest?: boolean | null;
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
  const inputByKey = new Map(input.nodes.map((n) => [n.nodeKey, n]));
  return {
    name: input.name,
    controllerId: input.controllerId,
    sourceTemplateId: template._id?.toString(),
    sourceTemplateVersion: template.version,
    nodes: template.nodes.map((node) => {
      const override = inputByKey.get(node.nodeKey);
      return {
        nodeKey: node.nodeKey,
        type: node.type,
        name: node.name,
        description: node.description ?? null,
        stage: node.stage,
        prompts: node.prompts ? [...node.prompts] : null,
        artifactTitles: node.artifactTitles ? [...node.artifactTitles] : null,
        dependsOn: [...(node.dependsOn ?? [])],
        requiresWorktree: node.requiresWorktree,
        // 仅 HUMAN 可联动；input 同 nodeKey 覆盖模板值，缺省回落模板值
        linkUpstreamPullRequest:
          node.type === 'HUMAN'
            ? (override?.linkUpstreamPullRequest ?? node.linkUpstreamPullRequest ?? false)
            : false,
        agentConfig: configByKey.get(node.nodeKey) ? { ...configByKey.get(node.nodeKey)! } : null,
      };
    }),
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

const REPO_TEMPLATE_SOURCE_PREFIX = '.zag/workflow/templates/';
const WORKFLOW_NAME_MAX_LENGTH = 64;

/**
 * 项目模板文件名归一校验（纯文件名，防路径穿越）：
 * trim 后非空、以 `.json` 结尾、不含分隔符 / `..` / NUL。
 */
export function normalizeRepoFileName(raw: string): string {
  const fileName = typeof raw === 'string' ? raw.trim() : '';
  if (
    !fileName ||
    !fileName.endsWith('.json') ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('..') ||
    fileName.includes('\0')
  ) {
    throw new Error('invalid template file name');
  }
  return fileName;
}

/** 工作流名称归一（与实例改名同口径：trim 后 1~64） */
function normalizeWorkflowName(raw: string): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name || name.length > WORKFLOW_NAME_MAX_LENGTH) {
    throw new Error('invalid workflow name');
  }
  return name;
}

class ConfiguredWorkflowService {
  async listForUser(userId: string, controllerId?: string) {
    const filter: Record<string, unknown> = { ...actorFilter(userId) };
    if (controllerId) filter.controllerId = controllerId;
    return ConfiguredWorkflow.find(filter).sort({ createdAt: -1 }).lean();
  }

  async findById(id: string, userId: string) {
    return ConfiguredWorkflow.findOne({ _id: id, ...actorFilter(userId) }).lean();
  }

  /** 从模板复制生成已配置工作流（快照副本） */
  async configure(userId: string, templateId: string, input: ConfigureWorkflowInput, meta?: ConfiguredWorkflowCreationMeta) {    const template = await WorkflowTemplate.findOne({
      _id: templateId,
      ...actorOrBuiltinFilter(userId),
    }).lean();
    if (!template) {
      throw new Error('工作流模板不存在或无权限');
    }
    const availableServerTypes = await getAvailableServerTypes(input.controllerId, userId);
    const snapshot = copyFromTemplate(template, input);
    // 校验模板节点图的 agentConfig 完整性 + capabilities
    validateAgentConfigs(snapshot.nodes as unknown as SourceNodeLike[], availableServerTypes);
    const workspaceFields = this.currentWorkspaceFields();
    return ConfiguredWorkflow.create({
      userId,
      ...workspaceFields,
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
    const workflow = await ConfiguredWorkflow.findOne({ _id: id, ...actorFilter(userId) });
    if (!workflow) {
      throw new Error('已配置工作流不存在或无权限');
    }

    const availableServerTypes = await getAvailableServerTypes(input.controllerId, userId);
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
    const workflow = await ConfiguredWorkflow.findOne({ _id: id, ...actorFilter(userId) });
    if (!workflow) {
      throw new Error('已配置工作流不存在或无权限');
    }
    if (opts?.requireAiOwned) {
      assertAiOwned(workflow as { createdBy?: string | null }, '已配置工作流');
    }
    await workflow.deleteOne();
    return true;
  }

  /** 显式落当前请求工作区/租户（插件兜底之外的第二道保证，防后台链路漏写）。 */
  private currentWorkspaceFields(): Record<string, string> {
    const context = getWorkspaceContext();
    if (!context) return {};
    return { resourceWorkspaceId: context.id, tenantId: context.tenantId };
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
      linkUpstreamPullRequest: n.type === 'HUMAN' ? (n.linkUpstreamPullRequest ?? false) : false,
      agentConfig: n.agentConfig ? { ...n.agentConfig } : null,
      sortOrder: n.sortOrder ?? undefined,
    }));
  }

  /**
   * 直接从完整节点图创建已配置工作流（工作流管理工具集用，无来源模板）。
   * 与 configure（模板复制）共用图校验与 agentConfig 校验；创建记录 AI 归属。
   */
  async configureFromContent(
    userId: string,
    input: ConfigureWorkflowInput,
    meta?: ConfiguredWorkflowCreationMeta,
  ) {
    const availableServerTypes = await getAvailableServerTypes(input.controllerId, userId);
    const fullNodes = this.normalizeConfiguredNodes(input.nodes);
    validateTemplateGraph(fullNodes as never);
    validateAgentConfigs(fullNodes as unknown as SourceNodeLike[], availableServerTypes);
    const workspaceFields = this.currentWorkspaceFields();
    return ConfiguredWorkflow.create({
      userId,
      ...workspaceFields,
      controllerId: input.controllerId,
      name: input.name,
      sourceTemplateId: undefined,
      sourceTemplateVersion: undefined,
      nodes: fullNodes,
      createdBy: meta?.createdBy ?? 'HUMAN',
      createdBySessionId: meta?.createdBySessionId ?? undefined,
    });
  }

  /**
   * 从项目（仓库）模板配置工作流（快照语义）：
   * 工作区可见性 → controllerId 推导 → 仅云电脑 → 文件名/名称归一 →
   * 全量图校验 + agentConfig 校验（与 configureFromContent 完全一致）→ 落库 sourceKind=REPO。
   * 服务端不回读仓库文件二次校验（模板后续变更不影响本副本）。
   */
  async configureFromRepo(userId: string, input: ConfigureRepoWorkflowInput) {
    const workspace = await controllerWorkspaceService.findById(input.workspaceId, userId);
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    const controllerId = String(workspace.controllerId);
    const controller = await Controller.findOne({
      _id: controllerId,
      ...actorFilter(userId),
    }).lean();
    if (!controller || controller.type !== 'cloud') {
      throw new Error('repo workflow only supports cloud host');
    }

    const fileName = normalizeRepoFileName(input.fileName);
    const name = normalizeWorkflowName(input.name);

    const availableServerTypes = await getAvailableServerTypes(controllerId, userId);
    const fullNodes = this.normalizeConfiguredNodes(input.nodes);
    validateTemplateGraph(fullNodes as never);
    validateAgentConfigs(fullNodes as unknown as SourceNodeLike[], availableServerTypes);

    const workspaceFields = this.currentWorkspaceFields();
    return ConfiguredWorkflow.create({
      userId,
      ...workspaceFields,
      controllerId,
      name,
      sourceTemplateId: undefined,
      sourceTemplateVersion: undefined,
      sourceKind: 'REPO',
      sourceRepoPath: `${REPO_TEMPLATE_SOURCE_PREFIX}${fileName}`,
      sourceWorkspaceId: input.workspaceId,
      nodes: fullNodes,
      createdBy: 'HUMAN',
    });
  }

  /** 级联删除某控制器下项目来源（REPO）的已配置工作流；PLATFORM 来源零影响。返回删除数。 */
  async deleteRepoScopedByController(controllerId: string): Promise<number> {
    const result = await ConfiguredWorkflow.deleteMany({ controllerId, sourceKind: 'REPO' });
    return Number((result as { deletedCount?: number }).deletedCount ?? 0);
  }
}

export const configuredWorkflowService = new ConfiguredWorkflowService();
