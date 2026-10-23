import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 按 key 串行化异步操作（同一 key 的并发调用排队执行）。
 *
 * 进程内锁，不是分布式原语：agent-api 需以单实例运行才能保证每用户 1 实例上限
 * 与同云电脑停止/删除的串行化（与 admin-api `KeyedMutex` 同口径）。
 *
 * R2-19：非可重入——同一异步上下文内嵌套 `runExclusive` 同一 key 会立即报错，
 * 而不是永久挂起（cloud-controller 曾出现同型自锁）。
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly heldKeys = new AsyncLocalStorage<ReadonlySet<string>>();

  /**
   * 在调用方 AsyncLocalStorage 上下文之外排队执行（N-4）。
   *
   * `setImmediate/setTimeout` 会继承创建时的 ALS store，直接延迟重试仍会被判定为
   * re-entrant；`exit()` 让新任务不携带「key 已持有」视图，从而在锁释放后正常取锁。
   * 若调用方未持有该 key，则等价于 `runExclusive`。
   */
  async runDetached<T>(key: string, task: () => Promise<T>): Promise<T> {
    const held = this.heldKeys.getStore();
    if (!held?.has(key)) return this.runExclusive(key, task);
    return this.heldKeys.exit(() => this.runExclusive(key, task));
  }

  async runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const parentHeld = this.heldKeys.getStore();
    if (parentHeld?.has(key)) {
      throw new Error(`KeyedMutex re-entrant lock detected for key: ${key}`);
    }
    const held = new Set(parentHeld ?? []);
    held.add(key);

    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(key, tail);
    try {
      await previous.catch(() => undefined);
      return await this.heldKeys.run(held, task);
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
