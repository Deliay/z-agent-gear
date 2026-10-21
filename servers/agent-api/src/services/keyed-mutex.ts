/**
 * 按 key 串行化异步操作（同一 key 的并发调用排队执行）。
 *
 * 进程内锁，不是分布式原语：agent-api 需以单实例运行才能保证每用户 1 实例上限
 * 与同云电脑停止/删除的串行化（与 admin-api `KeyedMutex` 同口径）。
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(key, tail);
    try {
      await previous.catch(() => undefined);
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
