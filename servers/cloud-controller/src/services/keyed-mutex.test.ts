import { describe, it, expect } from 'vitest';
import { KeyedMutex } from './keyed-mutex.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('KeyedMutex', () => {
  it('serializes tasks sharing a key while different keys run concurrently', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    const first = mutex.runExclusive('c1', async () => {
      await wait(30);
      order.push('c1-first');
    });
    const second = mutex.runExclusive('c1', async () => {
      order.push('c1-second');
    });
    const other = mutex.runExclusive('c2', async () => {
      order.push('c2');
    });

    await Promise.all([first, second, other]);

    expect(order.indexOf('c1-first')).toBeLessThan(order.indexOf('c1-second'));
    expect(order).toContain('c2');
  });

  it('releases the lock when a task rejects so later tasks still run', async () => {
    const mutex = new KeyedMutex();

    await expect(
      mutex.runExclusive('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(mutex.runExclusive('k', async () => 42)).resolves.toBe(42);
  });
});
