import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('../models/controller.js', () => ({
  Controller: {
    findById: vi.fn(),
  },
}));

vi.mock('./session.js', () => ({
  sessionService: {
    getSocketId: vi.fn(),
  },
}));

import { FsMkdirService } from './fs-mkdir-service.js';
import { getRedisClient } from '../middleware/redis.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';

function createMockSocket() {
  return { emit: vi.fn() };
}

function createMockIO() {
  return {
    sockets: {
      sockets: new Map<string, ReturnType<typeof createMockSocket>>(),
    },
  };
}

describe('FsMkdirService', () => {
  let mockSocket: ReturnType<typeof createMockSocket>;
  let mockIO: ReturnType<typeof createMockIO>;
  let mockRedisClient: { set: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    mockSocket = createMockSocket();
    mockIO = createMockIO();
    mockIO.sockets.sockets.set('socket-123', mockSocket);

    mockRedisClient = {
      set: vi.fn().mockResolvedValue('OK'),
    };
    vi.mocked(getRedisClient).mockReturnValue(mockRedisClient as never);
    vi.mocked(Controller.findById).mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: 'ctrl-1',
        keyId: { toString: () => 'key-1' },
      }),
    } as never);
    vi.mocked(sessionService.getSocketId).mockResolvedValue('socket-123');
  });

  describe('start', () => {
    it('should store IO reference', () => {
      const service = new FsMkdirService();
      service.start(mockIO as never);
      expect((service as any).io).toBe(mockIO);
    });
  });

  describe('handleMkdir', () => {
    it('should emit fs:mkdir to controller socket', async () => {
      const service = new FsMkdirService();
      service.start(mockIO as never);

      await service.handleMkdir('req-1', 'ctrl-1', '/home/user', 'new-folder');

      expect(mockSocket.emit).toHaveBeenCalledWith('fs:mkdir', {
        requestId: 'req-1',
        parentPath: '/home/user',
        folderName: 'new-folder',
      });
    });
  });

  describe('handleMkdirResult', () => {
    it('should store result in Redis with TTL 30', async () => {
      const service = new FsMkdirService();
      const result = { success: true, name: 'new-folder', path: '/home/user/new-folder' };

      await service.handleMkdirResult('req-1', result);

      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'fs:mkdir:req-1',
        JSON.stringify(result),
        'EX',
        30,
      );
    });
  });
});