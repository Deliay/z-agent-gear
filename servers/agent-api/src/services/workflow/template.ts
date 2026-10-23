import { WorkflowTemplate, type WorkflowCreatedBy } from '../../models/workflow-template.js';

export type { WorkflowCreatedBy };

export interface WorkflowTemplateNodeInput {
  nodeKey: string;
  type: 'HUMAN' | 'AI' | 'FLAG';
  name: string;
  description?: string | null;
  stage: string;
  prompts?: string[] | null;
  artifactTitles?: string[] | null;
  dependsOn: string[];
  requiresWorktree: boolean;
  linkUpstreamPullRequest?: boolean;
}

export interface WorkflowTemplateCreationMeta {
  /** 归属（默认 HUMAN）；工作流管理工具集创建时传 AI */
  createdBy?: WorkflowCreatedBy;
  createdBySessionId?: string | null;
}

export interface WorkflowTemplateInput {
  name: string;
  description?: string | null;
  nodes: WorkflowTemplateNodeInput[];
}

const NODE_TYPE_LABEL: Record<string, string> = {
  HUMAN: '人类',
  AI: 'AI',
  FLAG: '旗帜',
};

/**
 * 校验工作流模板图（纯函数）。
 * 校验规则见提案 §4.1：nodeKey 唯一、dependsOn 引用存在、DAG 无环、
 * 首节点唯一且为 HUMAN、AI 节点 prompts 至少 1 条、HUMAN/FLAG 不允许 prompts/artifactTitles。
 * @returns 拓扑排序后的 nodeKey 数组
 * @throws 校验失败时抛出带可读中文信息的 Error
 */
export function validateTemplateGraph(nodes: WorkflowTemplateNodeInput[]): string[] {
  if (!nodes || nodes.length === 0) {
    throw new Error('工作流模板至少需要 1 个节点');
  }

  // 1. nodeKey 全局唯一
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.nodeKey)) duplicated.add(node.nodeKey);
    seen.add(node.nodeKey);
  }
  if (duplicated.size > 0) {
    throw new Error(`节点标识（nodeKey）重复：${[...duplicated].join('、')}`);
  }

  // 2. dependsOn 引用必须存在
  const keys = new Set(nodes.map((n) => n.nodeKey));
  for (const node of nodes) {
    for (const dep of node.dependsOn ?? []) {
      if (!keys.has(dep)) {
        throw new Error(`节点「${node.name}」（${node.nodeKey}）依赖了不存在的节点「${dep}」`);
      }
    }
  }

  // 3. 节点类型字段约束
  for (const node of nodes) {
    if (node.type === 'AI') {
      const prompts = (node.prompts ?? []).filter((p) => p.trim().length > 0);
      if (prompts.length === 0) {
        throw new Error(`AI 节点「${node.name}」（${node.nodeKey}）至少需要 1 条提示词（prompts）`);
      }
    } else {
      const label = NODE_TYPE_LABEL[node.type] ?? node.type;
      if (node.prompts && node.prompts.length > 0) {
        throw new Error(`${label}节点「${node.name}」（${node.nodeKey}）不允许配置提示词（prompts）`);
      }
      if (node.artifactTitles && node.artifactTitles.length > 0) {
        throw new Error(`${label}节点「${node.name}」（${node.nodeKey}）不允许配置产物标题（artifactTitles）`);
      }
    }
    if (node.type !== 'HUMAN' && node.linkUpstreamPullRequest === true) {
      throw new Error(`仅人类节点可开启「联动上游 Pull Request」：节点「${node.name}」（${node.nodeKey}）类型为 ${node.type}`);
    }
  }

  // 4. DAG 无环（DFS 检测，报出环上节点）
  const cycle = detectCycle(nodes);
  if (cycle.length > 0) {
    throw new Error(`工作流模板存在循环依赖，环上节点：${cycle.join(' → ')}`);
  }

  // 5. 入度为 0 的节点有且仅有一个，且 type=HUMAN
  const sources = nodes.filter((n) => (n.dependsOn ?? []).length === 0);
  if (sources.length !== 1) {
    const detail = sources.map((s) => `${s.name}（${s.nodeKey}）`).join('、');
    throw new Error(
      `首节点必须唯一：入度为 0 的节点应有且仅有 1 个，当前为 ${sources.length} 个${detail ? `：${detail}` : ''}`,
    );
  }
  const first = sources[0];
  if (first.type !== 'HUMAN') {
    throw new Error(
      `首节点必须是人类节点（HUMAN），当前节点「${first.name}」（${first.nodeKey}）类型为 ${first.type}`,
    );
  }

  // 拓扑排序（Kahn）
  return topologicalSort(nodes);
}

