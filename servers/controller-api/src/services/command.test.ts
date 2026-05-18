import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('../models/controller.js', () => ({
  Controller: {
    deleteOne: vi.fn(),
  },
}));

vi.mock('../models/controller-key.js', () => ({
  ControllerKey: {
    deleteOne: vi.fn(),
  },
}));

vi.mock('./session.js', () => ({
  sessionService: {
    getSocketId: vi.fn(),
    cleanupKey: vi.fn(),
  },
}));

import { CommandService } from './command.js';
import { getRedisClient } from '../middleware/redis.js';
import { Controller } from '../models/controller.js';
import { ControllerKey } from '../models/controller-key.js';
import { sessionService } from './session.js';

function createMockSocket() {
  return {
    disconnect: vi.fn(),
  };
}

function createMockIO() {
  const sockets = new Map<string, ReturnType<typeof createMockSocket>>();
  return {
    to: vi.fn().mockReturnThis(),
    emit: vi.fn(),
    sockets: {
      sockets,
    },
  };
}

function createMockRedis() {
  const messageHandlers: ((channel: string, message: string) => void)[] = [];
  return {
    duplicate: vi.fn().mockReturnThis(),
    subscribe: vi.fn(),
    on: vi.fn((event: string, handler: (channel: string, message: string) => void) => {
      if (event === 'message') {
        messageHandlers.push(handler);
      }
    }),
    _emitMessage: (channel: string, message: string) => {
      messageHandlers.forEach((h) => { h(channel, message); });
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CommandService', () => {
  it('should subscribe to command channel on start', () => {
    const mockRedis = createMockRedis();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);

    const commandService = new CommandService();
    const mockIO = createMockIO();

    commandService.start(mockIO as never);

    expect(mockRedis.duplicate).toHaveBeenCalled();
    expect(mockRedis.subscribe).toHaveBeenCalledWith('controller:command', expect.any(Function));
  });

  it('should handle shutdown command', async () => {
    const mockRedis = createMockRedis();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);

    const mockSocket = createMockSocket();
    const mockIO = createMockIO();
    mockIO.sockets.sockets.set('socket-123', mockSocket as never);

    vi.mocked(sessionService.getSocketId).mockResolvedValue('socket-123');
    vi.mocked(Controller.deleteOne).mockResolvedValue({} as never);
    vi.mocked(ControllerKey.deleteOne).mockResolvedValue({} as never);
    vi.mocked(sessionService.cleanupKey).mockResolvedValue();

    const commandService = new CommandService();
    commandService.start(mockIO as never);

    mockRedis._emitMessage('controller:command', JSON.stringify({ type: 'shutdown', keyId: 'key123' }));

    await vi.waitFor(() => {
      expect(sessionService.getSocketId).toHaveBeenCalledWith('key123');
      expect(mockIO.to).toHaveBeenCalledWith('socket-123');
      expect(mockIO.emit).toHaveBeenCalledWith('shutdown', { reason: 'key_revoked' });
      expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
      expect(Controller.deleteOne).toHaveBeenCalledWith({ keyId: 'key123' });
      expect(ControllerKey.deleteOne).toHaveBeenCalledWith({ _id: 'key123' });
      expect(sessionService.cleanupKey).toHaveBeenCalledWith('key123');
    });
  });

  it('should ignore messages from other channels', async () => {
    const mockRedis = createMockRedis();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);

    const mockIO = createMockIO();
    const commandService = new CommandService();
    commandService.start(mockIO as never);

    mockRedis._emitMessage('other:channel', JSON.stringify({ type: 'shutdown', keyId: 'key123' }));

    await vi.waitFor(() => {
      expect(sessionService.getSocketId).not.toHaveBeenCalled();
    });
  });

  it('should ignore non-shutdown commands', async () => {
    const mockRedis = createMockRedis();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);

    const mockIO = createMockIO();
    const commandService = new CommandService();
    commandService.start(mockIO as never);

    mockRedis._emitMessage('controller:command', JSON.stringify({ type: 'other', keyId: 'key123' }));

    await vi.waitFor(() => {
      expect(sessionService.getSocketId).not.toHaveBeenCalled();
    });
  });

  it('should handle invalid JSON gracefully', async () => {
    const mockRedis = createMockRedis();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);

    const mockIO = createMockIO();
    const commandService = new CommandService();
    commandService.start(mockIO as never);

    mockRedis._emitMessage('controller:command', 'invalid-json');

    await vi.waitFor(() => {
      expect(sessionService.getSocketId).not.toHaveBeenCalled();
    });
  });

  it('should handle shutdown when no socket found', async () => {
    const mockRedis = createMockRedis();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);

    const mockIO = createMockIO();
    vi.mocked(sessionService.getSocketId).mockResolvedValue(null);
    vi.mocked(Controller.deleteOne).mockResolvedValue({} as never);
    vi.mocked(ControllerKey.deleteOne).mockResolvedValue({} as never);
    vi.mocked(sessionService.cleanupKey).mockResolvedValue();

    const commandService = new CommandService();
    commandService.start(mockIO as never);

    mockRedis._emitMessage('controller:command', JSON.stringify({ type: 'shutdown', keyId: 'key123' }));

    await vi.waitFor(() => {
      expect(sessionService.getSocketId).toHaveBeenCalledWith('key123');
      expect(mockIO.to).not.toHaveBeenCalled();
      expect(Controller.deleteOne).toHaveBeenCalledWith({ keyId: 'key123' });
    });
  });
});
