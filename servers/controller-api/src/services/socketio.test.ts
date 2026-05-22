import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('./key-cache.js', () => ({
  lookupKey: vi.fn(),
}));

vi.mock('../models/controller-key.js', () => ({
  ControllerKey: {
    findOne: vi.fn(),
    updateOne: vi.fn(),
    deleteOne: vi.fn(),
  },
}));

vi.mock('../models/controller.js', () => ({
  Controller: {
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
    deleteOne: vi.fn(),
  },
}));

vi.mock('./session.js', () => ({
  sessionService: {
    acquireSession: vi.fn(),
    storeResumeToken: vi.fn().mockResolvedValue('test-resume-token'),
    refreshSession: vi.fn(),
    updateHeartbeat: vi.fn(),
    cleanupKey: vi.fn(),
    removeSession: vi.fn(),
  },
}));

vi.mock('bcryptjs', () => ({
  default: {
    compare: vi.fn(),
  },
}));

import { createSocketIOServer } from './socketio.js';
import { ControllerKey } from '../models/controller-key.js';
import { Controller } from '../models/controller.js';
import { sessionService } from './session.js';
import { lookupKey } from './key-cache.js';
import bcrypt from 'bcryptjs';

function createMockSocket() {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    id: 'socket-123',
    handshake: { address: '127.0.0.1' },
    data: {} as Record<string, unknown>,
    join: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handler;
    }),
    _trigger: (event: string, ...args: unknown[]) => handlers[event]?.(...args),
    _handlers: handlers,
  };
}

