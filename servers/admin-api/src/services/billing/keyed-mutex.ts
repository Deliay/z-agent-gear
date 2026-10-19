/**
 * 按 key 串行化异步操作（同一 key 的并发调用排队执行）。
 *
 * ⚠️ A11 单实例硬约束：本锁是**进程内** `Map`，不是分布式原语。多副本/多消费者部署下，
 * 同 key（如同一账户 `account:{id}`、同一预留 `reservation:{id}`）的并发不会被跨进程串行化。
 * 因此 admin-api 的计费消费者与 scheduler **必须以单实例运行**（或改用 Mongo 级别的账户锁
 * / 预检令牌落库）。当前部署假设单副本；扩容前必须先落库化互斥与预检。
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

/** 计费域共享互斥：所有 reservation 级操作（就绪/周期/尾结/强拆）共用同一把锁。 */
export const billingMutex = new KeyedMutex();
