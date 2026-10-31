import { WorkflowInstance } from '../../models/workflow-instance.js';
import { logger as rootLogger } from '../../observability/logger.js';
import { withSpan } from '../../observability/trace.js';
import type { EventCallbackPayload } from './pr-event-payload.js';
import {
  normalizePullRequestId,
  prHandlerRegistry,
  type PullRequestIdError,
} from './pr-handler-registry.js';
import { workflowInstanceService } from './instance.js';
import { KeyedMutex } from '../keyed-mutex.js';
import { runWithWorkspace } from '../workspace-context.js';
import { workspaceService } from '../workspace-service.js';
import {
  buildReviewPassedPrompt,
  buildReviewRejectedPrompt,
  GITHUB_PR_REVIEW_PROMPT_KEY,
} from './pr-prompts.js';

const logger = rootLogger.child({ component: 'pr-event-handler' });

/** 忽略原因（与 contracts/event-callback.openapi.yaml 一致） */
export type EventIgnoreReason =
  | 'NO_HANDLER'
  | 'INSTANCE_NOT_FOUND'
  | 'INSTANCE_DELETED'
  | 'INSTANCE_ARCHIVED'
  | 'INSTANCE_FINISHED'
  | 'NODE_NOT_FOUND'
  | 'CURRENT_NODE_NOT_HUMAN'
  | 'CURRENT_NODE_AMBIGUOUS'
  | 'LINK_BROKEN'
  | 'HUMAN_NODE_IN_BETWEEN'
  | 'DUPLICATE_EVENT'
  | 'UNSUPPORTED_REVIEW_STATE'
  | 'HANDLER_FAILED';

export type EventAction = 'COMPLETE_HUMAN_NODE' | 'REJECT_HUMAN_NODE';

export interface EventResult {
  workflowInstanceId?: string;
  /** 当前人类节点（若已判定）；未判定时为登记的 AI 节点 */
  nodeId?: string;
  nodeName?: string;
  /** PR 登记节点 ID（失败分支也能据响应定位坏登记） */
  registeredNodeId?: string;
  action?: EventAction;
  promptKey?: string;
  reason?: EventIgnoreReason;
}

export interface EventHandleResponse {
  handled: boolean;
  reason?: EventIgnoreReason;
  results: EventResult[];
}

interface NodeLike {
  nodeId: string;
  name: string;
  type: string;
  status: string;
  dependsOn?: string[];
}

interface InstanceLike {
  _id: { toString(): string };
  userId: { toString(): string };
  /** 租户工作区（多租户二期）；事件回调无 ALS 上下文，须据此构造系统上下文 */
  resourceWorkspaceId?: { toString(): string } | null;
  nodes: NodeLike[];
  deletedAt?: Date | null;
  archivedAt?: Date | null;
  finishedAt?: Date | null;
}

interface HandlerLike {
  _id: unknown;
  workflowInstanceId: unknown;
  nodeId: string;
  prUrl?: string | null;
  lastEventId?: string | null;
}

const REVIEW_REJECT_STATES = new Set(['changes_requested', 'rejected', 'dismissed']);

// 进程内按实例串行化（非可重入：持锁函数内不得再取同 key）
const instanceMutex = new KeyedMutex();

/** 祖先集合（不含自身） */
function ancestorsOf(nodes: NodeLike[], nodeId: string): Set<string> {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const result = new Set<string>();
  const stack = [...(byId.get(nodeId)?.dependsOn ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (result.has(id) || !byId.has(id)) continue;
    result.add(id);
    stack.push(...(byId.get(id)?.dependsOn ?? []));
  }
  return result;
}

/** 后代集合（不含自身） */
function descendantsOf(nodes: NodeLike[], nodeId: string): Set<string> {
  const result = new Set<string>();
  const stack = [nodeId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const node of nodes) {
      if ((node.dependsOn ?? []).includes(id) && !result.has(node.nodeId)) {
        result.add(node.nodeId);
        stack.push(node.nodeId);
      }
    }
  }
  return result;
}

/** 当前节点判定：READY/RUNNING 唯一且为 HUMAN */
function resolveCurrentHumanNode(nodes: NodeLike[]):
  | { node: NodeLike }
  | { reason: EventIgnoreReason } {
  const candidates = nodes.filter((n) => n.status === 'READY' || n.status === 'RUNNING');
  if (candidates.length > 1) return { reason: 'CURRENT_NODE_AMBIGUOUS' };
  const node = candidates[0];
  if (!node || node.type !== 'HUMAN') return { reason: 'CURRENT_NODE_NOT_HUMAN' };
  return { node };
}

