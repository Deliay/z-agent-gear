import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

import { ElicitationManager } from './elicitation-manager.js';
import { getRedisClient } from '../middleware/redis.js';
import { createTestLogger, type TestLogger } from '../observability/testing.js';

const mockRedis = {
  publish: vi.fn(),
  subscribe: vi.fn(),
  on: vi.fn(),
  duplicate: vi.fn(),
  disconnect: vi.fn(),
};

const mockSocket = {
  id: 'socket-123',
  data: {
    userId: 'user-1',
    controllerId: 'ctrl-1',
  },
  emit: vi.fn(),
};

const mockIo = {
  sockets: {
    sockets: new Map(),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();

  vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
  mockRedis.duplicate.mockReturnValue(mockRedis);
  mockIo.sockets.sockets.clear();
  mockIo.sockets.sockets.set('socket-123', mockSocket as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ElicitationManager', () => {
  let manager: ElicitationManager;
  let testLog: TestLogger;

  beforeEach(() => {
    testLog = createTestLogger();
    manager = new ElicitationManager(testLog.logger);
    manager.start(mockIo as never);
  });

  describe('handleElicitationRequest', () => {
    it('should store pending request and publish form elicitation to Redis', async () => {
      await manager.handleElicitationRequest(mockSocket as never, {
        requestId: 'elic-1',
        sessionId: 'session-1',
        mode: 'form',
        message: 'Which strategy?',
        requestedSchema: {
          type: 'object',
          properties: { strategy: { type: 'string', enum: ['a', 'b'] } },
          required: ['strategy'],
        },
      });

      expect(manager.getPendingRequestCount()).toBe(1);
      const publishedMessage = JSON.parse(mockRedis.publish.mock.calls[0][1]);
      expect(mockRedis.publish).toHaveBeenCalledWith('elicitation:request', expect.any(String));
      expect(publishedMessage.requestId).toBe('elic-1');
      expect(publishedMessage.userId).toBe('user-1');
      expect(publishedMessage.controllerId).toBe('ctrl-1');
      expect(publishedMessage.mode).toBe('form');
      expect(publishedMessage.requestedSchema.required).toEqual(['strategy']);
    });

    it('should publish url elicitation with elicitationId and url', async () => {
      await manager.handleElicitationRequest(mockSocket as never, {
        requestId: 'elic-2',
        sessionId: 'session-1',
        mode: 'url',
        message: 'Authorize access',
        elicitationId: 'github-oauth-001',
        url: 'https://agent.example.com/connect?elicitationId=github-oauth-001',
      });

      const publishedMessage = JSON.parse(mockRedis.publish.mock.calls[0][1]);
      expect(publishedMessage.mode).toBe('url');
      expect(publishedMessage.elicitationId).toBe('github-oauth-001');
      expect(publishedMessage.url).toContain('github-oauth-001');
    });
  });

  describe('handleElicitationResponse', () => {
    it('should send accept response with content to socket and remove pending request', async () => {
      await manager.handleElicitationRequest(mockSocket as never, {
        requestId: 'elic-1',
        sessionId: 'session-1',
        mode: 'form',
        message: 'Which strategy?',
      });
      expect(manager.getPendingRequestCount()).toBe(1);

      await manager.handleElicitationResponse({
        requestId: 'elic-1',
        action: 'accept',
        content: { strategy: 'balanced' },
      });

      expect(mockSocket.emit).toHaveBeenCalledWith('acp:elicitation:response', {
        requestId: 'elic-1',
        action: 'accept',
        content: { strategy: 'balanced' },
      });
      expect(manager.getPendingRequestCount()).toBe(0);
    });

    it('should warn when requestId not found', async () => {
      await manager.handleElicitationResponse({ requestId: 'non-existent', action: 'cancel' });

      expect(testLog.records).toContainEqual(expect.objectContaining({
        level: 'warn',
        requestId: 'non-existent',
        msg: expect.stringContaining('not found'),
      }));
    });
  });

  describe('timeout handling', () => {
    it('should send cancel action after timeout', async () => {
      await manager.handleElicitationRequest(mockSocket as never, {
        requestId: 'elic-1',
        sessionId: 'session-1',
        mode: 'form',
        message: 'Which strategy?',
      });

      vi.advanceTimersByTime(60_000);

      expect(mockSocket.emit).toHaveBeenCalledWith('acp:elicitation:response', {
        requestId: 'elic-1',
        action: 'cancel',
      });
      expect(manager.getPendingRequestCount()).toBe(0);
    });

    it('should not timeout if response received before timeout', async () => {
      await manager.handleElicitationRequest(mockSocket as never, {
        requestId: 'elic-1',
        sessionId: 'session-1',
        mode: 'form',
        message: 'Which strategy?',
      });

      await manager.handleElicitationResponse({ requestId: 'elic-1', action: 'decline' });

      vi.advanceTimersByTime(60_000);

      expect(mockSocket.emit).toHaveBeenCalledTimes(1);
    });

    it('T-S5: 60s 超时同时发布 elicitation:resolved(timeout) 并回 cancel', async () => {
      await manager.handleElicitationRequest(mockSocket as never, {
        requestId: 'elic-1',
        sessionId: 'session-1',
        mode: 'form',
        message: 'Which strategy?',
      });

      mockRedis.publish.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.resolve();

      const resolvedCall = mockRedis.publish.mock.calls.find((c) => c[0] === 'elicitation:resolved');
      expect(resolvedCall).toBeDefined();
      const payload = JSON.parse(resolvedCall![1]);
      expect(payload).toMatchObject({
        requestId: 'elic-1',
        sessionId: 'session-1',
        userId: 'user-1',
        controllerId: 'ctrl-1',
        reason: 'timeout',
      });
      expect(mockSocket.emit).toHaveBeenCalledWith('acp:elicitation:response', {
        requestId: 'elic-1',
        action: 'cancel',
      });
      expect(manager.getPendingRequestCount()).toBe(0);
    });
  });

  describe('handleElicitationResolved', () => {
    it('T-S6: 透传 resolved 事件并附 userId/controllerId/detail', async () => {
      await manager.handleElicitationResolved(mockSocket as never, {
        sessionId: 'session-1',
        reason: 'unsupported_mode',
        detail: 'custom',
      });

      expect(mockRedis.publish).toHaveBeenCalledWith('elicitation:resolved', expect.any(String));
      const payload = JSON.parse(mockRedis.publish.mock.calls[0][1]);
      expect(payload).toMatchObject({
        sessionId: 'session-1',
        reason: 'unsupported_mode',
        detail: 'custom',
        userId: 'user-1',
        controllerId: 'ctrl-1',
      });
    });

    it('T-S6b: 契约外 reason 丢弃并告警（不静默归并）', async () => {
      mockRedis.publish.mockClear();

      await manager.handleElicitationResolved(mockSocket as never, {
        sessionId: 'session-1',
        reason: 'protocol_drift' as never,
      });

      expect(mockRedis.publish).not.toHaveBeenCalledWith('elicitation:resolved', expect.anything());
      expect(testLog.records).toContainEqual(expect.objectContaining({
        level: 'warn',
        reason: 'protocol_drift',
        msg: expect.stringContaining('unknown reason'),
      }));
    });

    it('T-S6c: 缺 sessionId 丢弃并告警', async () => {
      mockRedis.publish.mockClear();

      await manager.handleElicitationResolved(mockSocket as never, {
        sessionId: '',
        reason: 'timeout',
      });

      expect(mockRedis.publish).not.toHaveBeenCalledWith('elicitation:resolved', expect.anything());
      expect(testLog.records).toContainEqual(expect.objectContaining({
        level: 'warn',
        msg: expect.stringContaining('invalid sessionId'),
      }));
    });

    it('T-S6d: requestId/detail 超长时截断到 200 字符', async () => {
      mockRedis.publish.mockClear();

      await manager.handleElicitationResolved(mockSocket as never, {
        requestId: 'r'.repeat(500),
        sessionId: 'session-1',
        reason: 'timeout',
        detail: 'd'.repeat(500),
      });

      const payload = JSON.parse(mockRedis.publish.mock.calls[0][1]);
      expect(payload.requestId).toHaveLength(200);
      expect(payload.detail).toHaveLength(200);
    });

    it('T-S6e: 非字符串 detail 与未知字段被丢弃（白名单重建，不绕过截断）', async () => {
      mockRedis.publish.mockClear();

      await manager.handleElicitationResolved(mockSocket as never, {
        requestId: 'elic-1',
        sessionId: 'session-1',
        reason: 'cancelled',
        detail: { nested: 'x'.repeat(10_000) } as never,
        evil: 'z'.repeat(10_000),
      } as never);

      const payload = JSON.parse(mockRedis.publish.mock.calls[0][1]);
      expect(payload).not.toHaveProperty('detail');
      expect(payload).not.toHaveProperty('evil');
      expect(Object.keys(payload).sort()).toEqual(
        ['_meta', 'controllerId', 'reason', 'requestId', 'sessionId', 'userId'].sort(),
      );
    });

    it('T-S6f: 超长 sessionId 丢弃（不进入 Redis）', async () => {
      mockRedis.publish.mockClear();

      await manager.handleElicitationResolved(mockSocket as never, {
        sessionId: 's'.repeat(500),
        reason: 'timeout',
      });

      expect(mockRedis.publish).not.toHaveBeenCalledWith('elicitation:resolved', expect.anything());
      expect(testLog.records).toContainEqual(expect.objectContaining({
        level: 'warn',
        msg: expect.stringContaining('invalid sessionId'),
      }));
    });
  });

  describe('pending 生命周期', () => {
    it('T-S8: 重复 requestId 清理旧 60s timer（不重复发 timeout）', async () => {
      await manager.handleElicitationRequest(mockSocket as never, {
        requestId: 'elic-dup', sessionId: 'session-1', mode: 'form', message: 'first',
      });
      // 先推进 30s 再发同 requestId：若旧 timer 未清理，它会在 t=60s 提前触发 timeout
      await vi.advanceTimersByTimeAsync(30_000);
      await manager.handleElicitationRequest(mockSocket as never, {
        requestId: 'elic-dup', sessionId: 'session-1', mode: 'form', message: 'second',
      });

      expect(manager.getPendingRequestCount()).toBe(1);

      mockRedis.publish.mockClear();
      // t=65s：旧 timer 若未清会在 t=60s 误发 timeout（新请求此时才 35s）
      await vi.advanceTimersByTimeAsync(35_000);
      await Promise.resolve();
      expect(mockRedis.publish.mock.calls.filter(
        (c) => c[0] === 'elicitation:resolved' && JSON.parse(c[1]).reason === 'timeout',
      )).toHaveLength(0);

      // t=95s：新请求自身在 t=90s 超时，且整段只允许 1 条 timeout
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();
      const timeoutPublishes = mockRedis.publish.mock.calls.filter(
        (c) => c[0] === 'elicitation:resolved' && JSON.parse(c[1]).reason === 'timeout',
      );
      expect(timeoutPublishes).toHaveLength(1);
    });

    it('T-S9: clearForSocket 清理该 socket 的 pending 与 timer（断线不迟发 timeout）', async () => {
      await manager.handleElicitationRequest(mockSocket as never, {
        requestId: 'elic-1', sessionId: 'session-1', mode: 'form', message: 'hi',
      });
      expect(manager.getPendingRequestCount()).toBe(1);

      manager.clearForSocket('socket-123');
      expect(manager.getPendingRequestCount()).toBe(0);

      mockRedis.publish.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.resolve();
      expect(mockRedis.publish).not.toHaveBeenCalledWith('elicitation:resolved', expect.anything());
    });

    it('T-S11: 非 http(s) url / 超大 schema / 非法 toolCallId 均拒绝入 pending', async () => {
      mockRedis.publish.mockClear();

      await manager.handleElicitationRequest(mockSocket as never, {
        requestId: 'elic-url', sessionId: 's', mode: 'url', message: 'open',
        url: 'javascript:alert(1)',
      });
      await manager.handleElicitationRequest(mockSocket as never, {
        requestId: 'elic-schema', sessionId: 's', mode: 'form', message: 'big',
        requestedSchema: { type: 'object', properties: { x: { type: 'string', description: 'd'.repeat(70 * 1024) } } },
      });
      await manager.handleElicitationRequest(mockSocket as never, {
        requestId: 'elic-tool', sessionId: 's', mode: 'form', message: 'bad tool',
        toolCallId: { nested: true } as never,
      });

      expect(manager.getPendingRequestCount()).toBe(0);
      expect(mockRedis.publish).not.toHaveBeenCalledWith('elicitation:request', expect.anything());
      expect(testLog.records).toContainEqual(expect.objectContaining({
        level: 'warn',
        msg: expect.stringContaining('invalid elicitation request'),
      }));
    });

    it('T-S10: 非法 mode / 空 sessionId 的请求不入 pending、不发 Redis', async () => {
      mockRedis.publish.mockClear();

      await manager.handleElicitationRequest(mockSocket as never, {
        requestId: 'elic-bad', sessionId: '', mode: 'form', message: 'hi',
      });
      await manager.handleElicitationRequest(mockSocket as never, {
        requestId: 'elic-bad2', sessionId: 's', mode: 'custom' as never, message: 'hi',
      });

      expect(manager.getPendingRequestCount()).toBe(0);
      expect(mockRedis.publish).not.toHaveBeenCalledWith('elicitation:request', expect.anything());
      expect(testLog.records).toContainEqual(expect.objectContaining({
        level: 'warn',
        msg: expect.stringContaining('invalid elicitation request'),
      }));
    });
  });

  describe('handleElicitationComplete', () => {
    it('should publish completion notification with userId', async () => {
      await manager.handleElicitationComplete(mockSocket as never, {
        sessionId: 'session-1',
        elicitationId: 'github-oauth-001',
      });

      const publishedMessage = JSON.parse(mockRedis.publish.mock.calls[0][1]);
      expect(mockRedis.publish).toHaveBeenCalledWith('elicitation:complete', expect.any(String));
      expect(publishedMessage.elicitationId).toBe('github-oauth-001');
      expect(publishedMessage.sessionId).toBe('session-1');
      expect(publishedMessage.userId).toBe('user-1');
    });
  });

  describe('concurrent requests', () => {
    it('should handle multiple pending requests independently', async () => {
      const mockSocket2 = {
        id: 'socket-456',
        data: { userId: 'user-2', controllerId: 'ctrl-2' },
        emit: vi.fn(),
      };
      mockIo.sockets.sockets.set('socket-456', mockSocket2 as never);

      await manager.handleElicitationRequest(mockSocket as never, {
        requestId: 'elic-1',
        sessionId: 'session-1',
        mode: 'form',
        message: 'q1',
      });
      await manager.handleElicitationRequest(mockSocket2 as never, {
        requestId: 'elic-2',
        sessionId: 'session-2',
        mode: 'form',
        message: 'q2',
      });

      expect(manager.getPendingRequestCount()).toBe(2);

      await manager.handleElicitationResponse({ requestId: 'elic-1', action: 'cancel' });

      expect(manager.getPendingRequestCount()).toBe(1);
      expect(mockSocket.emit).toHaveBeenCalled();
      expect(mockSocket2.emit).not.toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('should clear all pending requests and disconnect subscriber', () => {
      manager.stop();

      expect(mockRedis.disconnect).toHaveBeenCalled();
    });
  });
});
