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

import { FsReadFileService, FS_READ_FILE_RESULT_TTL_SECONDS } from './fs-read-file-service.js';
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

describe('FsReadFileService', () => {
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

  it('T-FSR1 白名单分发：emit fs:read-file 到正确 socket，载荷含 requestId/path/maxBytes', async () => {
    const service = new FsReadFileService();
    service.start(mockIO as never);

    await service.handleReadFile('req-1', 'ctrl-1', '/home/user/a.txt', 4096);

    expect(mockSocket.emit).toHaveBeenCalledWith('fs:read-file', {
      requestId: 'req-1',
      path: '/home/user/a.txt',
      maxBytes: 4096,
      _meta: {},
    });
    expect(sessionService.getSocketId).toHaveBeenCalledWith('key-1');
  });

  it('T-FSR2 控制器离线：记录 error，不写 Redis、不崩溃', async () => {
    const service = new FsReadFileService();
    service.start(mockIO as never);
    vi.mocked(sessionService.getSocketId).mockResolvedValue(null);

    await expect(
      service.handleReadFile('req-2', 'ctrl-1', '/home/user/a.txt'),
    ).resolves.toBeUndefined();

    expect(mockSocket.emit).not.toHaveBeenCalled();
    expect(mockRedisClient.set).not.toHaveBeenCalled();
  });

  it('T-FSR2b 控制器不存在：记录 error，不 emit', async () => {
    const service = new FsReadFileService();
    service.start(mockIO as never);
    vi.mocked(Controller.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue(null) } as never);

    await service.handleReadFile('req-3', 'ctrl-missing', '/home/user/a.txt');

    expect(mockSocket.emit).not.toHaveBeenCalled();
  });

  it('T-FSR3 结果缓存：fs:read-file:result 写 Redis key 与 TTL=60', async () => {
    const service = new FsReadFileService();
    const result = { requestId: 'req-1', success: true, content: 'data', truncated: false, sizeBytes: 4 };

    await service.handleReadFileResult('req-1', result);

    expect(mockRedisClient.set).toHaveBeenCalledWith(
      'fs:read-file:req-1',
      JSON.stringify(result),
      'EX',
      FS_READ_FILE_RESULT_TTL_SECONDS,
    );
    expect(FS_READ_FILE_RESULT_TTL_SECONDS).toBe(60);
  });

  it('T-FSR4 非法 command（io 未启动）不分发', async () => {
    const service = new FsReadFileService();
    await service.handleReadFile('req-4', 'ctrl-1', '/home/user/a.txt');
    expect(mockSocket.emit).not.toHaveBeenCalled();
  });
});
