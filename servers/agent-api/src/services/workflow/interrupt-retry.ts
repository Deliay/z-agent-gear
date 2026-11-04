import { WorkflowInstance } from '../../models/workflow-instance.js';
import { logger as rootLogger } from '../../observability/logger.js';
import { sessionService } from '../session.js';
import { armSessionIdleWaiter } from '../session-idle-waiter.js';
import { todoService } from '../todo-service.js';
import { isReentrantLockError } from '../keyed-mutex.js';
import { workflowEngine, type WorkflowInstanceDoc, type WorkflowNodeDoc } from './engine.js';
import { initialModeModel, loadNodeConfig } from './node-config.js';
import { FALLBACK_PROMPT, IDLE_NUDGE_PROMPT } from './prompts.js';

const logger = rootLogger.child({ component: 'workflow-interrupt-retry' });

/** 中断来源：ENDED=会话结束（resume 后重发兜底提示词）/ IDLED=turn 结束空闲（重发停滞提醒） */
export type InterruptionTrigger = 'ENDED' | 'IDLED';

/** 自动重试次数上限（PRD 4.1：最多 10 次，约 2 小时窗口） */
export const INTERRUPT_RETRY_MAX = 10;

/** 单次重试「等待会话空闲」的截止时间（5 分钟） */
export const INTERRUPT_RETRY_IDLE_TIMEOUT_MS = 5 * 60_000;

/** 退避封顶（分钟） */
const INTERRUPT_RETRY_BACKOFF_CAP_MINUTES = 30;

/** 重入锁延迟重试上限（防御性分支，正常链路在实例锁外调用） */
const REENTRANT_RETRY_MAX = 3;
const REENTRANT_RETRY_BASE_MS = 100;

/**
 * 第 N 次重试的延迟：0/1/2/4/8/16/30/30/30/30 分钟。
 * N≤1 → 0（首次立即执行）；N>10 收敛为封顶 30 分钟。
 */
export function interruptRetryDelayMs(retryNo: number): number {
  if (!Number.isFinite(retryNo) || retryNo <= 1) return 0;
  const normalized = Math.min(Math.trunc(retryNo), INTERRUPT_RETRY_MAX);
  return Math.min(2 ** (normalized - 2), INTERRUPT_RETRY_BACKOFF_CAP_MINUTES) * 60_000;
}

function triggerOf(node: WorkflowNodeDoc): InterruptionTrigger {
  return node.retryTrigger === 'IDLED' ? 'IDLED' : 'ENDED';
}

/**
 * 排期一次中断重试（字段级 CAS）。
 *
 * - `expectedPhase`：首次中断传 `null`（节点无 retryPhase），本次重试失败重排传 `'RECONNECTING'`；
 * - CAS 同时锁定 `retryCount` 快照：人工 restart/rework 复位后自然放弃，避免竞态覆盖；
 * - `retryCount` 已达上限 → 直接 `retryExhausted` + 人工介入待办；
 * - 首次排期（delay=0）通过 `runOutsideTransitionLock` 立即执行，不另设内存定时器。
 */
