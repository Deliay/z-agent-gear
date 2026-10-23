import { WorkflowPrHandler, type PrHandlerUnregisterReason } from '../../models/workflow-pr-handler.js';
import { workflowEngine } from './engine.js';

/** PR 标识无法归一化（工具层映射为 INVALID_PARAMS） */
export class PullRequestIdError extends Error {
  readonly code = 'INVALID_PULL_REQUEST_ID';
  constructor(message: string) {
    super(message);
    this.name = 'PullRequestIdError';
  }
}

export interface NormalizedPullRequestId {
  pullRequestId: string;
  prUrl: string;
}

const OWNER_REPO_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * 归一化 Pull Request 标识（纯函数）：
 * - `https://github.com/<owner>/<repo>/pull/<n>`
 * - `<owner>/<repo>#<n>`
 * - `<owner>/<repo>/pull/<n>`
 * 输出 `<owner>/<repo>#<n>`（保留原始大小写，比较时小写归一）。
 */
export function normalizePullRequestId(input: string): NormalizedPullRequestId {
  if (typeof input !== 'string') {
    throw new PullRequestIdError('Pull Request 标识必须为字符串');
  }
  let value = input.trim();
  if (!value) {
    throw new PullRequestIdError('Pull Request 标识不能为空');
  }
  // 去掉末尾斜杠（保留 # 形式，仅 URL 允许查询/锚点后缀）
  value = value.replace(/\/+$/, '');

  const urlMatch =
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[?#].*)?$/i.exec(value);
  if (urlMatch) {
    return build(urlMatch[1], urlMatch[2], urlMatch[3]);
  }

  const hashMatch = /^([^/#\s]+)\/([^#\s]+)#(\d+)$/.exec(value);
  if (hashMatch) {
    return build(hashMatch[1], hashMatch[2], hashMatch[3]);
  }

  const pathMatch = /^([^/\s]+)\/([^/\s]+)\/pull\/(\d+)$/i.exec(value);
  if (pathMatch) {
    return build(pathMatch[1], pathMatch[2], pathMatch[3]);
  }

  throw new PullRequestIdError(
    `无法识别的 Pull Request 标识「${input}」，请使用 owner/repo#编号 或完整 Pull Request 链接`,
  );
}

function build(owner: string, repo: string, numberText: string): NormalizedPullRequestId {
  const number = Number.parseInt(numberText, 10);
  if (
    !OWNER_REPO_PATTERN.test(owner) ||
    !OWNER_REPO_PATTERN.test(repo) ||
    owner === '.' ||
    owner === '..' ||
    repo === '.' ||
    repo === '..' ||
    !Number.isSafeInteger(number) ||
    number <= 0
  ) {
    throw new PullRequestIdError(`非法的 Pull Request 标识：${owner}/${repo}#${numberText}`);
  }
  return {
    pullRequestId: `${owner}/${repo}#${number}`,
    prUrl: `https://github.com/${owner}/${repo}/pull/${number}`,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lowerId(id: string): string {
  return id.toLowerCase();
}

type HandlerDoc = Record<string, unknown> & { _id: unknown; pullRequestId: string; workflowInstanceId?: unknown };

export interface RegisterPrHandlerInput {
  userId: string;
  workflowInstanceId: string;
  nodeId: string;
  nodeKey?: string | null;
  pullRequestId: string;
  prUrl?: string | null;
  sessionId?: string | null;
}

/** PR 联动登记：Mongo 持久化 + 进程内索引（仅加速，查询以 DB 为准）。 */
class PrHandlerRegistry {
  private index = new Map<string, Map<string, HandlerDoc>>();

  /** 启动重建：全量装载并建索引；失败只告警，不阻断启动 */
  async rebuild(): Promise<number> {
    try {
      const rows = (await WorkflowPrHandler.find({}).lean()) as unknown as HandlerDoc[];
      this.index.clear();
      for (const row of rows) this.indexOne(row);
      return rows.length;
    } catch (err) {
      console.warn('[pr-handler] rebuild failed:', (err as Error).message);
      return 0;
    }
  }

  /** 注册（同节点换 PR 时旧登记标记 REPLACED 并删除） */
  async register(input: RegisterPrHandlerInput): Promise<HandlerDoc> {
    const normalized = normalizePullRequestId(input.pullRequestId);
    const pullRequestId = normalized.pullRequestId;
    const prUrl = input.prUrl || normalized.prUrl;

    await WorkflowPrHandler.deleteMany({
      workflowInstanceId: input.workflowInstanceId,
      nodeId: input.nodeId,
      pullRequestId: { $ne: pullRequestId },
    });

    let row: HandlerDoc | null = null;
    try {
      row = (await WorkflowPrHandler.findOneAndUpdate(
        {
          workflowInstanceId: input.workflowInstanceId,
          nodeId: input.nodeId,
          pullRequestId,
        },
        {
          $set: {
            userId: input.userId,
            workflowInstanceId: input.workflowInstanceId,
            nodeId: input.nodeId,
            nodeKey: input.nodeKey ?? null,
            pullRequestId,
            prUrl,
            registeredBySessionId: input.sessionId ?? null,
          },
        },
        { upsert: true, new: true },
      ).lean()) as unknown as HandlerDoc | null;
    } catch (err) {
      // 并发注册撞唯一键：读取已存在行视为成功
      if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
        row = (await WorkflowPrHandler.findOne({
          workflowInstanceId: input.workflowInstanceId,
          nodeId: input.nodeId,
          pullRequestId,
        }).lean()) as unknown as HandlerDoc | null;
      } else {
        throw err;
      }
    }

    if (!row) throw new Error('注册 Pull Request 联动失败');

    // 索引同步：移除同节点旧关联，再写入当前行
    this.removeFromIndexByNode(String(input.workflowInstanceId), String(input.nodeId), pullRequestId);
    this.indexOne(row);
    return row;
  }

  /** 按 PR 查登记（大小写不敏感） */
  async findByPullRequestId(pullRequestId: string): Promise<HandlerDoc[]> {
    const normalized = normalizePullRequestId(pullRequestId).pullRequestId;
    const rows = (await WorkflowPrHandler.find({
      pullRequestId: { $regex: `^${escapeRegExp(normalized)}$`, $options: 'i' },
    })
      .sort({ createdAt: 1 })
      .lean()) as unknown as HandlerDoc[];

    for (const row of rows) this.indexOne(row);
    // 合并进程内索引（DB 为准，索引补位）
    const merged = new Map<string, HandlerDoc>();
    for (const row of rows) merged.set(String(row._id), row);
    for (const row of this.index.get(lowerId(normalized))?.values() ?? []) {
      merged.set(String(row._id), row);
    }
    return [...merged.values()];
  }

  /** 按实例列举（GraphQL pullRequestLinks 数据源） */
  async listByInstance(instanceId: string): Promise<HandlerDoc[]> {
    return (await WorkflowPrHandler.find({ workflowInstanceId: instanceId })
      .sort({ nodeId: 1, createdAt: 1 })
      .lean()) as unknown as HandlerDoc[];
  }

  /** 注销实例全部登记，返回条数（失败由调用方告警，不回滚主流程） */
  async unregisterByInstance(instanceId: string, reason: PrHandlerUnregisterReason): Promise<number> {
    const result = (await WorkflowPrHandler.deleteMany({
      workflowInstanceId: instanceId,
    })) as unknown as { deletedCount?: number };
    const count = result?.deletedCount ?? 0;
    for (const [key, entries] of this.index.entries()) {
      for (const [id, row] of entries.entries()) {
        if (String(row.workflowInstanceId) === instanceId) entries.delete(id);
      }
      if (entries.size === 0) this.index.delete(key);
    }
    if (count > 0) {
      console.log(`[pr-handler] unregistered ${count} handler(s) for instance ${instanceId} (${reason})`);
    }
    return count;
  }

  /** 标记事件已处理（幂等位） */
  async markEventHandled(id: string, eventId: string, at: Date): Promise<void> {
    await WorkflowPrHandler.updateOne({ _id: id }, { $set: { lastEventId: eventId, lastEventAt: at } });
  }

  /** 向引擎注册工作流完成 hook：完成即注销全部 PR 关联 */
  registerPrHandlerLifecycleHooks(): void {
    workflowEngine.registerHooks({
      onWorkflowFinished: (instance) =>
        this.unregisterByInstance(instance._id.toString(), 'WORKFLOW_FINISHED').then(
          () => undefined,
          (err: unknown) => {
            console.warn('[pr-handler] unregister on finish failed:', (err as Error).message);
          },
        ),
    });
  }

  private indexOne(row: HandlerDoc): void {
    const key = lowerId(row.pullRequestId);
    let entries = this.index.get(key);
    if (!entries) {
      entries = new Map();
      this.index.set(key, entries);
    }
    entries.set(String(row._id), row);
  }

  private removeFromIndexByNode(instanceId: string, nodeId: string, keepPullRequestId: string): void {
    for (const [key, entries] of this.index.entries()) {
      for (const [id, row] of entries.entries()) {
        if (
          String(row.workflowInstanceId) === instanceId &&
          String(row.nodeId) === nodeId &&
          lowerId(row.pullRequestId) !== lowerId(keepPullRequestId)
        ) {
          entries.delete(id);
        }
      }
      if (entries.size === 0) this.index.delete(key);
    }
  }
}

export const prHandlerRegistry = new PrHandlerRegistry();