/** DFS 检测环，返回环上 nodeKey 列表（无环返回空数组） */
function detectCycle(nodes: WorkflowTemplateNodeInput[]): string[] {
  const deps = new Map(nodes.map((n) => [n.nodeKey, n.dependsOn ?? []]));
  const state = new Map<string, 'visiting' | 'done'>();
  let cycle: string[] = [];

  const dfs = (key: string, stack: string[]): boolean => {
    state.set(key, 'visiting');
    stack.push(key);
    for (const dep of deps.get(key) ?? []) {
      const s = state.get(dep);
      if (s === 'visiting') {
        cycle = stack.slice(stack.indexOf(dep));
        return true;
      }
      if (s !== 'done' && dfs(dep, stack)) return true;
    }
    stack.pop();
    state.set(key, 'done');
    return false;
  };

  for (const node of nodes) {
    if (!state.has(node.nodeKey) && dfs(node.nodeKey, [])) break;
  }
  return cycle;
}

/** Kahn 拓扑排序（调用前需保证无环） */
function topologicalSort(nodes: WorkflowTemplateNodeInput[]): string[] {
  const inDegree = new Map(nodes.map((n) => [n.nodeKey, (n.dependsOn ?? []).length]));
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dep of node.dependsOn ?? []) {
      const list = dependents.get(dep) ?? [];
      list.push(node.nodeKey);
      dependents.set(dep, list);
    }
  }
  const queue = nodes.filter((n) => (n.dependsOn ?? []).length === 0).map((n) => n.nodeKey);
  const order: string[] = [];
  while (queue.length > 0) {
    const key = queue.shift()!;
    order.push(key);
    for (const next of dependents.get(key) ?? []) {
      const d = inDegree.get(next)! - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  return order;
}

/** 校验 AI 归属：AI 只能删除自己（AI）创建的资源；内置模板另由调用方拒绝。供管理工具集复用 */
export function assertAiOwned(resource: { createdBy?: string | null } | null | undefined, label: string): void {
  if (!resource) {
    throw new Error(`${label}不存在或无权限`);
  }
  if (resource.createdBy && resource.createdBy !== 'AI') {
    throw new Error(`该${label}由人类创建，不允许 AI 删除`);
  }
}

class WorkflowTemplateService {
  /** 列出用户自有模板 + 内置模板 */
  async listForUser(userId: string) {
    return WorkflowTemplate.find({ $or: [{ userId }, { isBuiltin: true }] })
      .sort({ isBuiltin: -1, createdAt: -1 })
      .lean();
  }

  async findById(id: string, userId: string) {
    return WorkflowTemplate.findOne({ _id: id, $or: [{ userId }, { isBuiltin: true }] }).lean();
  }

  async create(userId: string, input: WorkflowTemplateInput, meta?: WorkflowTemplateCreationMeta) {
    validateTemplateGraph(input.nodes);
    return WorkflowTemplate.create({
      userId,
      name: input.name,
      description: input.description ?? undefined,
      nodes: input.nodes,
      version: 1,
      isBuiltin: false,
      createdBy: meta?.createdBy ?? 'HUMAN',
      createdBySessionId: meta?.createdBySessionId ?? undefined,
    });
  }

  async update(id: string, userId: string, input: WorkflowTemplateInput) {
    // 内置模板（userId=null）也要能查到，以便命中下方的只读保护，而不是误报「不存在」
    const template = await WorkflowTemplate.findOne({ _id: id, $or: [{ userId }, { isBuiltin: true }] });
    if (!template) {
      throw new Error('工作流模板不存在或无权限');
    }
    if (template.isBuiltin) {
      throw new Error('内置模板不允许修改，可通过「配置工作流」复制使用');
    }
    validateTemplateGraph(input.nodes);
    template.name = input.name;
    template.description = input.description ?? undefined;
    template.nodes = input.nodes as never;
    template.version = (template.version ?? 1) + 1;
    await template.save();
    return template;
  }

  async delete(id: string, userId: string, opts?: { requireAiOwned?: boolean }): Promise<boolean> {
    const template = await WorkflowTemplate.findOne({ _id: id, $or: [{ userId }, { isBuiltin: true }] });
    if (!template) {
      throw new Error('工作流模板不存在或无权限');
    }
    if (template.isBuiltin) {
      throw new Error('内置模板不允许删除');
    }
    if (opts?.requireAiOwned) {
      assertAiOwned(template as { createdBy?: string | null }, '工作流模板');
    }
    await template.deleteOne();
    return true;
  }
}

export const workflowTemplateService = new WorkflowTemplateService();