export async function scheduleInterruptionRetry(args: {
  instanceId: string;
  nodeId: string;
  /** 绑定的节点会话 id；`null` = 会话已丢失（按计划「计为本次失败」消耗一次重试预算） */
  sessionId: string | null;
  trigger: InterruptionTrigger;
  expectedPhase?: null | 'RECONNECTING';
}): Promise<'scheduled' | 'exhausted' | 'skipped'> {
  const { instanceId, nodeId, sessionId, trigger } = args;
  const expectedPhase = args.expectedPhase ?? null;

  const instance = (await WorkflowInstance.findById(instanceId).lean()) as unknown as WorkflowInstanceDoc | null;
  if (!instance || instance.deletedAt) return 'skipped';
  const node = instance.nodes.find((item) => item.nodeId === nodeId);
  if (!node) return 'skipped';
  const nodeSessionId = node.sessionId ? node.sessionId.toString() : null;
  if (nodeSessionId !== sessionId) return 'skipped';
  if (node.status !== 'RUNNING' && node.status !== 'REWORK') return 'skipped';
  if (expectedPhase === 'RECONNECTING' && node.retryPhase !== 'RECONNECTING') return 'skipped';

  const currentCount = node.retryCount ?? 0;
  if (currentCount >= INTERRUPT_RETRY_MAX) {
    await exhaustInterruptionRetry({ instanceId, nodeId, sessionId: sessionId ?? '', retryCount: currentCount });
    return 'exhausted';
  }

  const nextCount = currentCount + 1;
  const nextRetryAt = new Date(Date.now() + interruptRetryDelayMs(nextCount));
  const update = await WorkflowInstance.updateOne(
    {
      _id: instanceId,
      deletedAt: null,
      nodes: {
        $elemMatch: {
          nodeId,
          // null 同时匹配「会话字段缺失/为 null」的节点（会话已丢失的失败重排）
          sessionId: sessionId ?? null,
          status: { $in: ['RUNNING', 'REWORK'] },
          // null 同时匹配「字段为 null」与「字段缺失」的旧实例
          retryPhase: expectedPhase,
          // retryCount 快照（缺失按 0 处理，兼容未跑迁移的实例）
          retryCount: currentCount === 0 ? { $in: [0, null] } : currentCount,
        },
      },
    },
    {
      $set: {
        'nodes.$.retryCount': nextCount,
        'nodes.$.nextRetryAt': nextRetryAt,
        'nodes.$.retryPhase': 'SCHEDULED',
        'nodes.$.retryTrigger': trigger,
        'nodes.$.retryDeadlineAt': null,
      },
    },
  );
  if (!update?.modifiedCount) {
    logger.info({ event: 'retry-schedule-skipped', instanceId, nodeId, sessionId, expectedPhase }, 'interrupt retry schedule skipped by CAS');
    return 'skipped';
  }

  logger.info(
    { event: 'retry-scheduled', instanceId, nodeId, sessionId, retryCount: nextCount, delayMs: interruptRetryDelayMs(nextCount), trigger },
    'interrupt retry scheduled',
  );

  if (nextCount === 1) {
    // D8：首次立即执行；nextRetryAt 已落库，进程崩溃后扫描器仍会拾起
    void workflowEngine
      .runOutsideTransitionLock(instanceId, () => executeScheduledRetry(instanceId, nodeId))
      .catch((err) => {
        logger.warn({ event: 'retry-immediate-failed', instanceId, nodeId, err }, 'immediate interrupt retry failed');
      });
  }

  return 'scheduled';
}

/**
 * 执行一次已到期的重试（调度器与「首次立即」共用）。
 *
 * 管线：占位（SCHEDULED→RECONNECTING）→ 按需 close → 布防等待器 → resume → 等空闲
 * → 发送前双校验 → 重发提示词 → 清理调度字段（保留 retryCount）。
 */
