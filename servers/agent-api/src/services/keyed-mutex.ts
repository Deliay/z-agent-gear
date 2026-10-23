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
  /** key → 当前持有者 token（用于区分「真的还持有」与「已释放但 ALS 仍残留」） */
  private readonly owners = new Map<string, object>();
  private readonly heldKeys = new AsyncLocalStorage<ReadonlyMap<string, object>>();

  async runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const parentHeld = this.heldKeys.getStore();
    if (parentHeld?.has(key)) {
      throw new Error(`KeyedMutex re-entrant lock detected for key: ${key}`);
    }
    const token = {};
    const held = new Map(parentHeld ?? []);
    held.set(key, token);

    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(key, tail);
    this.owners.set(key, token);
    try {
      await previous.catch(() => undefined);
      return await this.heldKeys.run(held, task);
    } finally {
      release();
      if (this.owners.get(key) === token) this.owners.delete(key);
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }

  /**
   * 在调用方 AsyncLocalStorage 上下文之外、且**不预取锁**地执行任务（N-8/N-9）。
   *
   * 用途：从锁内 hook 派生的延迟回调（setTimeout/setImmediate 会继承 ALS store）中
   * 重新执行完整业务逻辑；任务内部自己调用 `runExclusive`，锁由业务入口正常获取。
   *
   * 语义：
   * - 不会替任务持有 key（与 runExclusive 不同），因此任务内再取同 key 不会 re-entrant/死锁；
   * - 若调用时确实仍持有该 key（同一 holder token），立即抛错而不是挂起等待自己（N-9）；
   * - 若 ALS 中残留过期的 held 视图（延迟回调常见），先等待当前 tail 释放，再在无 store 上下文执行。
   */
  async runDetached<T>(key: string, task: () => Promise<T>): Promise<T> {
    const parentHeld = this.heldKeys.getStore();
    const myToken = parentHeld?.get(key);
    if (myToken && this.owners.get(key) === myToken) {
      throw new Error(
        `KeyedMutex.runDetached called while still holding key: ${key} ` +
          '(would deadlock waiting for itself)',
      );
    }
    const tail = this.tails.get(key);
    if (tail) {
      await tail.catch(() => undefined);
    }
    // exit：不把「key 已持有」视图带给任务的异步链；任务内部自行 runExclusive
    return this.heldKeys.exit(() => task());
  }
}
