/**
 * 心跳计时器：记录每个容器最近一次心跳时间，按「每 intervalMs 一次、
 * 连续 maxMisses 次缺失」判定离线。时间参数显式传入以便确定性测试。
 */
export class HeartbeatTracker {
  private readonly lastSeen = new Map<string, number>();

  constructor(
    private readonly intervalMs: number = 30000,
    private readonly maxMisses: number = 3,
  ) {}

  get interval(): number {
    return this.intervalMs;
  }

  get maxMissesAllowed(): number {
    return this.maxMisses;
  }

  record(containerId: string, now: number = Date.now()): void {
    this.lastSeen.set(containerId, now);
  }

  remove(containerId: string): void {
    this.lastSeen.delete(containerId);
  }

  has(containerId: string): boolean {
    return this.lastSeen.has(containerId);
  }

  lastSeenAt(containerId: string): number | undefined {
    return this.lastSeen.get(containerId);
  }

  isStale(containerId: string, now: number = Date.now()): boolean {
    const seen = this.lastSeen.get(containerId);
    if (seen === undefined) return false;
    return Math.floor((now - seen) / this.intervalMs) >= this.maxMisses;
  }

  /** 返回所有已判定离线的 containerId。 */
  check(now: number = Date.now()): string[] {
    return [...this.lastSeen.keys()].filter((id) => this.isStale(id, now));
  }
}