export async function executeScheduledRetry(instanceId: string, nodeId: string): Promise<void> {
  const now = new Date();
  const claimed = await WorkflowInstance.updateOne(
    {
      _id: instanceId,
      deletedAt: null,
      nodes: {
        $elemMatch: {
          nodeId,
          status: { $in: ['RUNNING', 'REWORK'] },
          retryPhase: 'SCHEDULED',
          nextRetryAt: { $lte: now },
        },
      },
    },
    {
      $set: {
        'nodes.$.retryPhase': 'RECONNECTING',
        'nodes.$.retryDeadlineAt': new Date(now.getTime() + INTERRUPT_RETRY_IDLE_TIMEOUT_MS),
      },
    },
  );
  if (!claimed?.modifiedCount) return; // 单赢家

  const instance = (await WorkflowInstance.findById(instanceId).lean()) as unknown as WorkflowInstanceDoc | null;
  if (!instance || instance.deletedAt) return;
  const node = instance.nodes.find((item) => item.nodeId === nodeId);
  if (!node) return;

  const sessionId = node.sessionId?.toString() ?? null;
  const trigger = triggerOf(node);

  let outcome: RetryOutcome = 'retry';
  if (!sessionId) {
    // 会话已丢失：按实现计划 §5.5 步骤 2 计为本次失败（消耗一次重试预算；重排不需要会话 id）
    logger.info({ event: 'retry-step', step: 'session-missing', instanceId, nodeId }, 'interrupt retry session id missing');
  } else {
    try {
      outcome = await runRetryPipeline(instance, node, sessionId, trigger);
    } catch (err) {
      logger.warn({ event: 'retry-pipeline-failed', instanceId, nodeId, sessionId, err }, 'interrupt retry pipeline failed');
      outcome = 'retry';
    }
  }

  if (outcome === 'success' && sessionId) {
    await clearRetrySchedule(instanceId, nodeId, sessionId);
    logger.info({ event: 'retry-executed', instanceId, nodeId, sessionId, retryCount: node.retryCount ?? 0, trigger }, 'interrupt retry executed');
    return;
  }
  if (outcome === 'abandon') {
    // 人工 restart/rework/删除/节点已推进：不得误发，也不重排
    logger.info({ event: 'retry-abandoned', instanceId, nodeId, sessionId }, 'interrupt retry abandoned after pre-send check');
    return;
  }

  // 失败：从 RECONNECTING 重排（下一档退避）；retryCount 已用尽 → retryExhausted
  const scheduled = await scheduleInterruptionRetry({
    instanceId,
    nodeId,
    sessionId,
    trigger,
    expectedPhase: 'RECONNECTING',
  });
  if (scheduled === 'exhausted') {
    logger.warn({ event: 'retry-exhausted', instanceId, nodeId, sessionId, retryCount: node.retryCount ?? 0 }, 'interrupt retry exhausted');
  } else {
    logger.warn({ event: 'retry-failed', instanceId, nodeId, sessionId, result: scheduled }, 'interrupt retry failed, rescheduled');
  }
}

type RetryOutcome = 'success' | 'retry' | 'abandon';

async function runRetryPipeline(
  instance: WorkflowInstanceDoc,
  node: WorkflowNodeDoc,
  sessionId: string,
  trigger: InterruptionTrigger,
): Promise<RetryOutcome> {
  const userId = instance.userId.toString();

  // 会话文档缺失 → 本次重试失败
  const status = await sessionService.getSessionStatusRaw(sessionId);
  if (!status) {
    logger.info({ event: 'retry-step', step: 'session-missing', sessionId }, 'interrupt retry session doc missing');
    return 'retry';
  }

  // 已 ended/disconnected 则跳过 close（PRD 3.2.2）
  if (status !== 'ended' && status !== 'disconnected') {
    await sessionService.close(sessionId, userId, {
      suppressFallback: true,
      reason: 'workflow_interruption_retry',
    });
  }

  // 必须在 resume 之前布防：覆盖 close 侧 ended 与事件早到
  const waiter = armSessionIdleWaiter(sessionId, INTERRUPT_RETRY_IDLE_TIMEOUT_MS);

  // 配置读取失败不阻断（沿用现口径）
  let initial: { modeId?: string; modelId?: string } | undefined;
  try {
    const configuredNode = await loadNodeConfig(instance, node);
    initial = initialModeModel(configuredNode.agentConfig);
  } catch {
    /* ignore — retry must not be blocked by config lookup */
  }

  let resumed: { success: boolean; status: string; error?: string };
  try {
    resumed = await sessionService.resume(sessionId, userId, initial);
  } catch (err) {
    waiter.cancel();
    logger.warn({ event: 'retry-resume-threw', sessionId, err }, 'resume threw during interrupt retry');
    return 'retry';
  }
  logger.info(
    { event: 'retry-step', step: 'resumed', sessionId, before: status, success: resumed.success, resumeStatus: resumed.status, error: resumed.error },
    'interrupt retry resume issued',
  );
  if (!resumed.success) {
    waiter.cancel();
    logger.info({ event: 'retry-step', step: 'resume-failed', sessionId, status: resumed.status, error: resumed.error }, 'interrupt retry resume failed');
    return 'retry';
  }

  const idle = await waiter.promise;
  if (!idle) {
    logger.info({ event: 'retry-step', step: 'idle-timeout', sessionId }, 'interrupt retry wait idle failed');
    return 'retry';
  }

  // 发送前双校验：实例未删除 + 节点仍 RUNNING/REWORK + sessionId 未变 + 仍在 RECONNECTING
  const fresh = (await WorkflowInstance.findById(instance._id).lean()) as unknown as WorkflowInstanceDoc | null;
  if (!fresh || fresh.deletedAt) return 'abandon';
  const freshNode = fresh.nodes.find((item) => item.nodeId === node.nodeId);
  if (!freshNode) return 'abandon';
  if (freshNode.status !== 'RUNNING' && freshNode.status !== 'REWORK') return 'abandon';
  if (freshNode.sessionId?.toString() !== sessionId) return 'abandon';
  if (freshNode.retryPhase !== 'RECONNECTING') {
    logger.info({ event: 'retry-step', step: 'phase-changed', sessionId, phase: freshNode.retryPhase }, 'interrupt retry phase changed');
    return 'abandon';
  }

  await sessionService.addMessage(sessionId, {
    direction: 'input',
    type: 'text',
    content: trigger === 'IDLED' ? IDLE_NUDGE_PROMPT : FALLBACK_PROMPT,
  });
  return 'success';
}