function createMockIO() {
  const connectionHandler = vi.fn();
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'connection') connectionHandler(handler);
    }),
    _connectionHandler: connectionHandler,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SocketIO Service', () => {
  describe('register', () => {
    it('should register successfully with valid key', async () => {
      const mockSocket = createMockSocket();
      const mockIO = createMockIO();

      vi.mocked(lookupKey).mockResolvedValue({
        keyId: 'key123',
        keyHash: 'hashed-key',
        userId: 'user1',
        status: 'active',
        type: 'local',
      });
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
      vi.mocked(sessionService.acquireSession).mockResolvedValue(true);
      vi.mocked(Controller.findOneAndUpdate).mockResolvedValue({
        _id: { toString: () => 'ctrl123' },
      } as never);
      vi.mocked(ControllerKey.updateOne).mockResolvedValue({} as never);

      createSocketIOServer(mockIO as never);

      const connectionHandler = mockIO._connectionHandler.mock.calls[0][0];
      connectionHandler(mockSocket);

      mockSocket._trigger('register', { key: 'zag_k_1_abc123', hostname: 'dev-machine', version: '1.0.0' });

      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('registered', { controllerId: 'ctrl123', resumeToken: 'test-resume-token' });
      });
    });

    it('should reject with INVALID_KEY when key not found', async () => {
      const mockSocket = createMockSocket();
      const mockIO = createMockIO();

      vi.mocked(lookupKey).mockResolvedValue(null);

      createSocketIOServer(mockIO as never);

      const connectionHandler = mockIO._connectionHandler.mock.calls[0][0];
      connectionHandler(mockSocket);

      mockSocket._trigger('register', { key: 'invalid-key', hostname: 'dev-machine', version: '1.0.0' });

      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('error', { code: 'INVALID_KEY', message: 'Key not found' });
        expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
      });
    });

    it('should reject with INVALID_KEY when key hash mismatch', async () => {
      const mockSocket = createMockSocket();
      const mockIO = createMockIO();

      vi.mocked(lookupKey).mockResolvedValue({
        keyId: 'key123',
        keyHash: 'hashed-key',
        userId: 'user1',
        status: 'active',
        type: 'local',
      });
      vi.mocked(bcrypt.compare).mockResolvedValue(false as never);

      createSocketIOServer(mockIO as never);

      const connectionHandler = mockIO._connectionHandler.mock.calls[0][0];
      connectionHandler(mockSocket);

      mockSocket._trigger('register', { key: 'wrong-key', hostname: 'dev-machine', version: '1.0.0' });

      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('error', { code: 'INVALID_KEY', message: 'Invalid key' });
        expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
      });
    });

    it('should reject with VERSION_MISMATCH when version incompatible', async () => {
      const mockSocket = createMockSocket();
      const mockIO = createMockIO();

      vi.mocked(lookupKey).mockResolvedValue({
        keyId: 'key123',
        keyHash: 'hashed-key',
        userId: 'user1',
        status: 'active',
        type: 'local',
      });
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);

      createSocketIOServer(mockIO as never);

      const connectionHandler = mockIO._connectionHandler.mock.calls[0][0];
      connectionHandler(mockSocket);

      mockSocket._trigger('register', { key: 'zag_k_1_abc123', hostname: 'dev-machine', version: '2.0.0' });

      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('error', { code: 'VERSION_MISMATCH', message: 'Version mismatch' });
        expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
      });
    });

    it('should reject with KEY_ALREADY_ONLINE when session exists', async () => {
      const mockSocket = createMockSocket();
      const mockIO = createMockIO();

      vi.mocked(lookupKey).mockResolvedValue({
        keyId: 'key123',
        keyHash: 'hashed-key',
        userId: 'user1',
        status: 'active',
        type: 'local',
      });
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
      vi.mocked(sessionService.acquireSession).mockResolvedValue(false);

      createSocketIOServer(mockIO as never);

      const connectionHandler = mockIO._connectionHandler.mock.calls[0][0];
      connectionHandler(mockSocket);

      mockSocket._trigger('register', { key: 'zag_k_1_abc123', hostname: 'dev-machine', version: '1.0.0' });

      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('error', { code: 'KEY_ALREADY_ONLINE', message: 'Key already has an active session' });
        expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
      });
    });
  });

  describe('heartbeat', () => {
    it('should refresh session and update heartbeat when authenticated', async () => {
      const mockSocket = createMockSocket();
      const mockIO = createMockIO();

      vi.mocked(lookupKey).mockResolvedValue({
        keyId: 'key123',
        keyHash: 'hashed-key',
        userId: 'user1',
        status: 'active',
        type: 'local',
      });
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
      vi.mocked(sessionService.acquireSession).mockResolvedValue(true);
      vi.mocked(Controller.findOneAndUpdate).mockResolvedValue({
        _id: { toString: () => 'ctrl123' },
      } as never);
      vi.mocked(ControllerKey.updateOne).mockResolvedValue({} as never);
      vi.mocked(Controller.updateOne).mockResolvedValue({} as never);

      createSocketIOServer(mockIO as never);

      const connectionHandler = mockIO._connectionHandler.mock.calls[0][0];
      connectionHandler(mockSocket);

      mockSocket._trigger('register', { key: 'zag_k_1_abc123', hostname: 'dev-machine', version: '1.0.0' });

      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('registered', { controllerId: 'ctrl123', resumeToken: 'test-resume-token' });
      });

      mockSocket._trigger('heartbeat');

      await vi.waitFor(() => {
        expect(sessionService.refreshSession).toHaveBeenCalledWith('key123');
        expect(sessionService.updateHeartbeat).toHaveBeenCalledWith('key123');
        expect(Controller.updateOne).toHaveBeenCalledWith(
          { keyId: 'key123' },
          { lastHeartbeatAt: expect.any(Date), lastIp: '127.0.0.1' },
        );
      });
    });

    it('should ignore heartbeat when not authenticated', async () => {
      const mockSocket = createMockSocket();
      const mockIO = createMockIO();

      createSocketIOServer(mockIO as never);

      const connectionHandler = mockIO._connectionHandler.mock.calls[0][0];
      connectionHandler(mockSocket);

      mockSocket._trigger('heartbeat');

      expect(sessionService.refreshSession).not.toHaveBeenCalled();
    });
  });

  describe('unregister', () => {
    it('should delete key and controller when authenticated', async () => {
      const mockSocket = createMockSocket();
      const mockIO = createMockIO();

      vi.mocked(lookupKey).mockResolvedValue({
        keyId: 'key123',
        keyHash: 'hashed-key',
        userId: 'user1',
        status: 'active',
        type: 'local',
      });
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
      vi.mocked(sessionService.acquireSession).mockResolvedValue(true);
      vi.mocked(Controller.findOneAndUpdate).mockResolvedValue({
        _id: { toString: () => 'ctrl123' },
      } as never);
      vi.mocked(ControllerKey.updateOne).mockResolvedValue({} as never);
      vi.mocked(Controller.deleteOne).mockResolvedValue({} as never);
      vi.mocked(ControllerKey.deleteOne).mockResolvedValue({} as never);
      vi.mocked(sessionService.cleanupKey).mockResolvedValue();

      createSocketIOServer(mockIO as never);

      const connectionHandler = mockIO._connectionHandler.mock.calls[0][0];
      connectionHandler(mockSocket);

      mockSocket._trigger('register', { key: 'zag_k_1_abc123', hostname: 'dev-machine', version: '1.0.0' });

      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('registered', { controllerId: 'ctrl123', resumeToken: 'test-resume-token' });
      });

      mockSocket._trigger('unregister', { reason: 'user_detach' });

      await vi.waitFor(() => {
        expect(Controller.deleteOne).toHaveBeenCalledWith({ keyId: 'key123' });
        expect(ControllerKey.deleteOne).toHaveBeenCalledWith({ _id: 'key123' });
        expect(sessionService.cleanupKey).toHaveBeenCalledWith('key123');
        expect(mockSocket.emit).toHaveBeenCalledWith('unregistered');
        expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
      });
    });

    it('should ignore unregister when not authenticated', async () => {
      const mockSocket = createMockSocket();
      const mockIO = createMockIO();

      createSocketIOServer(mockIO as never);

      const connectionHandler = mockIO._connectionHandler.mock.calls[0][0];
      connectionHandler(mockSocket);

      mockSocket._trigger('unregister', { reason: 'user_detach' });

      expect(Controller.deleteOne).not.toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('should remove session when authenticated', async () => {
      const mockSocket = createMockSocket();
      const mockIO = createMockIO();

      vi.mocked(lookupKey).mockResolvedValue({
        keyId: 'key123',
        keyHash: 'hashed-key',
        userId: 'user1',
        status: 'active',
        type: 'local',
      });
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
      vi.mocked(sessionService.acquireSession).mockResolvedValue(true);
      vi.mocked(Controller.findOneAndUpdate).mockResolvedValue({
        _id: { toString: () => 'ctrl123' },
      } as never);
      vi.mocked(ControllerKey.updateOne).mockResolvedValue({} as never);
      vi.mocked(sessionService.removeSession).mockResolvedValue();

      createSocketIOServer(mockIO as never);

      const connectionHandler = mockIO._connectionHandler.mock.calls[0][0];
      connectionHandler(mockSocket);

      mockSocket._trigger('register', { key: 'zag_k_1_abc123', hostname: 'dev-machine', version: '1.0.0' });

      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('registered', { controllerId: 'ctrl123', resumeToken: 'test-resume-token' });
      });

      mockSocket._trigger('disconnect');

      await vi.waitFor(() => {
        expect(sessionService.removeSession).toHaveBeenCalledWith('key123');
      });
    });

    it('should not remove session when not authenticated', async () => {
      const mockSocket = createMockSocket();
      const mockIO = createMockIO();

      createSocketIOServer(mockIO as never);

      const connectionHandler = mockIO._connectionHandler.mock.calls[0][0];
      connectionHandler(mockSocket);

      mockSocket._trigger('disconnect');

      expect(sessionService.removeSession).not.toHaveBeenCalled();
    });
  });
});
