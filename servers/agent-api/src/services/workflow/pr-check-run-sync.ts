import { createHash } from 'node:crypto';
import { githubService } from '../github.js';
import { KeyedMutex } from '../keyed-mutex.js';
import { prHandlerRegistry, normalizePullRequestId } from './pr-handler-registry.js';
import {
  workflowEngine,
  type NodeTransitionChange,
  type WorkflowInstanceDoc,
  type WorkflowNodeDoc,
} from './engine.js';
import {
  createCheckRun,
  updateCheckRun,
  getPullRequestHead,
  GitHubChecksError,
  type CheckRunConclusion,
  type CheckRunOutput,
  type CheckRunStatus,
} from './github-checks-client.js';

/**
 * 工作流节点状态 / 任务清单 → GitHub Check Runs 的只读投影。
 *
 * 约束（实现计划裁决）：
 * - 故障不回流：所有导出函数永不抛出，失败只记 `lastSyncError` + warn；
 * - capture-then-execute：入口先捕获 handler 快照，后续 GitHub I/O 与回写均按 `_id` 定位；
 * - per-handler `KeyedMutex` 串行，避免状态同步与 todo 同步交错写同一 check-run；
 * - 凭据零泄露：token 不落库/不进日志/不进错误文案，响应体一律不打印。
 */

const CHECK_RUN_NAME_PREFIX = 'ZAG 工作流';
const TODO_MAX_ENTRIES = 100;
const TODO_MAX_CONTENT_LENGTH = 500;
/** todo 子项最小写入间隔（尾沿合并） */
export const TODO_MIN_INTERVAL_MS = 3_000;

export type TodoEntryStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoEntry {
  content: string;
  status: TodoEntryStatus;
  priority?: string;
}

/** 一次性捕获的 handler 投影快照（后续 GitHub I/O 与回写只依赖它） */
export interface PrSyncSnapshot {
  handlerId: string;
  userId: string;
  pullRequestId: string;
  workflowInstanceId: string;
  nodeId: string;
  nodeName: string;
  nodeStatus: string;
  stage: string;
  instanceName: string;
  lastCheckRunId: number | null;
  lastWrittenCommitSha: string | null;
  lastSyncedNodeStatus: string | null;
  lastTodoDigest: string | null;
}

export interface CheckRunProjection {
  status: CheckRunStatus;
  conclusion?: CheckRunConclusion;
  label: string;
}

export interface PullRequestTarget {
  repo: string;
  number: number;
}

/** 失败文案白名单（不透出上游原文与凭据） */
export const SYNC_ERROR_MESSAGES = {
  FORBIDDEN: '检查项写入权限不足',
  NOT_FOUND: '仓库或 PR 不可见',
  RATE_LIMITED: 'GitHub 限流，稍后自动重试',
  UPSTREAM: 'GitHub 暂不可用，稍后自动重试',
  INVALID_PAYLOAD: '检查项写入参数被拒',
} as const;

const syncMutex = new KeyedMutex();

interface TodoThrottleState {
  lastSentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  pending: { snapshot: PrSyncSnapshot; text: string; digest: string } | null;
}
const todoThrottle = new Map<number, TodoThrottleState>();

