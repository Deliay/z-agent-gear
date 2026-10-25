import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

const mockRedis = {
  publish: vi.fn().mockResolvedValue(1),
  lrange: vi.fn().mockResolvedValue([]),
  del: vi.fn().mockResolvedValue(1),
};

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

vi.mock('../models/session.js', () => ({
  Session: {
    find: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
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
import { getRedisClient } from '../middleware/redis.js';
import bcrypt from 'bcryptjs';

function createMockSocket() {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    id: 'socket-123',
    handshake: {
      address: '127.0.0.1',
      headers: { 'user-agent': 'vitest' },
      query: { transport: 'websocket' },
      auth: {},
    },
    nsp: { name: '/' },
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
  vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
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

      mockSocket._trigger('register', { key: 'zag_k_1_abc123', hostname: 'dev-machine', version: '2.0.0' });

      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('registered', { controllerId: 'ctrl123', resumeToken: 'test-resume-token' });
      });

      // 注册成功后下发重连对账事件（activeSessionIds/pendingKillSessionIds）
      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('acp:reconcile', {
          activeSessionIds: [],
          pendingKillSessionIds: [],
        });
      });
    });

    it('should persist homeDir/platform on register with extended payload (T-S1)', async () => {
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

      mockSocket._trigger('register', {
        key: 'zag_k_1_abc123',
        hostname: 'dev-machine',
        version: '2.0.0',
        homeDir: '/home/user',
        platform: 'linux',
      });

      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('registered', { controllerId: 'ctrl123', resumeToken: 'test-resume-token' });
      });

      const upsertCall = vi.mocked(Controller.findOneAndUpdate).mock.calls[0]!;
      expect(upsertCall[1]).toMatchObject({ homeDir: '/home/user', platform: 'linux' });
    });

    it('should handle old payload without homeDir/platform without error (T-S2)', async () => {
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

      mockSocket._trigger('register', { key: 'zag_k_1_abc123', hostname: 'dev-machine', version: '2.0.0' });

      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('registered', { controllerId: 'ctrl123', resumeToken: 'test-resume-token' });
      });

      const upsertCall = vi.mocked(Controller.findOneAndUpdate).mock.calls[0]!;
      const updateArg = upsertCall[1] as Record<string, unknown>;
      expect(updateArg.homeDir).toBeUndefined();
      expect(updateArg.platform).toBeUndefined();
    });

    it('should reject with INVALID_KEY when key not found', async () => {
      const mockSocket = createMockSocket();
      const mockIO = createMockIO();

      vi.mocked(lookupKey).mockResolvedValue(null);

      createSocketIOServer(mockIO as never);

      const connectionHandler = mockIO._connectionHandler.mock.calls[0][0];
      connectionHandler(mockSocket);

      mockSocket._trigger('register', { key: 'invalid-key', hostname: 'dev-machine', version: '2.0.0' });

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

      mockSocket._trigger('register', { key: 'wrong-key', hostname: 'dev-machine', version: '2.0.0' });

      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('error', { code: 'INVALID_KEY', message: 'Invalid key' });
        expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
      });
    });

    it('should reject with VERSION_MISMATCH when major version is 1', async () => {
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

      mockSocket._trigger('register', { key: 'zag_k_1_abc123', hostname: 'dev-machine', version: '1.5.0' });

      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('error', { code: 'VERSION_MISMATCH', message: 'Version mismatch' });
        expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
      });
    });

    it('should accept register when major version is 2', async () => {
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

      mockSocket._trigger('register', { key: 'zag_k_1_abc123', hostname: 'dev-machine', version: '2.0.0' });

      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('registered', { controllerId: 'ctrl123', resumeToken: 'test-resume-token' });
      });
      expect(mockSocket.emit).not.toHaveBeenCalledWith('error', { code: 'VERSION_MISMATCH', message: 'Version mismatch' });
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

      mockSocket._trigger('register', { key: 'zag_k_1_abc123', hostname: 'dev-machine', version: '2.0.0' });

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

      mockSocket._trigger('register', { key: 'zag_k_1_abc123', hostname: 'dev-machine', version: '2.0.0' });

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

      mockSocket._trigger('register', { key: 'zag_k_1_abc123', hostname: 'dev-machine', version: '2.0.0' });

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
    it('logs connection handshake so anonymous sources can be traced', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const mockSocket = createMockSocket();
      const mockIO = createMockIO();

      createSocketIOServer(mockIO as never);
      const connectionHandler = mockIO._connectionHandler.mock.calls[0][0];
      connectionHandler(mockSocket);

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('[socket] connected id=socket-123 address=127.0.0.1'),
      );

      mockSocket._trigger('disconnect', 'transport close');

      await vi.waitFor(() => {
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining(
            '[socket] disconnected id=socket-123 address=127.0.0.1 ns=/ key=- authenticated=false reason=transport close',
          ),
        );
      });

      log.mockRestore();
    });

    it('does not print undefined for anonymous disconnect', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const mockSocket = createMockSocket();
      const mockIO = createMockIO();

      createSocketIOServer(mockIO as never);
      const connectionHandler = mockIO._connectionHandler.mock.calls[0][0];
      connectionHandler(mockSocket);

      mockSocket._trigger('disconnect', 'client namespace disconnect');

      await vi.waitFor(() => {
        const lines = log.mock.calls.map((call) => String(call[0]));
        expect(lines.some((line) => line.includes('[socket] disconnected'))).toBe(true);
        expect(lines.join('\n')).not.toContain('undefined');
      });

      log.mockRestore();
    });

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

      mockSocket._trigger('register', { key: 'zag_k_1_abc123', hostname: 'dev-machine', version: '2.0.0' });

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

  describe('acp:protocol-version-mismatch', () => {
    function setupAuthenticated() {
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

      mockSocket._trigger('register', { key: 'zag_k_1_abc123', hostname: 'dev-machine', version: '2.0.0' });
      return mockSocket;
    }

    it('should publish protocol version mismatch to session:status channel', async () => {
      vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
      const mockSocket = setupAuthenticated();

      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('registered', expect.anything());
      });

      mockSocket._trigger('acp:protocol-version-mismatch', {
        sessionId: 'sess-1',
        expectedVersion: 1,
        agentVersion: 2,
      });

      await vi.waitFor(() => {
        expect(mockRedis.publish).toHaveBeenCalledWith('session:status', JSON.stringify({
          sessionId: 'sess-1',
          protocolVersionMismatch: { expectedVersion: 1, agentVersion: 2 },
        }));
      });
    });
  });
});

describe('SocketIO Service - elicitation resolved', () => {
  it('T-S7: 未认证 socket 发送 acp:elicitation:resolved 时零发布', async () => {
    const mockSocket = createMockSocket();
    const mockIO = createMockIO();

    createSocketIOServer(mockIO as never);
    const connectionHandler = mockIO._connectionHandler.mock.calls[0][0];
    connectionHandler(mockSocket);

    mockSocket._trigger('acp:elicitation:resolved', {
      sessionId: 'sess-1',
      reason: 'timeout',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockRedis.publish).not.toHaveBeenCalledWith('elicitation:resolved', expect.anything());
  });
});
