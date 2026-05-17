const HEARTBEAT_INTERVAL_MS = 30_000;

export class Heartbeat {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  start(sendFn: () => void): void {
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
