import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('../models/controller.js', () => ({
  Controller: {
    find: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock('../models/controller-key.js', () => ({
  ControllerKey: {},
}));

vi.mock('./session.js', () => ({
  sessionService: {
    getSocketId: vi.fn(),
    cleanupKey: vi.fn(),
  },
}));

import { heartbeatService } from './heartbeat.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import { getRedisClient } from '../middleware/redis.js';

const mockIo = {
  to: vi.fn().mockReturnThis(),
  emit: vi.fn(),
  sockets: {
    sockets: new Map(),
  },
};

const mockSocket = {
  disconnect: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  heartbeatService.stop();
});

describe('HeartbeatService', () => {
  it('should start and stop the scan interval', () => {
    heartbeatService.start(mockIo as never);
    expect(heartbeatService['intervalId']).not.toBeNull();

    heartbeatService.stop();
    expect(heartbeatService['intervalId']).toBeNull();
  });

  it('should mark controllers as offline when heartbeat times out', async () => {
    const offlineControllers = [
      { _id: 'ctrl1', keyId: 'key1' },
      { _id: 'ctrl2', keyId: 'key2' },
    ];

    vi.mocked(Controller.find).mockReturnValue({ lean: vi.fn().mockResolvedValue(offlineControllers) } as never);
    vi.mocked(Controller.updateMany).mockResolvedValue({} as never);
    vi.mocked(sessionService.getSocketId).mockResolvedValue('socket1');
    vi.mocked(sessionService.cleanupKey).mockResolvedValue();
    mockIo.sockets.sockets.set('socket1', mockSocket as never);

    heartbeatService.start(mockIo as never);

    vi.advanceTimersByTime(15_000);

    await vi.waitFor(() => {
      expect(Controller.updateMany).toHaveBeenCalledWith(
        { _id: { $in: ['ctrl1', 'ctrl2'] } },
        { status: 'offline' },
      );
    });
  });

  it('should not scan when no offline controllers', async () => {
    vi.mocked(Controller.find).mockReturnValue({ lean: vi.fn().mockResolvedValue([]) } as never);

    heartbeatService.start(mockIo as never);

    vi.advanceTimersByTime(15_000);

    await vi.waitFor(() => {
      expect(Controller.updateMany).not.toHaveBeenCalled();
    });
  });
});
