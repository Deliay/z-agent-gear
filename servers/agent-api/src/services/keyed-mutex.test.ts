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
});
