/**
 * harness 登录进行中注册表：进程内 Map<controllerId, {requestId, deadlineMs}>。
 *
 * 用途：`AcpOptionsProber` 与 `ACPSessionManager` 的 30s 超时回调查询，
 * 命中时「不结算、重新挂起」，等 agent-gear 在登录结束后上抛真实结果事件再结算。
 *
 * 绝对上限 = required 时刻 + 登录等待上限 + 60s 兜底（防泄漏）。
 */
export interface HarnessLoginPending {
  requestId: string;
  /** 绝对上限时间戳（ms）。超过后超时回调强制结算，避免僵尸挂起。 */
  deadlineMs: number;
}

export class HarnessLoginRegistry {
  private readonly pending = new Map<string, HarnessLoginPending>();

  mark(controllerId: string, requestId: string, deadlineMs: number): void {
    this.pending.set(controllerId, { requestId, deadlineMs });
  }

  pendingFor(controllerId: string): HarnessLoginPending | undefined {
    return this.pending.get(controllerId);
  }

  isPending(controllerId: string): boolean {
    return this.pending.has(controllerId);
  }

  clear(controllerId: string): void {
    this.pending.delete(controllerId);
  }

  clearAll(): void {
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}

export const harnessLoginRegistry = new HarnessLoginRegistry();
