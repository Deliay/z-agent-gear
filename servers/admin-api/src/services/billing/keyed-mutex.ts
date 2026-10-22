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

/**
 * 账户级共享互斥（A-2/R2-1）：钱包快照的所有读写（freeze/unfreeze/charge/recharge 与对账校准）
 * 共用同一把锁，保证「认领标记 → `$inc`/绝对校准 → 标记 applied」不会与对账校准交错，
 * 避免自愈写与在途增量互相覆盖。与 `billingMutex` 一样是进程内锁（A11 单实例前提）。
 */
export const accountMutex = new KeyedMutex();

/**
 * 云电脑运行 Key 轮换互斥（B-4）：同一 `cloudHostId` 的「铸造新 Key + 撤销旧 active Key」必须
 * 串行执行，否则并发铸造会出现「各自撤销对方」导致全部失效。与其余锁一样是进程内锁（A11 单实例前提）。
 */
export const cloudHostKeyMutex = new KeyedMutex();
