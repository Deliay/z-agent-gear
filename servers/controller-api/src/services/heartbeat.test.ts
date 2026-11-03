import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('../models/controller.js', () => ({
  Controller: {
    find: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock('../models/controller-key.js', () => ({
  ControllerKey: {},
}));

vi.mock('./session.js', () => ({
  sessionService: {
    getSocketId: vi.fn(),
    releaseSession: vi.fn(),
    removeHeartbeat: vi.fn(),
    removeResumeToken: vi.fn(),
  },
}));

import { heartbeatService } from './heartbeat.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';

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

function mockCandidates(candidates: Array<{ _id: string; keyId: string }>): void {
  vi.mocked(Controller.find).mockReturnValue({ lean: vi.fn().mockResolvedValue(candidates) } as never);
}

function mockCasHit(): void {
  vi.mocked(Controller.findOneAndUpdate).mockResolvedValue({ _id: 'ctrl1' } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockIo.sockets.sockets.clear();
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

  it('should not scan when no offline controllers', async () => {
    mockCandidates([]);

    heartbeatService.start(mockIo as never);
    vi.advanceTimersByTime(15_000);

    await vi.waitFor(() => {
      expect(Controller.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  it('T-ST9: releases only the captured old socket id and keeps the new session on CAS ownership loss', async () => {
    mockCandidates([{ _id: 'ctrl1', keyId: 'key1' }]);
    mockCasHit();
    vi.mocked(sessionService.getSocketId).mockResolvedValue('socket-old');
    vi.mocked(sessionService.releaseSession).mockResolvedValue(false);
    mockIo.sockets.sockets.set('socket-old', mockSocket as never);

    heartbeatService.start(mockIo as never);
    vi.advanceTimersByTime(15_000);

    await vi.waitFor(() => {
      expect(Controller.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'ctrl1', status: 'online', lastHeartbeatAt: { $lt: expect.any(Date) } },
        { status: 'offline' },
        { returnDocument: 'after' },
      );
    });
    expect(sessionService.getSocketId).toHaveBeenCalledWith('key1');
    expect(sessionService.releaseSession).toHaveBeenCalledWith('key1', 'socket-old');
    expect(mockIo.to).toHaveBeenCalledWith('socket-old');
    expect(mockIo.emit).toHaveBeenCalledWith('shutdown', {
      reason: 'heartbeat_timeout',
      _meta: {},
    });
    expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
    // 所有权已变化：新连接的 heartbeat/resume 不得被清理
    expect(sessionService.removeHeartbeat).not.toHaveBeenCalled();
    expect(sessionService.removeResumeToken).not.toHaveBeenCalled();
  });

  it('T-ST13: a stale snapshot whose CAS misses does nothing', async () => {
    mockCandidates([{ _id: 'ctrl1', keyId: 'key1' }]);
    vi.mocked(Controller.findOneAndUpdate).mockResolvedValue(null);
    vi.mocked(sessionService.getSocketId).mockResolvedValue('socket1');
    vi.mocked(sessionService.releaseSession).mockResolvedValue(true);
    mockIo.sockets.sockets.set('socket1', mockSocket as never);

    heartbeatService.start(mockIo as never);
    vi.advanceTimersByTime(15_000);

    await vi.waitFor(() => {
      expect(Controller.findOneAndUpdate).toHaveBeenCalled();
    });
    expect(mockIo.emit).not.toHaveBeenCalled();
    expect(mockSocket.disconnect).not.toHaveBeenCalled();
    expect(sessionService.releaseSession).not.toHaveBeenCalled();
    expect(sessionService.removeHeartbeat).not.toHaveBeenCalled();
    expect(sessionService.removeResumeToken).not.toHaveBeenCalled();
  });

  it('T-ST14: a takeover between CAS and release keeps the new session and heartbeat', async () => {
    mockCandidates([{ _id: 'ctrl1', keyId: 'key1' }]);
    mockCasHit();
    vi.mocked(sessionService.getSocketId).mockResolvedValue('socket-old');
    vi.mocked(sessionService.releaseSession).mockResolvedValue(false);
    mockIo.sockets.sockets.set('socket-old', mockSocket as never);

    heartbeatService.start(mockIo as never);
    vi.advanceTimersByTime(15_000);

    await vi.waitFor(() => {
      expect(sessionService.releaseSession).toHaveBeenCalledWith('key1', 'socket-old');
    });
    expect(sessionService.removeHeartbeat).not.toHaveBeenCalled();
    expect(sessionService.removeResumeToken).not.toHaveBeenCalled();
  });

  it('cleans heartbeat/resume but keeps the session when no socket id was captured', async () => {
    mockCandidates([{ _id: 'ctrl1', keyId: 'key1' }]);
    mockCasHit();
    vi.mocked(sessionService.getSocketId).mockResolvedValue(null);
    vi.mocked(sessionService.removeHeartbeat).mockResolvedValue();
    vi.mocked(sessionService.removeResumeToken).mockResolvedValue();

    heartbeatService.start(mockIo as never);
    vi.advanceTimersByTime(15_000);

    await vi.waitFor(() => {
      expect(sessionService.removeHeartbeat).toHaveBeenCalledWith('key1');
      expect(sessionService.removeResumeToken).toHaveBeenCalledWith('key1');
    });
    expect(mockIo.emit).not.toHaveBeenCalled();
    expect(sessionService.releaseSession).not.toHaveBeenCalled();
  });

  it('releases and cleans up the captured socket after a confirmed timeout', async () => {
    mockCandidates([{ _id: 'ctrl1', keyId: 'key1' }]);
    mockCasHit();
    vi.mocked(sessionService.getSocketId).mockResolvedValue('socket1');
    vi.mocked(sessionService.releaseSession).mockResolvedValue(true);
    vi.mocked(sessionService.removeHeartbeat).mockResolvedValue();
    vi.mocked(sessionService.removeResumeToken).mockResolvedValue();
    mockIo.sockets.sockets.set('socket1', mockSocket as never);

    heartbeatService.start(mockIo as never);
    vi.advanceTimersByTime(15_000);

    await vi.waitFor(() => {
      expect(sessionService.releaseSession).toHaveBeenCalledWith('key1', 'socket1');
      expect(sessionService.removeHeartbeat).toHaveBeenCalledWith('key1');
      expect(sessionService.removeResumeToken).toHaveBeenCalledWith('key1');
    });
    expect(mockIo.emit).toHaveBeenCalledWith('shutdown', {
      reason: 'heartbeat_timeout',
      _meta: {},
    });
    expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
  });
});
