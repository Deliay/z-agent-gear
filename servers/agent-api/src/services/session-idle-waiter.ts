import { sessionService, type SessionStatusEvent } from './session.js';
/**
 * 会话空闲等待器（中断自动重试管线的「等会话可用」判据）。
 *
 * 背景（F9/F10/F11）：
 * - `resume` 成功路径发布裸 `idling`（不带 `promptCompleted`），失败路径发布 `ended + error`；
 * - 控制器离线时 `acp:resume` 直接发布 `ended + error='CONTROLLER_OFFLINE'`，不经过 `connecting`；
 * - 我们主动 `close` 也会引起一次 `ended`（无 error），它会晚于/早于 `resume` 到达。
 *
 * 因此判据不能是「看到 ended 就失败」：
 * - `idling` → 以 DB 复核一次后成功；
 * - `ended + error` → 立即失败（控制器离线 / resume 失败）；
 * - `ended`（无 error）且已见过 `connecting`/`running` → 本次重试失败；
 * - `ended`（无 error）且未见过 connecting → 视为 close 引起的噪音，忽略；
 * - `removed` → 失败。
 *
 * pub/sub 至多一次，事件可能丢失：15s DB 心跳兜底（idling→成功，ended/缺失→失败）。
 * 总截止时间由调用方给定（重试管线固定 5 分钟）。
 */

export const SESSION_IDLE_HEARTBEAT_MS = 15_000;

interface IdleWaiter {
  sessionId: string;
  sawConnecting: boolean;
  settled: boolean;
  resolve: (value: boolean) => void;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

const waiters = new Map<string, IdleWaiter>();
let unsubscribeStatus: (() => void) | null = null;

function ensureStatusListener(): void {
  if (unsubscribeStatus) return;
  unsubscribeStatus = sessionService.onSessionStatus((event) => {
    handleSessionStatus(event);
  });
}

function releaseStatusListenerIfIdle(): void {
  if (waiters.size === 0 && unsubscribeStatus) {
    unsubscribeStatus();
    unsubscribeStatus = null;
  }
}

function settle(waiter: IdleWaiter, value: boolean): void {
  if (waiter.settled) return;
  waiter.settled = true;
  if (waiter.timeoutTimer) clearTimeout(waiter.timeoutTimer);
  if (waiter.heartbeatTimer) clearInterval(waiter.heartbeatTimer);
  if (waiters.get(waiter.sessionId) === waiter) {
    waiters.delete(waiter.sessionId);
  }
  waiter.resolve(value);
  releaseStatusListenerIfIdle();
}

function handleSessionStatus(event: SessionStatusEvent): void {
  const waiter = waiters.get(event.sessionId);
  if (!waiter || waiter.settled) return;

  if (event.status === 'removed') {
    settle(waiter, false);
    return;
  }
  if (event.status === 'idling') {
    // 防「上一轮残留 idling」误判：以 DB 会话状态复核一次
    void sessionService
      .getSessionStatusRaw(event.sessionId)
      .then((status) => {
        if (status === 'idling') settle(waiter, true);
      })
      .catch(() => undefined);
    return;
  }
  if (event.status === 'ended') {
    if (event.error) {
      settle(waiter, false);
      return;
    }
    if (waiter.sawConnecting) {
      settle(waiter, false);
    }
    // close 引起的 ended：忽略
    return;
  }
  if (event.status === 'connecting' || event.status === 'running') {
    waiter.sawConnecting = true;
  }
}

/**
 * 布防一个一次性空闲等待器。必须在 `resume` **之前**调用，以覆盖 close 侧 ended 与事件早到。
 */
export function armSessionIdleWaiter(
  sessionId: string,
  timeoutMs: number,
  options: { heartbeatMs?: number } = {},
): { promise: Promise<boolean>; cancel: () => void } {
  // 同会话重复布防：先取消旧 waiter（避免遗留定时器与双 settle）
  const existing = waiters.get(sessionId);
  if (existing && !existing.settled) {
    existing.settled = true;
    if (existing.timeoutTimer) clearTimeout(existing.timeoutTimer);
    if (existing.heartbeatTimer) clearInterval(existing.heartbeatTimer);
    waiters.delete(sessionId);
  }

  let resolveFn!: (value: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    resolveFn = resolve;
  });

  const heartbeatMs = options.heartbeatMs ?? SESSION_IDLE_HEARTBEAT_MS;
  const waiter: IdleWaiter = {
    sessionId,
    sawConnecting: false,
    settled: false,
    resolve: resolveFn,
    timeoutTimer: null,
    heartbeatTimer: null,
  };

  waiter.timeoutTimer = setTimeout(() => settle(waiter, false), timeoutMs);
  waiter.timeoutTimer.unref?.();
  waiter.heartbeatTimer = setInterval(() => {
    if (waiter.settled) return;
    void sessionService
      .getSessionStatusRaw(sessionId)
      .then((status) => {
        if (status === 'idling') {
          settle(waiter, true);
          return;
        }
        if (!status || status === 'ended' || status === 'removed' || status === 'disconnected') {
          settle(waiter, false);
        }
      })
      .catch(() => undefined);
  }, heartbeatMs);
  waiter.heartbeatTimer.unref?.();

  waiters.set(sessionId, waiter);
  ensureStatusListener();

  return {
    promise,
    cancel: () => {
      if (waiter.settled) return;
      waiter.settled = true;
      if (waiter.timeoutTimer) clearTimeout(waiter.timeoutTimer);
      if (waiter.heartbeatTimer) clearInterval(waiter.heartbeatTimer);
      if (waiters.get(sessionId) === waiter) {
        waiters.delete(sessionId);
      }
      releaseStatusListenerIfIdle();
    },
  };
}

/** 清理全部等待器（仅测试与进程退出使用） */
export function clearAllSessionIdleWaiters(): void {
  for (const waiter of [...waiters.values()]) {
    waiter.settled = true;
    if (waiter.timeoutTimer) clearTimeout(waiter.timeoutTimer);
    if (waiter.heartbeatTimer) clearInterval(waiter.heartbeatTimer);
  }
  waiters.clear();
  releaseStatusListenerIfIdle();
}