async function clearRetrySchedule(instanceId: string, nodeId: string, sessionId: string): Promise<void> {
  await WorkflowInstance.updateOne(
    {
      _id: instanceId,
      nodes: { $elemMatch: { nodeId, sessionId, retryPhase: 'RECONNECTING' } },
    },
    {
      $set: {
        'nodes.$.retryPhase': null,
        'nodes.$.nextRetryAt': null,
        'nodes.$.retryDeadlineAt': null,
        'nodes.$.retryTrigger': null,
      },
    },
  );
  // 保留 retryCount（D1：成功发送提示词不复位，防止「提示词无效→再次中断→计数归零」死循环）
}

/**
 * 重试用尽：`retryExhausted` 转移 + 人工介入待办。
 * 转移可能在实例锁上下文内被调用：遇 re-entrant 锁错按同一退避预算延迟重试（D4）。
 */
export async function exhaustInterruptionRetry(args: {
  instanceId: string;
  nodeId: string;
  sessionId: string;
  retryCount: number;
  attempt?: number;
}): Promise<void> {
  const { instanceId, nodeId, sessionId, retryCount } = args;
  const attempt = args.attempt ?? 0;
  try {
    await workflowEngine.transition(instanceId, nodeId, 'retryExhausted', {
      reason: `中断自动重试 ${retryCount} 次仍未推进，需要人工介入`,
    });
  } catch (err) {
    if (isReentrantLockError(err)) {
      if (attempt >= REENTRANT_RETRY_MAX) {
        logger.warn({ event: 'retry-exhausted-deferred-exhausted', instanceId, nodeId, attempt }, 'retryExhausted deferred retry exhausted');
        return;
      }
      const delay = REENTRANT_RETRY_BASE_MS * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return exhaustInterruptionRetry({ ...args, attempt: attempt + 1 });
    }
    logger.warn({ event: 'retry-exhausted-transition-failed', instanceId, nodeId, err }, 'retryExhausted transition failed');
    return;
  }

  try {
    const instance = (await WorkflowInstance.findById(instanceId).lean()) as unknown as
      | (WorkflowInstanceDoc & { name: string })
      | null;
    const node = instance?.nodes.find((item) => item.nodeId === nodeId);
    if (!instance || !node) {
      logger.warn({ event: 'retry-exhausted-todo-skipped', instanceId, nodeId }, 'retry exhausted todo skipped: instance/node missing');
      return;
    }
    await todoService.createWorkflowInterventionTodo({
      userId: instance.userId.toString(),
      instanceId,
      instanceName: instance.name,
      nodeId,
      nodeName: node.name,
      sessionId,
      reason: `中断自动重试 ${retryCount} 次仍未推进，需要人工介入`,
    });
  } catch (err) {
    logger.warn({ event: 'retry-exhausted-todo-failed', instanceId, nodeId, err }, 'retry exhausted todo failed');
  }
}