/** 测试用：重置 todo 节流状态（生产代码不调用） */
export function resetTodoThrottle(): void {
  for (const state of todoThrottle.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  todoThrottle.clear();
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 从登记行 + 实例/节点快照组装同步快照 */
export function captureSnapshot(
  instance: WorkflowInstanceDoc,
  node: WorkflowNodeDoc,
  handler: Record<string, unknown>,
): PrSyncSnapshot {
  return {
    handlerId: String(handler._id),
    userId: String(handler.userId),
    pullRequestId: String(handler.pullRequestId),
    workflowInstanceId: instance._id.toString(),
    nodeId: node.nodeId,
    nodeName: node.name,
    nodeStatus: node.status,
    stage: node.stage,
    instanceName: instance.name,
    lastCheckRunId: toNumber(handler.lastCheckRunId),
    lastWrittenCommitSha: toStringOrNull(handler.lastWrittenCommitSha),
    lastSyncedNodeStatus: toStringOrNull(handler.lastSyncedNodeStatus),
    lastTodoDigest: toStringOrNull(handler.lastTodoDigest),
  };
}

/** `owner/repo#n` → { repo, number } */
export function parsePullRequestTarget(pullRequestId: string): PullRequestTarget {
  const normalized = normalizePullRequestId(pullRequestId).pullRequestId;
  const match = /^([^/]+\/[^#]+)#(\d+)$/.exec(normalized);
  if (!match) throw new Error('invalid pull request id');
  return { repo: match[1], number: Number.parseInt(match[2], 10) };
}

/** 节点状态 → 检查项表现（PRD 附录 A.2 逐字） */
export function mapNodeStatusToCheckRun(status: string): CheckRunProjection {
  switch (status) {
    case 'INITIALIZING':
    case 'READY':
      return { status: 'queued', label: '排队中' };
    case 'RUNNING':
      return { status: 'in_progress', label: '执行中' };
    case 'REWORK':
      return { status: 'in_progress', label: '返工中' };
    case 'DONE':
      return { status: 'completed', conclusion: 'success', label: '已完成' };
    case 'REJECT':
      return { status: 'completed', conclusion: 'action_required', label: '被打回，待处理' };
    case 'FAILED':
      return { status: 'completed', conclusion: 'failure', label: '执行失败' };
    default:
      return { status: 'queued', label: '排队中' };
  }
}

export function checkRunName(nodeName: string): string {
  return `${CHECK_RUN_NAME_PREFIX} · ${nodeName}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 任务清单渲染（PRD 附录 A.3；条数上限 100、单条截断 500） */
export function renderTodoMarkdown(entries: TodoEntry[], now: Date = new Date()): string {
  const limited = entries.slice(0, TODO_MAX_ENTRIES).map((entry) => ({
    content: entry.content.slice(0, TODO_MAX_CONTENT_LENGTH),
    status: entry.status,
  }));
  const completed = limited.filter((entry) => entry.status === 'completed').length;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const header = `**任务清单**（${completed}/${limited.length} 完成 · 更新于 ${time}）`;
  if (limited.length === 0) return `${header}\n（暂无任务）`;
  const lines = limited.map((entry) => {
    if (entry.status === 'completed') return `- [x] ${entry.content}`;
    if (entry.status === 'in_progress') return `- 🔄 ${entry.content}`;
    return `- [ ] ${entry.content}`;
  });
  return [header, ...lines].join('\n');
}

/** digest 不含时间戳（内容未变即相同），保证幂等 */
export function computeTodoDigest(entries: TodoEntry[]): string {
  const source = renderTodoMarkdown(entries, new Date(0));
  return createHash('sha1').update(source).digest('hex');
}

function syncErrorMessage(err: unknown): string {
  if (err instanceof GitHubChecksError) {
    return SYNC_ERROR_MESSAGES[err.code] ?? SYNC_ERROR_MESSAGES.UPSTREAM;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('not authorized') || message.includes('not found')) {
    return SYNC_ERROR_MESSAGES.FORBIDDEN;
  }
  return SYNC_ERROR_MESSAGES.UPSTREAM;
}

function buildOutput(
  snapshot: PrSyncSnapshot,
  label: string,
  text?: string,
): CheckRunOutput {
  const output: CheckRunOutput = {
    title: `${snapshot.nodeName} · ${label}`,
    summary: `工作流：${snapshot.instanceName} · 阶段：${snapshot.stage} · 同步于 ${new Date().toISOString()}`,
  };
  if (text !== undefined) output.text = text;
  return output;
}

async function recordError(snapshot: PrSyncSnapshot, err: unknown): Promise<void> {
  const message = syncErrorMessage(err);
  const detail = err instanceof GitHubChecksError ? err.code : (err as Error)?.message;
  console.warn(`[pr-check-run] sync failed for ${snapshot.pullRequestId}: ${detail}`);
  try {
    await prHandlerRegistry.markSyncError(snapshot.handlerId, message);
  } catch {
    // 回写失败只告警，绝不抛出
  }
}

/**
 * 节点状态同步（永不抛出）。
 * 三分支：同 sha 原地 PATCH / commit 前进（旧 stale + 新 create）/ 无旧 check-run 直接 create。
 */
export async function syncNodeStatus(
  instance: WorkflowInstanceDoc,
  node: WorkflowNodeDoc,
): Promise<void> {
  let snapshot: PrSyncSnapshot | null = null;
  try {
    const handler = await prHandlerRegistry.findByNode(instance._id.toString(), node.nodeId);
    if (!handler) return;
    snapshot = captureSnapshot(instance, node, handler);
    await syncMutex.runExclusive(snapshot.handlerId, () =>
      syncNodeStatusUnlocked(snapshot as PrSyncSnapshot),
    );
  } catch (err) {
    if (snapshot) await recordError(snapshot, err);
    else console.warn('[pr-check-run] status sync failed:', (err as Error)?.message);
  }
}

async function syncNodeStatusUnlocked(snapshot: PrSyncSnapshot): Promise<void> {
  try {
    const target = parsePullRequestTarget(snapshot.pullRequestId);
    const { token } = await githubService.createRepoScopedTokenForUser(snapshot.userId, target.repo);
    const head = await getPullRequestHead(token, target.repo, target.number);

    // PR 已关闭/合并：停止同步，不写失败文案（PRD 3.5）
    if (head.state !== 'open' || head.merged) {
      console.info(
        `[pr-check-run] skip sync: PR ${snapshot.pullRequestId} is ${head.merged ? 'merged' : head.state}`,
      );
      await prHandlerRegistry.markSyncError(snapshot.handlerId, null);
      return;
    }

    // 幂等：状态与 commit 均未变化
    if (
      snapshot.lastSyncedNodeStatus === snapshot.nodeStatus &&
      snapshot.lastWrittenCommitSha === head.sha
    ) {
      return;
    }

    const projection = mapNodeStatusToCheckRun(snapshot.nodeStatus);
    const output = buildOutput(snapshot, projection.label);
    const nowIso = new Date().toISOString();
    const sameCommit = snapshot.lastCheckRunId !== null && snapshot.lastWrittenCommitSha === head.sha;

    let result: { id: number; htmlUrl: string | null };
    if (sameCommit) {
      result = await updateCheckRun(token, target.repo, snapshot.lastCheckRunId as number, {
        status: projection.status,
        conclusion: projection.conclusion,
        completed_at: projection.status === 'completed' ? nowIso : undefined,
        output,
      });
    } else {
      if (snapshot.lastCheckRunId !== null) {
        // 旧提交上的检查项标记过期
        await updateCheckRun(token, target.repo, snapshot.lastCheckRunId, {
          status: 'completed',
          conclusion: 'stale',
          completed_at: nowIso,
        });
      }
      result = await createCheckRun(token, target.repo, {
        name: checkRunName(snapshot.nodeName),
        head_sha: head.sha,
        external_id: `${snapshot.workflowInstanceId}:${snapshot.nodeId}`,
        status: projection.status,
        conclusion: projection.conclusion,
        started_at: nowIso,
        completed_at: projection.status === 'completed' ? nowIso : undefined,
        output,
      });
    }

    await prHandlerRegistry.markCheckRunSynced(snapshot.handlerId, {
      commitSha: head.sha,
      checkRunId: result.id,
      checkRunUrl: result.htmlUrl,
      nodeStatus: snapshot.nodeStatus,
      at: new Date(),
    });
  } catch (err) {
    await recordError(snapshot, err);
  }
}

/**
 * todo panel 同步（永不抛出）。
 * 前置四条件由订阅器判定（工作流会话 / 已绑定 / 已写入过 check-run / type=plan）。
 */
export async function syncTodoPanel(
  snapshot: PrSyncSnapshot,
  entries: TodoEntry[],
): Promise<void> {
  try {
    const checkRunId = snapshot.lastCheckRunId;
    if (!checkRunId) return;

    const text = renderTodoMarkdown(entries);
    const digest = computeTodoDigest(entries);
    if (snapshot.lastTodoDigest === digest) return;

    const now = Date.now();
    const state = getThrottleState(checkRunId);
    const wait = state.lastSentAt + TODO_MIN_INTERVAL_MS - now;
    if (wait > 0) {
      // 窗口内只保留最后一次（尾沿合并）
      state.pending = { snapshot, text, digest };
      if (!state.timer) {
        state.timer = setTimeout(() => {
          state.timer = null;
          const pending = state.pending;
          state.pending = null;
          if (pending) void flushTodo(pending);
        }, wait);
        state.timer.unref?.();
      }
      return;
    }

    await flushTodo({ snapshot, text, digest });
  } catch (err) {
    await recordError(snapshot, err);
  }
}

function getThrottleState(checkRunId: number): TodoThrottleState {
  let state = todoThrottle.get(checkRunId);
  if (!state) {
    state = { lastSentAt: 0, timer: null, pending: null };
    todoThrottle.set(checkRunId, state);
  }
  return state;
}

async function flushTodo(item: {
  snapshot: PrSyncSnapshot;
  text: string;
  digest: string;
}): Promise<void> {
  const { snapshot, text, digest } = item;
  const checkRunId = snapshot.lastCheckRunId;
  if (!checkRunId) return;
  try {
    await syncMutex.runExclusive(snapshot.handlerId, async () => {
      const state = todoThrottle.get(checkRunId);
      if (state) state.lastSentAt = Date.now();

      const target = parsePullRequestTarget(snapshot.pullRequestId);
      const { token } = await githubService.createRepoScopedTokenForUser(
        snapshot.userId,
        target.repo,
      );
      const projection = mapNodeStatusToCheckRun(snapshot.nodeStatus);
      await updateCheckRun(token, target.repo, checkRunId, {
        output: buildOutput(snapshot, projection.label, text),
      });
      await prHandlerRegistry.markTodoSynced(snapshot.handlerId, { digest, at: new Date() });
    });
  } catch (err) {
    await recordError(snapshot, err);
  }
}

/** 解析 `session:message` 的 plan 载荷（SessionUpdate 全对象；上限与截断见上） */
export function parseTodoEntries(content: unknown): TodoEntry[] | null {
  let payload: unknown = content;
  if (typeof content === 'string') {
    try {
      payload = JSON.parse(content);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (record.sessionUpdate !== 'plan') return null;
  const rawEntries = record.entries;
  if (!Array.isArray(rawEntries)) return null;

  const entries: TodoEntry[] = [];
  for (const raw of rawEntries.slice(0, TODO_MAX_ENTRIES)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const text = typeof item.content === 'string' ? item.content : null;
    const status = item.status;
    if (!text || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) {
      continue;
    }
    entries.push({
      content: text.slice(0, TODO_MAX_CONTENT_LENGTH),
      status,
      ...(typeof item.priority === 'string' ? { priority: item.priority } : {}),
    });
  }
  return entries;
}

async function handleNodesTransitioned(
  instance: WorkflowInstanceDoc,
  changes: NodeTransitionChange[],
): Promise<void> {
  // 串行处理，避免同一用户/仓库的 token 铸造与写入风暴
  for (const change of changes) {
    await syncNodeStatus(instance, change.node);
  }
}

/** 引擎注册：节点状态变化 → check-run 同步（fire-and-forget，先于注销 hook） */
export function registerPrCheckRunSyncHooks(): void {
  workflowEngine.registerHooks({
    onNodesTransitioned: (instance, changes) => handleNodesTransitioned(instance, changes),
  });
}
