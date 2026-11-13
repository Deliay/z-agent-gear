import { Controller } from '../../models/controller.js';
import { controllerWorkspaceService } from '../controller-workspace.js';
import { actorFilter } from '../workspace-context.js';
import { publish } from '../../middleware/publish.js';
import { getRedisClient } from '../../middleware/redis.js';
import { compareVersions } from '../version.js';
import { validateTemplateGraph, type WorkflowTemplateNodeInput } from './template.js';

/** 项目模板扫描轮询口径（与 fs:read-file 同参数：500ms × 30 ≈ 15s） */
export const REPO_TEMPLATE_POLL_INTERVAL_MS = 500;
export const REPO_TEMPLATE_POLL_ATTEMPTS = 30;

/** agent-gear 2.18.0 起支持 workflow-templates:scan */
export const REPO_TEMPLATE_MIN_AGENT_GEAR_VERSION = '2.18.0';

export function isRepoTemplateScanSupported(version: unknown): boolean {
  if (typeof version !== 'string' || version.trim() === '') return false;
  try {
    return compareVersions(version, REPO_TEMPLATE_MIN_AGENT_GEAR_VERSION) >= 0;
  } catch {
    return false;
  }
}

/** 解析后的项目模板（纯数据，供 GraphQL 透出） */
export interface RepoWorkflowTemplateResult {
  fileName: string;
  name: string | null;
  description: string | null;
  nodeCount: number | null;
  valid: boolean;
  errors: string[];
  nodes: WorkflowTemplateNodeInput[];
}

export interface ParsedRepoTemplate {
  name: string | null;
  description: string | null;
  nodes: WorkflowTemplateNodeInput[];
  errors: string[];
}

const NODE_TYPES = new Set(['HUMAN', 'AI', 'FLAG']);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function shapeError(detail: string): ParsedRepoTemplate {
  return { name: null, description: null, nodes: [], errors: [`工作流模板格式不正确：${detail}`] };
}

/** 节点字段类型归一；返回 null 表示该节点形状不合法 */
function normalizeNode(raw: unknown, index: number): WorkflowTemplateNodeInput | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return `第 ${index + 1} 个节点必须为对象`;
  }
  const node = raw as Record<string, unknown>;
  if (typeof node.nodeKey !== 'string' || node.nodeKey.trim() === '') {
    return `第 ${index + 1} 个节点缺少 nodeKey`;
  }
  if (typeof node.type !== 'string' || !NODE_TYPES.has(node.type)) {
    return `节点「${node.nodeKey}」的 type 必须为 HUMAN/AI/FLAG`;
  }
  if (typeof node.name !== 'string' || node.name.trim() === '') {
    return `节点「${node.nodeKey}」缺少 name`;
  }
  if (typeof node.stage !== 'string' || node.stage.trim() === '') {
    return `节点「${node.nodeKey}」缺少 stage`;
  }
  if (node.description !== undefined && node.description !== null && typeof node.description !== 'string') {
    return `节点「${node.nodeKey}」的 description 必须为字符串`;
  }
  if (node.prompts !== undefined && node.prompts !== null && !isStringArray(node.prompts)) {
    return `节点「${node.nodeKey}」的 prompts 必须为字符串数组`;
  }
  if (
    node.artifactTitles !== undefined &&
    node.artifactTitles !== null &&
    !isStringArray(node.artifactTitles)
  ) {
    return `节点「${node.nodeKey}」的 artifactTitles 必须为字符串数组`;
  }
  if (node.dependsOn !== undefined && node.dependsOn !== null && !isStringArray(node.dependsOn)) {
    return `节点「${node.nodeKey}」的 dependsOn 必须为字符串数组`;
  }
  if (node.requiresWorktree !== undefined && node.requiresWorktree !== null && typeof node.requiresWorktree !== 'boolean') {
    return `节点「${node.nodeKey}」的 requiresWorktree 必须为布尔值`;
  }
  if (
    node.linkUpstreamPullRequest !== undefined &&
    node.linkUpstreamPullRequest !== null &&
    typeof node.linkUpstreamPullRequest !== 'boolean'
  ) {
    return `节点「${node.nodeKey}」的 linkUpstreamPullRequest 必须为布尔值`;
  }
  if (
    node.sortOrder !== undefined &&
    node.sortOrder !== null &&
    (typeof node.sortOrder !== 'number' || !Number.isFinite(node.sortOrder))
  ) {
    return `节点「${node.nodeKey}」的 sortOrder 必须为数字`;
  }

  return {
    nodeKey: node.nodeKey,
    type: node.type as 'HUMAN' | 'AI' | 'FLAG',
    name: node.name,
    description: (node.description as string | null | undefined) ?? null,
    stage: node.stage,
    prompts: (node.prompts as string[] | null | undefined) ?? null,
    artifactTitles: (node.artifactTitles as string[] | null | undefined) ?? null,
    dependsOn: (node.dependsOn as string[] | undefined) ?? [],
    requiresWorktree: (node.requiresWorktree as boolean | undefined) ?? false,
    linkUpstreamPullRequest: (node.linkUpstreamPullRequest as boolean | undefined) ?? false,
    sortOrder: (node.sortOrder as number | null | undefined) ?? null,
  };
}