/** 联动链路判定：登记节点必须是当前人类节点的上游 AI，且中间无其他 HUMAN */
function checkLink(nodes: NodeLike[], currentNode: NodeLike, registeredNodeId: string):
  | { ok: true }
  | { reason: EventIgnoreReason } {
  const registered = nodes.find((n) => n.nodeId === registeredNodeId);
  if (!registered) return { reason: 'NODE_NOT_FOUND' };
  const ancestors = ancestorsOf(nodes, currentNode.nodeId);
  if (registered.type !== 'AI' || !ancestors.has(registered.nodeId)) {
    return { reason: 'LINK_BROKEN' };
  }
  const descendants = descendantsOf(nodes, registered.nodeId);
  const between = [...ancestors].filter((id) => descendants.has(id));
  const humanInBetween = between.some(
    (id) => nodes.find((n) => n.nodeId === id)?.type === 'HUMAN',
  );
  return humanInBetween ? { reason: 'HUMAN_NODE_IN_BETWEEN' } : { ok: true };
}

async function unregister(instanceId: string, reason: 'ARCHIVED' | 'DELETED' | 'WORKFLOW_FINISHED') {
  try {
    await prHandlerRegistry.unregisterByInstance(instanceId, reason);
  } catch (err) {
    logger.warn({ event: 'unregister-failed', err }, 'unregister failed');
  }
}

async function processHandler(
  snapshot: HandlerLike,
  event: EventCallbackPayload,
): Promise<EventResult> {
  const instanceId = String(snapshot.workflowInstanceId);
  const base: EventResult = {
    workflowInstanceId: instanceId,
    nodeId: snapshot.nodeId,
    registeredNodeId: snapshot.nodeId,
  };

  // R-8：入口快照在实例锁之外读取，锁内必须重读登记行后再判重，
  // 否则并发重复投递会双双看到 lastEventId=null，绕过幂等并以 HANDLER_FAILED 收场。
  const fresh = await prHandlerRegistry.findById(String(snapshot._id));
  if (!fresh) {
    return { ...base, reason: 'NO_HANDLER' };
  }
  const handler = fresh as unknown as HandlerLike;

  const instance = (await WorkflowInstance.findById(instanceId).lean()) as unknown as InstanceLike | null;
  if (!instance) {
    await unregister(instanceId, 'DELETED');
    return { ...base, reason: 'INSTANCE_NOT_FOUND' };
  }
  if (instance.deletedAt) {
    await unregister(instanceId, 'DELETED');
    return { ...base, reason: 'INSTANCE_DELETED' };
  }
  if (instance.archivedAt) {
    await unregister(instanceId, 'ARCHIVED');
    return { ...base, reason: 'INSTANCE_ARCHIVED' };
  }
  const allDone = instance.nodes.length > 0 && instance.nodes.every((n) => n.status === 'DONE');
  if (instance.finishedAt || allDone) {
    await unregister(instanceId, 'WORKFLOW_FINISHED');
    return { ...base, reason: 'INSTANCE_FINISHED' };
  }

  if (handler.lastEventId && handler.lastEventId === event.eventId) {
    return { ...base, reason: 'DUPLICATE_EVENT' };
  }

  const current = resolveCurrentHumanNode(instance.nodes);
  if ('reason' in current) return { ...base, reason: current.reason };
  const human = current.node;
  base.nodeId = human.nodeId;
  base.nodeName = human.name;

  const link = checkLink(instance.nodes, human, handler.nodeId);
  if ('reason' in link) return { ...base, reason: link.reason };

  const review = event.payload.reviewState;
  const userId = instance.userId.toString();
  // 事件回调是系统链路（无 ALS 上下文）：按实例所属工作区构造上下文，
  // 否则团队租户 tenantId != userId 时 completeHumanNode/rejectNode 会被注入
  // `tenantId = userId` 而判定「实例不存在」。
  const workspace = instance.resourceWorkspaceId
    ? await workspaceService.systemWorkspaceContext(String(instance.resourceWorkspaceId))
    : undefined;

  if (review === 'approved') {
    await runWithWorkspace(workspace, async () => {
      await workflowInstanceService.setSystemAdditionalPrompt(
        instanceId,
        GITHUB_PR_REVIEW_PROMPT_KEY,
        buildReviewPassedPrompt({
          comment: event.payload.comment,
          // C-4：优先使用登记时的可信 prUrl，事件载荷仅作回退
          prUrl: handler.prUrl || event.payload.prUrl,
          reviewer: event.payload.reviewer,
          submittedAt: event.payload.submittedAt ?? event.occurredAt,
        }),
      );
      try {
        await workflowInstanceService.completeHumanNode(userId, instanceId, human.nodeId);
      } catch (err) {
        // C-3：流转失败时回滚已写入的系统提示词，避免留下与新状态不一致的脏 prompt
        await workflowInstanceService
          .removeSystemAdditionalPrompt(instanceId, GITHUB_PR_REVIEW_PROMPT_KEY)
          .catch((rollbackErr) => {
            logger.warn(
              { event: 'rollback-prompt-failed', err: rollbackErr },
              'rollback github-pr-review prompt failed',
            );
          });
        throw err;
      }
    });
    // C-3：幂等位写入失败不影响已完成的流转（响应仍回报真实动作，仅告警）
    await prHandlerRegistry
      .markEventHandled(String(handler._id), event.eventId, new Date())
      .catch((err) => {
        logger.warn({ event: 'mark-event-handled-failed', err }, 'markEventHandled failed');
      });
    return {
      ...base,
      action: 'COMPLETE_HUMAN_NODE',
      promptKey: GITHUB_PR_REVIEW_PROMPT_KEY,
    };
  }

  if (REVIEW_REJECT_STATES.has(review)) {
    await runWithWorkspace(workspace, () =>
      workflowInstanceService.rejectNode(
        userId,
        instanceId,
        human.nodeId,
        buildReviewRejectedPrompt({
          comment: event.payload.comment,
          prUrl: handler.prUrl || event.payload.prUrl,
          reviewer: event.payload.reviewer,
          submittedAt: event.payload.submittedAt ?? event.occurredAt,
        }),
      ),
    );
    await prHandlerRegistry
      .markEventHandled(String(handler._id), event.eventId, new Date())
      .catch((err) => {
        logger.warn({ event: 'mark-event-handled-failed', err }, 'markEventHandled failed');
      });
    return { ...base, action: 'REJECT_HUMAN_NODE' };
  }

  return { ...base, reason: 'UNSUPPORTED_REVIEW_STATE' };
}

