/**
 * 以字符串为 key 的异步互斥锁：同一 key 上的任务串行执行，不同 key 互不阻塞。
 * 用于让同一容器的 `start()` / `destroy()` / 终态回收等生命周期操作不交错。
 */
export class KeyedMutex {
  private readonly chains = new Map<string, Promise<void>>();

  runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const result = previous.then(() => task());
    // 无论任务成功/失败都继续释放锁，避免一个失败卡死后续任务，并防止链无限增长。
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) {
        this.chains.delete(key);
      }
    });
    return result;
  }
}
