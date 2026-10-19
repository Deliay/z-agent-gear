import { describe, it, expect } from 'vitest';
import { KeyedMutex } from './keyed-mutex.js';

describe('KeyedMutex', () => {
  it('同一 key 串行、不同 key 并行', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const task = (name: string, delay: number) =>
      mutex.runExclusive('k', async () => {
        order.push(`${name}:start`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        order.push(`${name}:end`);
      });
    await Promise.all([task('a', 20), task('b', 1)]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);

    const parallel: string[] = [];
    await Promise.all([
      mutex.runExclusive('x', async () => {
        parallel.push('x');
      }),
      mutex.runExclusive('y', async () => {
        parallel.push('y');
      }),
    ]);
    expect(parallel.sort()).toEqual(['x', 'y']);
  });
});
