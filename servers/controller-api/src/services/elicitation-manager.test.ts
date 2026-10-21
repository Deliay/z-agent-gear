import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

import { ElicitationManager } from './elicitation-manager.js';
import { getRedisClient } from '../middleware/redis.js';

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

  beforeEach(() => {
    manager = new ElicitationManager();
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
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await manager.handleElicitationResponse({ requestId: 'non-existent', action: 'cancel' });

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
      consoleSpy.mockRestore();
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
