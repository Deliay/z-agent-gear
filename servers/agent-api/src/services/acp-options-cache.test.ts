import { describe, it, expect, vi, beforeEach } from 'vitest';

const redisMock = {
  scan: vi.fn(),
  del: vi.fn(),
};

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(() => redisMock),
}));

vi.mock('../models/controller.js', () => ({
  Controller: {
    find: vi.fn(),
  },
}));

import { Controller } from '../models/controller.js';
import { logger as rootLogger } from '../observability/logger.js';
import { createTestLogger } from '../observability/testing.js';

/**
 * 注入 createTestLogger：在被测模块加载前拦截 `rootLogger.child(...)`，把
 * acp-options-cache 告警写入内存 sink，断言 `records` 的结构化字段。
 */
const testLog = createTestLogger();
const childSpy = vi
  .spyOn(rootLogger, 'child')
  .mockImplementation((bindings) => testLog.logger.child(bindings));
const { invalidateAcpOptionsForController, invalidateAcpOptionsForUser } = await import(
  './acp-options-cache.js'
);
childSpy.mockRestore();

function chainControllers(ids: string[]) {
  return {
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(ids.map((id) => ({ _id: id }))),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  testLog.reset();
  redisMock.del.mockResolvedValue(1 as never);
});

describe('invalidateAcpOptionsForController', () => {
  it('walks every SCAN page and deletes matched keys in batches', async () => {
    redisMock.scan
      .mockResolvedValueOnce(['17', ['acp:options:ctrl-1:opencode', 'acp:options:ctrl-1:codex']])
      .mockResolvedValueOnce(['0', ['acp:options:ctrl-1:claude_code']]);

    await expect(invalidateAcpOptionsForController('ctrl-1')).resolves.toBe(3);

    expect(redisMock.scan).toHaveBeenNthCalledWith(
      1,
      '0',
      'MATCH',
      'acp:options:ctrl-1:*',
      'COUNT',
      100,
    );
    expect(redisMock.scan).toHaveBeenNthCalledWith(
      2,
      '17',
      'MATCH',
      'acp:options:ctrl-1:*',
      'COUNT',
      100,
    );
    expect(redisMock.del).toHaveBeenCalledTimes(2);
    expect(redisMock.del).toHaveBeenNthCalledWith(
      1,
      'acp:options:ctrl-1:opencode',
      'acp:options:ctrl-1:codex',
    );
  });

  it('does not call DEL when no keys match', async () => {
    redisMock.scan.mockResolvedValue(['0', []]);
    await expect(invalidateAcpOptionsForController('ctrl-1')).resolves.toBe(0);
    expect(redisMock.del).not.toHaveBeenCalled();
  });

  it('swallows Redis failures (best effort) and returns 0', async () => {
    redisMock.scan.mockRejectedValue(new Error('redis down'));
    await expect(invalidateAcpOptionsForController('ctrl-1')).resolves.toBe(0);
    expect(testLog.records.some((r) => r.level === 'warn')).toBe(true);
  });
});

describe('invalidateAcpOptionsForUser', () => {
  it('deletes keys for every controller owned by the user', async () => {
    vi.mocked(Controller.find).mockReturnValue(chainControllers(['ctrl-1', 'ctrl-2']));
    redisMock.scan
      .mockResolvedValueOnce(['0', ['acp:options:ctrl-1:opencode']])
      .mockResolvedValueOnce(['0', ['acp:options:ctrl-2:opencode', 'acp:options:ctrl-2:codex']]);

    await expect(invalidateAcpOptionsForUser('user-1')).resolves.toBe(3);
    expect(Controller.find).toHaveBeenCalledWith({ userId: 'user-1' });
    expect(redisMock.scan).toHaveBeenNthCalledWith(
      1,
      '0',
      'MATCH',
      'acp:options:ctrl-1:*',
      'COUNT',
      100,
    );
    expect(redisMock.scan).toHaveBeenNthCalledWith(
      2,
      '0',
      'MATCH',
      'acp:options:ctrl-2:*',
      'COUNT',
      100,
    );
  });

  it('returns 0 when the controller lookup fails', async () => {
    vi.mocked(Controller.find).mockImplementation(() => {
      throw new Error('db down');
    });
    await expect(invalidateAcpOptionsForUser('user-1')).resolves.toBe(0);
    expect(testLog.records.some((r) => r.level === 'warn')).toBe(true);
  });

  it('returns 0 when the user has no controllers', async () => {
    vi.mocked(Controller.find).mockReturnValue(chainControllers([]));
    await expect(invalidateAcpOptionsForUser('user-1')).resolves.toBe(0);
    expect(redisMock.scan).not.toHaveBeenCalled();
  });
});
