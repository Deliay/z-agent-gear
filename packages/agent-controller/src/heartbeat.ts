const HEARTBEAT_INTERVAL_MS = 30_000;

export class Heartbeat {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  start(sendFn: () => void): void {
    // 重连/重复 registered 时不得遗留旧 interval（否则每轮多一个心跳定时器）。
    this.stop();
    this.intervalId = setInterval(() => {
      sendFn();
    }, HEARTBEAT_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
