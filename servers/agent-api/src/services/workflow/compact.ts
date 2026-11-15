import { sessionService } from '../session.js';
import { armSessionIdleWaiter } from '../session-idle-waiter.js';
import { resolveCompactCommand } from '../harness-config.js';
import { logger as rootLogger } from '../../observability/logger.js';
import { INTERRUPT_RETRY_IDLE_TIMEOUT_MS } from './interrupt-retry.js';

const logger = rootLogger.child({ component: 'workflow-compact' });

/**
 * 压缩在途登记（进程内）。
 *
 * 压缩回合结束会产生 `promptCompleted → idling`，若未抑制，orchestrator 的空闲停滞检测
 * 会把压缩窗口误判为「节点停滞」并排期中断重试（提案 D1）。登记必须**先于**发送压缩指令，
 * 并在等待器结算后取消。
 */
const compactInFlight = new Set<string>();

/** 指定会话是否处于压缩回合中（停滞检测前置抑制） */
export function isCompactInFlight(sessionId: string): boolean {
  return compactInFlight.has(sessionId);
}

/**
 * 压缩管线：发送压缩指令 → 等待压缩回合空闲 → 返回是否成功。
 *
 * 顺序硬约束：登记 → 布防空闲等待器 → 发送压缩指令。
 * 超时/异常/等待器失败 → warn 一次 + 返回 false（调用方照发继续提示词，不阻断）。
 *
 * 循环依赖约束：本模块不 import orchestrator（同 node-config.ts）。
 */
export async function runCompactPipeline(
  sessionId: string,
  acpServerType: string,
  timeoutMs: number = INTERRUPT_RETRY_IDLE_TIMEOUT_MS,
): Promise<boolean> {
  const command = await resolveCompactCommand(acpServerType);
  compactInFlight.add(sessionId);
  let waiter: ReturnType<typeof armSessionIdleWaiter> | null = null;
  try {
    waiter = armSessionIdleWaiter(sessionId, timeoutMs);
    await sessionService.addMessage(sessionId, {
      direction: 'input',
      type: 'text',
      content: command,
    });
    const idled = await waiter.promise;
    if (!idled) {
      logger.warn({ event: 'compact-timeout', sessionId, command }, 'compact pipeline did not reach idle in time');
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ event: 'compact-failed', sessionId, command, err }, 'compact pipeline failed');
    return false;
  } finally {
    waiter?.cancel();
    compactInFlight.delete(sessionId);
  }
}
