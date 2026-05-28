import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

import { PermissionManager } from './permission-manager.js';
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

describe('PermissionManager', () => {
  let manager: PermissionManager;

  beforeEach(() => {
    manager = new PermissionManager();
    manager.start(mockIo as never);
  });

  describe('handlePermissionRequest', () => {
    it('should store pending request and publish to Redis', async () => {
      const data = {
        requestId: 'req-1',
        sessionId: 'session-1',
        toolCall: { toolCallId: 'tc-1' },
        options: [{ optionId: 'opt-1', name: 'Allow Once', kind: 'allow_once' }],
      };

      await manager.handlePermissionRequest(mockSocket as never, data);

      expect(manager.getPendingRequestCount()).toBe(1);
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'permission:request',
        expect.stringContaining('"requestId":"req-1"'),
      );
    });

    it('should include userId and controllerId in published message', async () => {
      const data = {
        requestId: 'req-1',
        sessionId: 'session-1',
        toolCall: { toolCallId: 'tc-1' },
        options: [],
      };

      await manager.handlePermissionRequest(mockSocket as never, data);

      const publishedMessage = JSON.parse(mockRedis.publish.mock.calls[0][1]);
      expect(publishedMessage.userId).toBe('user-1');
      expect(publishedMessage.controllerId).toBe('ctrl-1');
    });
  });

  describe('handlePermissionResponse', () => {
    it('should send response to socket and remove pending request', async () => {
      const data = {
        requestId: 'req-1',
        sessionId: 'session-1',
        toolCall: { toolCallId: 'tc-1' },
        options: [],
      };

      await manager.handlePermissionRequest(mockSocket as never, data);
      expect(manager.getPendingRequestCount()).toBe(1);

      await manager.handlePermissionResponse({
        requestId: 'req-1',
        outcome: { outcome: 'selected', optionId: 'opt-1' },
      });

      expect(mockSocket.emit).toHaveBeenCalledWith('acp:permission:response', {
        requestId: 'req-1',
        outcome: { outcome: 'selected', optionId: 'opt-1' },
      });
      expect(manager.getPendingRequestCount()).toBe(0);
    });

    it('should warn when requestId not found', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await manager.handlePermissionResponse({
        requestId: 'non-existent',
        outcome: { outcome: 'selected' },
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('not found'),
      );
      consoleSpy.mockRestore();
    });
  });

  describe('timeout handling', () => {
    it('should send cancelled outcome after timeout', async () => {
      const data = {
        requestId: 'req-1',
        sessionId: 'session-1',
        toolCall: { toolCallId: 'tc-1' },
        options: [],
      };

      await manager.handlePermissionRequest(mockSocket as never, data);
      expect(manager.getPendingRequestCount()).toBe(1);

      vi.advanceTimersByTime(60_000);

      expect(mockSocket.emit).toHaveBeenCalledWith('acp:permission:response', {
        requestId: 'req-1',
        outcome: { outcome: 'cancelled' },
      });
      expect(manager.getPendingRequestCount()).toBe(0);
    });

    it('should not timeout if response received before timeout', async () => {
      const data = {
        requestId: 'req-1',
        sessionId: 'session-1',
        toolCall: { toolCallId: 'tc-1' },
        options: [],
      };

      await manager.handlePermissionRequest(mockSocket as never, data);

      await manager.handlePermissionResponse({
        requestId: 'req-1',
        outcome: { outcome: 'selected', optionId: 'opt-1' },
      });

      vi.advanceTimersByTime(60_000);

      expect(mockSocket.emit).toHaveBeenCalledTimes(1);
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

      await manager.handlePermissionRequest(mockSocket as never, {
        requestId: 'req-1',
        sessionId: 'session-1',
        toolCall: { toolCallId: 'tc-1' },
        options: [],
      });

      await manager.handlePermissionRequest(mockSocket2 as never, {
        requestId: 'req-2',
        sessionId: 'session-2',
        toolCall: { toolCallId: 'tc-2' },
        options: [],
      });

      expect(manager.getPendingRequestCount()).toBe(2);

      await manager.handlePermissionResponse({
        requestId: 'req-1',
        outcome: { outcome: 'selected', optionId: 'opt-1' },
      });

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