/**
 * 解析并校验单个项目模板文件（纯函数）：
 * JSON 语法 → 顶层形状 → 节点字段类型归一 → 图校验（错误文案原样透传）。
 */
export function parseRepoTemplate(content: string): ParsedRepoTemplate {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return { name: null, description: null, nodes: [], errors: ['不是合法的 JSON 文件'] };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return shapeError('顶层必须为 JSON 对象');
  }
  const doc = raw as Record<string, unknown>;
  if (typeof doc.name !== 'string' || doc.name.trim() === '') {
    return shapeError('name 必须为非空字符串');
  }
  if (doc.description !== undefined && doc.description !== null && typeof doc.description !== 'string') {
    return shapeError('description 必须为字符串');
  }
  if (!Array.isArray(doc.nodes) || doc.nodes.length === 0) {
    return shapeError('nodes 必须为非空数组');
  }

  const nodes: WorkflowTemplateNodeInput[] = [];
  for (let i = 0; i < doc.nodes.length; i += 1) {
    const normalized = normalizeNode(doc.nodes[i], i);
    if (typeof normalized === 'string') {
      return shapeError(normalized);
    }
    nodes.push(normalized);
  }

  try {
    validateTemplateGraph(nodes);
  } catch (err) {
    return {
      name: doc.name,
      description: (doc.description as string | null | undefined) ?? null,
      nodes,
      errors: [(err as Error).message],
    };
  }

  return {
    name: doc.name,
    description: (doc.description as string | null | undefined) ?? null,
    nodes,
    errors: [],
  };
}

interface RawTemplateFile {
  fileName?: unknown;
  content?: unknown;
  error?: unknown;
}

class RepoTemplateService {
  /** 扫描项目工作区的模板目录并逐文件解析校验；任何不可用场景均降级为空列表。 */
  async scan(userId: string, workspaceId: string): Promise<RepoWorkflowTemplateResult[]> {
    const workspace = await controllerWorkspaceService.findById(workspaceId, userId);
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    const controller = await Controller.findOne({
      _id: workspace.controllerId,
      ...actorFilter(userId),
    }).lean();
    if (!controller || controller.status !== 'online' || !isRepoTemplateScanSupported(controller.version)) {
      return [];
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const redis = getRedisClient();
    await publish('session:command', {
      type: 'workflow-templates:scan',
      requestId,
      controllerId: String(controller._id),
      path: String(workspace.path),
    });

    for (let attempt = 0; attempt < REPO_TEMPLATE_POLL_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, REPO_TEMPLATE_POLL_INTERVAL_MS));
      const raw = await redis.get(`workflow-templates:scan:${requestId}`);
      if (!raw) continue;
      // 一次性消费（读后即删，与 fs:read-file 同型）
      await redis.del(`workflow-templates:scan:${requestId}`).catch(() => undefined);
      let parsed: { success?: boolean; templates?: unknown };
      try {
        parsed = JSON.parse(raw);
      } catch {
        return [];
      }
      if (!parsed.success || !Array.isArray(parsed.templates)) {
        return [];
      }
      return this.mapFiles(parsed.templates as RawTemplateFile[]);
    }

    // 扫描超时：降级空列表（前端可手动重新检测）
    return [];
  }

  private mapFiles(files: RawTemplateFile[]): RepoWorkflowTemplateResult[] {
    const results: RepoWorkflowTemplateResult[] = [];
    for (const file of files) {
      if (typeof file?.fileName !== 'string' || file.fileName.trim() === '') continue;
      const fileName = file.fileName;
      if (typeof file.error === 'string' && file.error.trim() !== '') {
        results.push({
          fileName,
          name: null,
          description: null,
          nodeCount: null,
          valid: false,
          errors: [file.error],
          nodes: [],
        });
        continue;
      }
      const content = typeof file.content === 'string' ? file.content : '';
      const parsed = parseRepoTemplate(content);
      results.push({
        fileName,
        name: parsed.name,
        description: parsed.description,
        nodeCount: parsed.errors.length === 0 ? parsed.nodes.length : null,
        valid: parsed.errors.length === 0,
        errors: parsed.errors,
        nodes: parsed.errors.length === 0 ? parsed.nodes : [],
      });
    }
    return results.sort((a, b) => a.fileName.localeCompare(b.fileName));
  }
}

export const repoTemplateService = new RepoTemplateService();