/** 事件入口：判定链 + per-instance 串行化；任何分支都不抛 500 */
export async function handlePullRequestEvent(
  event: EventCallbackPayload,
): Promise<EventHandleResponse> {
  return withSpan(
    'pr-event handle',
    {
      eventId: event.eventId,
      'pull_request.id': event.payload?.pullRequestId ?? null,
    },
    () => handlePullRequestEventInner(event),
  );
}

async function handlePullRequestEventInner(
  event: EventCallbackPayload,
): Promise<EventHandleResponse> {
  let pullRequestId: string;
  try {
    pullRequestId = normalizePullRequestId(event.payload.pullRequestId).pullRequestId;
  } catch (err) {
    // 非法 PR 标识按未登记处理（载荷已通过类型校验）
    if ((err as PullRequestIdError).code === 'INVALID_PULL_REQUEST_ID') {
      return { handled: false, reason: 'NO_HANDLER', results: [] };
    }
    throw err;
  }

  const handlers = (await prHandlerRegistry.findByPullRequestId(
    pullRequestId,
  )) as unknown as HandlerLike[];
  if (handlers.length === 0) {
    return { handled: false, reason: 'NO_HANDLER', results: [] };
  }

  const results: EventResult[] = [];
  for (const handler of handlers) {
    const instanceId = String(handler.workflowInstanceId);
    try {
      const result = await instanceMutex.runExclusive(instanceId, () =>
        processHandler(handler, event),
      );
      results.push(result);
    } catch (err) {
      logger.warn(
        { event: 'handler-failed', instanceId, nodeId: handler.nodeId, err },
        'PR event handler failed',
      );
      results.push({
        workflowInstanceId: instanceId,
        nodeId: handler.nodeId,
        registeredNodeId: handler.nodeId,
        reason: 'HANDLER_FAILED',
      });
    }
  }

  const handled = results.some((r) => Boolean(r.action));
  return {
    handled,
    ...(handled ? {} : { reason: results[0]?.reason ?? 'NO_HANDLER' }),
    results,
  };
}
