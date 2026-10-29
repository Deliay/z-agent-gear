import { WorkflowPrHandler, type PrHandlerUnregisterReason } from '../../models/workflow-pr-handler.js';
import { KeyedMutex } from '../keyed-mutex.js';
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

/** 同实例+节点的注册串行化（C-6：delete-then-upsert 并发可能双存活）。 */
const registerMutex = new KeyedMutex();

type InstanceUnregisteredListener = (instanceId: string) => void;
const instanceUnregisteredListeners = new Set<InstanceUnregisteredListener>();

/**
 * 注册「实例登记注销」进程内监听（用于清理按 check-run 维护的进程内缓存）。
 * 监听器必须同步返回且自行吞掉异常，不得阻塞注销主流程。
 */
export function onPrHandlerInstanceUnregistered(listener: InstanceUnregisteredListener): void {
  instanceUnregisteredListeners.add(listener);
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
    const key = `${String(input.workflowInstanceId)}:${String(input.nodeId)}`;
    return registerMutex.runExclusive(key, () => this.registerUnlocked(input));
  }

  private async registerUnlocked(input: RegisterPrHandlerInput): Promise<HandlerDoc> {
    const normalized = normalizePullRequestId(input.pullRequestId);
    const pullRequestId = normalized.pullRequestId;
    const pullRequestIdLower = lowerId(pullRequestId);
    const prUrl = input.prUrl || normalized.prUrl;

    await WorkflowPrHandler.deleteMany({
      workflowInstanceId: input.workflowInstanceId,
      nodeId: input.nodeId,
      pullRequestIdLower: { $ne: pullRequestIdLower },
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
            pullRequestIdLower,
            prUrl,
            registeredBySessionId: input.sessionId ?? null,
          },
        },
        { upsert: true, returnDocument: 'after' },
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

  /** 按登记 ID 重读（事件处理器在实例锁内做幂等判定，避免锁外陈旧快照 TOCTOU） */
  async findById(id: string): Promise<HandlerDoc | null> {
    return (await WorkflowPrHandler.findById(id).lean()) as unknown as HandlerDoc | null;
  }

  /** 按 PR 查登记（大小写不敏感，小写列精确匹配走索引） */
  async findByPullRequestId(pullRequestId: string): Promise<HandlerDoc[]> {
    const normalized = normalizePullRequestId(pullRequestId).pullRequestId;
    const rows = (await WorkflowPrHandler.find({
      pullRequestIdLower: lowerId(normalized),
    })
      .sort({ createdAt: 1 })
      .lean()) as unknown as HandlerDoc[];

    for (const row of rows) this.indexOne(row);
    // C-1：以 DB 为唯一事实源。内存索引只用于加速/启动重建，
    // 不再参与结果合并，避免其它副本已删除的登记从本进程索引「复活」。
    return rows;
  }

  /** 按实例+节点查登记（Check Runs 同步入口；未绑定返回 null） */
  async findByNode(workflowInstanceId: string, nodeId: string): Promise<HandlerDoc | null> {
    return (await WorkflowPrHandler.findOne({
      workflowInstanceId,
      nodeId,
    }).lean()) as unknown as HandlerDoc | null;
  }

  /** 记录一次成功的 check-run 写入（成功路径同时清空失败文案） */
  async markCheckRunSynced(
    id: string,
    input: {
      commitSha: string;
      checkRunId: number;
      checkRunUrl: string | null;
      nodeStatus: string;
      at: Date;
      /** 写入新 check-run 时清空 todo digest（新检查项尚无子项，需下一次 plan 刷新） */
      resetTodoDigest?: boolean;
    },
  ): Promise<void> {
    const update: Record<string, unknown> = {
      lastWrittenCommitSha: input.commitSha,
      lastCheckRunId: input.checkRunId,
      lastCheckRunUrl: input.checkRunUrl,
      lastSyncedNodeStatus: input.nodeStatus,
      lastSyncAt: input.at,
      lastSyncError: null,
    };
    if (input.resetTodoDigest) update.lastTodoDigest = null;
    await WorkflowPrHandler.updateOne({ _id: id }, { $set: update });
  }

  /**
   * 记录 todo 子项写入的渲染 digest（内容未变时跳过）。
   * 传入 `checkRunId` 时仅在「该 check-run 仍是当前写入目标」时回写，
   * 避免 commit 前进后旧节流项把 digest 记到新检查项上、抑制后续刷新。
   */
  async markTodoSynced(
    id: string,
    input: { digest: string; at: Date; checkRunId?: number },
  ): Promise<void> {
    const filter: Record<string, unknown> = { _id: id };
    if (input.checkRunId !== undefined) filter.lastCheckRunId = input.checkRunId;
    await WorkflowPrHandler.updateOne(filter, {
      $set: { lastTodoDigest: input.digest, lastSyncAt: input.at, lastSyncError: null },
    });
  }

  /** 记录同步失败短文案（`null` = 清空，如 PR 已关闭停止同步）；截断 200 字符 */
  async markSyncError(id: string, message: string | null): Promise<void> {
    await WorkflowPrHandler.updateOne(
      { _id: id },
      { $set: { lastSyncError: message === null ? null : message.slice(0, 200) } },
    );
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
    for (const listener of instanceUnregisteredListeners) {
      try {
        listener(instanceId);
      } catch {
        // 进程内缓存清理失败不影响注销结果
      }
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
