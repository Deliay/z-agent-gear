import { AsyncLocalStorage } from 'node:async_hooks';

/** 延迟脱离执行默认等待锁释放的上限（超时后结构化报错，避免永久挂起） */
const DEFAULT_DETACH_TIMEOUT_MS = 30_000;

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

  /**
   * 在调用方 AsyncLocalStorage 上下文之外、且**不预取锁**地执行任务（N-8/N-10/N-11）。
   *
   * 用于锁内 hook 派生的延迟回调（setTimeout/setImmediate 会继承 ALS store）：
   * - 等待当前持有者释放（有超时，默认 30s），**不**替任务持有 key；
   * - 任务内部自行调用 `runExclusive`，因此不会自锁/re-entrant；
   * - 无法区分「延迟回调里残留的过期 held 视图」与「持锁任务内误用」，因此不抛
   *   "still holding"，而是统一有界等待：延迟回调形态正常等待后执行；持锁任务内
   *   await 本方法则超时并抛结构化错误，不会永久死锁（N-9/N-11）。
   */
  async runDetached<T>(
    key: string,
    task: () => Promise<T>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_DETACH_TIMEOUT_MS;
    const tail = this.tails.get(key);
    if (tail) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = Symbol('timeout');
      const winner = await Promise.race([
        tail.catch(() => undefined).then(() => 'released' as const),
        new Promise<typeof timedOut>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (winner === timedOut) {
        throw new Error(
          `KeyedMutex.runDetached timed out waiting for key: ${key} after ${timeoutMs}ms ` +
            '(caller may still hold the lock; refusing to deadlock)',
        );
      }
    }
    // exit：不把「key 已持有」视图带给任务的异步链；任务内部自行 runExclusive
    return this.heldKeys.exit(() => task());
  }
}
