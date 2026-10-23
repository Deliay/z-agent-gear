import { describe, it, expect } from 'vitest';
import { KeyedMutex } from './keyed-mutex.js';

describe('KeyedMutex', () => {
  it('serializes tasks sharing the same key', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];

    const first = mutex.runExclusive('k', async () => {
      events.push('first:start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push('first:end');
    });
    const second = mutex.runExclusive('k', async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('runs different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];

    await Promise.all([
      mutex.runExclusive('a', async () => {
        events.push('a:start');
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push('a:end');
      }),
      mutex.runExclusive('b', async () => {
        events.push('b:start');
        events.push('b:end');
      }),
    ]);

    expect(events).toContain('b:start');
    expect(events.indexOf('b:start')).toBeLessThan(events.indexOf('a:end'));
  });

  it('releases the key when a task throws', async () => {
    const mutex = new KeyedMutex();

    await expect(
      mutex.runExclusive('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(mutex.runExclusive('k', async () => 'ok')).resolves.toBe('ok');
  });

  it('N-8: runDetached 只逃逸 ALS、不预取锁，任务内可正常 runExclusive 同 key', async () => {
    const mutex = new KeyedMutex();
    let scheduled!: Promise<string>;

    await mutex.runExclusive('k', async () => {
      scheduled = new Promise<string>((resolve, reject) => {
        // setImmediate 会继承当前 ALS store；release 后 runDetached 不占锁，任务内自行取锁
        setImmediate(() => {
          mutex
            .runDetached('k', () => mutex.runExclusive('k', async () => 'ok'))
            .then(resolve, reject);
        });
      });
    });

    await expect(scheduled).resolves.toBe('ok');
  });

  it('N-9: 仍持有锁时调用 runDetached 立即报错而不是死锁', async () => {
    const mutex = new KeyedMutex();

    await expect(
      mutex.runExclusive('k', () => mutex.runDetached('k', async () => 'never')),
    ).rejects.toThrow('runDetached called while still holding key: k');
  });

  it('rejects re-entrant acquisition of the same key instead of hanging (R2-19)', async () => {
    const mutex = new KeyedMutex();

    await expect(
      mutex.runExclusive('k', async () => mutex.runExclusive('k', async () => 'nested')),
    ).rejects.toThrow('KeyedMutex re-entrant lock detected for key: k');

    // 外层释放后仍可正常获取
    await expect(mutex.runExclusive('k', async () => 'ok')).resolves.toBe('ok');
  });
});
