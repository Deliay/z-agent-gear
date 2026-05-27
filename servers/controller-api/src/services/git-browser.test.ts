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

import { gitBrowserService, GitBrowserService } from './git-browser.js';
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

describe('GitBrowserService', () => {
  let mockSocket: ReturnType<typeof createMockSocket>;
  let mockIO: ReturnType<typeof createMockIO>;
  let mockRedisClient: { set: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    mockSocket = createMockSocket();
    mockIO = createMockIO();
    mockIO.sockets.sockets.set('socket-123', mockSocket);

    mockRedisClient = {
      set: vi.fn().mockResolvedValue('OK'),
      get: vi.fn().mockResolvedValue(null),
      del: vi.fn().mockResolvedValue(1),
    };
    vi.mocked(getRedisClient).mockReturnValue(mockRedisClient as never);

    gitBrowserService.start(mockIO as never);
  });

  describe('start', () => {
    it('should set io reference', () => {
      const service = new GitBrowserService();
      service.start(mockIO as never);
      expect((service as unknown as { io: unknown }).io).toBe(mockIO);
    });
  });

  describe('check', () => {
    it('should emit git:check to controller socket', async () => {
      vi.mocked(Controller.findById).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ keyId: 'key-123' }),
      } as never);
      vi.mocked(sessionService.getSocketId).mockResolvedValue('socket-123');

      await gitBrowserService.check('req-1', 'ctrl-1', '/fake/path');

      expect(mockSocket.emit).toHaveBeenCalledWith('git:check', {
        requestId: 'req-1',
        path: '/fake/path',
      });
    });

    it('should log error when controller not found', async () => {
      vi.mocked(Controller.findById).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as never);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await gitBrowserService.check('req-1', 'ctrl-1', '/fake/path');

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Controller not found'));
      expect(mockSocket.emit).not.toHaveBeenCalled();
    });

    it('should log error when controller offline', async () => {
      vi.mocked(Controller.findById).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ keyId: 'key-123' }),
      } as never);
      vi.mocked(sessionService.getSocketId).mockResolvedValue(null);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await gitBrowserService.check('req-1', 'ctrl-1', '/fake/path');

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Controller offline'));
      expect(mockSocket.emit).not.toHaveBeenCalled();
    });

    it('should do nothing when io is not set', async () => {
      const service = new GitBrowserService();

      await service.check('req-1', 'ctrl-1', '/fake/path');

      expect(Controller.findById).not.toHaveBeenCalled();
    });
  });

  describe('init', () => {
    it('should emit git:init to controller socket', async () => {
      vi.mocked(Controller.findById).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ keyId: 'key-123' }),
      } as never);
      vi.mocked(sessionService.getSocketId).mockResolvedValue('socket-123');

      await gitBrowserService.init('req-1', 'ctrl-1', '/fake/path');

      expect(mockSocket.emit).toHaveBeenCalledWith('git:init', {
        requestId: 'req-1',
        path: '/fake/path',
      });
    });
  });

  describe('handleCheckResult', () => {
    it('should cache check result in redis', async () => {
      const result = { isGitRepo: true, currentBranch: 'main', branches: ['main'], defaultBranch: 'main' };

      await gitBrowserService.handleCheckResult('req-1', result);

      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'git:check:req-1',
        JSON.stringify(result),
        'EX',
        60,
      );
    });
  });

  describe('handleInitResult', () => {
    it('should cache init result in redis', async () => {
      const result = { success: true };

      await gitBrowserService.handleInitResult('req-1', result);

      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'git:init:req-1',
        JSON.stringify(result),
        'EX',
        30,
      );
    });
  });
});
