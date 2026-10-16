import { describe, it, expect, vi } from 'vitest';
import { notifyWatchDone } from './k8s-client.js';

describe('notifyWatchDone', () => {
  it('invokes the legacy done-function form and then notifies close', () => {
    const done = vi.fn();
    const onClose = vi.fn();

    notifyWatchDone(done, onClose);

    expect(done).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith();
  });

  it('forwards a normal close (no error) to onClose', () => {
    const onClose = vi.fn();

    notifyWatchDone(undefined, onClose);

    expect(onClose).toHaveBeenCalledWith(undefined);
  });

  it('forwards errors to onClose', () => {
    const onClose = vi.fn();
    const err = new Error('watch failed');

    notifyWatchDone(err, onClose);

    expect(onClose).toHaveBeenCalledWith(err);
  });
});
