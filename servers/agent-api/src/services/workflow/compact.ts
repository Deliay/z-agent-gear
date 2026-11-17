import { sessionService } from '../session.js';
import { resolveCompactCommand } from '../harness-config.js';
import { logger as rootLogger } from '../../observability/logger.js';
import { INTERRUPT_RETRY_IDLE_TIMEOUT_MS } from './interrupt-retry.js';

const logger = rootLogger.child({ component: 'workflow-compact' });

/**
 * 压缩在途登记（进程内，`sessionId → 兜底释放定时器`）。
 *
 * 压缩回合结束会产生 `promptCompleted → idling`，若不抑制，orchestrator 的空闲停滞检测
 * 会把压缩窗口误判为「节点停滞」并排期中断重试（提案 D1）。登记必须**先于**发送压缩指令；
 * 解除由 `handleSessionIdled` 一次性消费（`consumeCompactInFlight`）完成，兜底定时器
 * 保证异常情况下不会永久抑制（压缩回合始终不结束 / 会话被关闭等）。
 */
const compactInFlight = new Map<string, ReturnType<typeof setTimeout>>();

/** 指定会话是否处于压缩回合中（停滞检测前置抑制；仅观测，不消费） */
export function isCompactInFlight(sessionId: string): boolean {
  return compactInFlight.has(sessionId);
}

/**
 * 一次性消费压缩回合的抑制标记（供 `promptCompleted → idling` 的停滞检测使用）。
 * 命中即解除登记并返回 `true`；后续回合的空闲通知恢复既有停滞检测行为。
 */
export function consumeCompactInFlight(sessionId: string): boolean {
  const timer = compactInFlight.get(sessionId);
  if (timer === undefined) return false;
  clearTimeout(timer);
  compactInFlight.delete(sessionId);
  return true;
}

/** 清理全部登记（仅测试与进程退出使用） */
export function clearCompactInFlight(): void {
  for (const timer of compactInFlight.values()) clearTimeout(timer);
  compactInFlight.clear();
}

function registerCompactInFlight(sessionId: string, timeoutMs: number): void {
  const existing = compactInFlight.get(sessionId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    compactInFlight.delete(sessionId);
    logger.warn(
      { event: 'compact-suppression-expired', sessionId },
      'compact idle suppression expired without consuming an idle turn',
    );
  }, timeoutMs);
  timer.unref?.();
  compactInFlight.set(sessionId, timer);
}

function releaseCompactInFlight(sessionId: string): void {
  const timer = compactInFlight.get(sessionId);
  if (timer) clearTimeout(timer);
  compactInFlight.delete(sessionId);
}

/**
 * 压缩管线（第一个发送动作）：发送压缩指令并立即返回，**不等待压缩回合空闲**。
 *
 * 调用方在返回后必须立即发送后续提示词（第二个发送动作）——两个独立的会话输入消息，
 * 由 harness 侧输入队列保证「先压缩、后提示词」的执行顺序。等待压缩回合 idling 会在
 * 压缩回合迟迟不结束时空转（会话表现为卡住），因此不再阻塞。
 *
 * 返回 `false` 仅表示压缩指令发送失败（调用方降级照发提示词）；不代表压缩是否成功。
 *
 * 循环依赖约束：本模块不 import orchestrator（同 node-config.ts）。
 */
export async function runCompactPipeline(
  sessionId: string,
  acpServerType: string,
  timeoutMs: number = INTERRUPT_RETRY_IDLE_TIMEOUT_MS,
): Promise<boolean> {
  const command = await resolveCompactCommand(acpServerType);
  // 顺序硬约束：登记 → 发送压缩指令（抑制压缩回合结束时的停滞检测误判）
  registerCompactInFlight(sessionId, timeoutMs);
  try {
    await sessionService.addMessage(sessionId, {
      direction: 'input',
      type: 'text',
      content: command,
    });
    return true;
  } catch (err) {
    releaseCompactInFlight(sessionId);
    logger.warn({ event: 'compact-failed', sessionId, command, err }, 'compact command dispatch failed');
    return false;
  }
}
