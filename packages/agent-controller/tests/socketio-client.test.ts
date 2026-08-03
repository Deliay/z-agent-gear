import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockStart, mockStop, MockHeartbeat } = vi.hoisted(() => {
  const start = vi.fn();
  const stop = vi.fn();
  const HB = vi.fn().mockImplementation(function () {
    return { start, stop };
  });
  return { mockStart: start, mockStop: stop, MockHeartbeat: HB };
});

const { MockAcpSyncBridge, mockBridge } = vi.hoisted(() => {
  const bridge = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn(),
    deleteSession: vi.fn(),
    supportsDelete: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    resume: vi.fn(),
  };
  const Cls = vi.fn(function () { return bridge; });
  return { MockAcpSyncBridge: Cls, mockBridge: bridge };
});

vi.mock('../src/acp/sync-bridge.js', () => ({
  AcpSyncBridge: MockAcpSyncBridge,
}));

vi.mock('socket.io-client', () => ({
  io: vi.fn(),
}));

vi.mock('../src/heartbeat.js', () => ({
  Heartbeat: MockHeartbeat,
}));

vi.mock('../src/config.js', () => ({
  clearConfigKey: vi.fn(),
  saveKeyToConfig: vi.fn(),
  saveEndpointToConfig: vi.fn(),
  getResumeTokenFromConfig: vi.fn(),
  saveResumeTokenToConfig: vi.fn(),
  clearResumeTokenFromConfig: vi.fn(),
}));

vi.mock('os', () => ({
  hostname: vi.fn().mockReturnValue('test-machine'),
  platform: vi.fn(() => 'linux'),
  homedir: vi.fn(() => '/home/user'),
}));

vi.mock('fs/promises', () => ({
  readdir: vi.fn(),
  access: vi.fn(),
}));

vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>();
  return actual;
});

import { connectToServer, unregister } from '../src/socketio-client.js';
import { io } from 'socket.io-client';
import { clearConfigKey } from '../src/config.js';
import * as os from 'os';
import { readdir, access } from 'fs/promises';

function createMockSocket() {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handler;
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
    close: vi.fn(),
    _handlers: handlers,
    _trigger: (event: string, ...args: unknown[]) => {
      handlers[event]?.(...args);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStart.mockClear();
  mockStop.mockClear();
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SocketIO Client', () => {
  describe('connectToServer', () => {
    it('should create socket with correct options', () => {
      const mockSocket = createMockSocket();
      vi.mocked(io).mockReturnValue(mockSocket as never);

      connectToServer('http://localhost:4001', 'zag_k_1_abc123');

      expect(io).toHaveBeenCalledWith('http://localhost:4001', {
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 60000,
      });
    });

    it('should emit register on connect', () => {
      const mockSocket = createMockSocket();
      vi.mocked(io).mockReturnValue(mockSocket as never);

      connectToServer('http://localhost:4001', 'zag_k_1_abc123', { serverName: 'my-machine' });

      mockSocket._trigger('connect');

      expect(mockSocket.emit).toHaveBeenCalledWith('register', {
        key: 'zag_k_1_abc123',
        hostname: 'my-machine',
        version: '1.1.1',
        resumeToken: undefined,
      });
    });

    it('should use default hostname when serverName not provided', () => {
      const mockSocket = createMockSocket();
      vi.mocked(io).mockReturnValue(mockSocket as never);

      connectToServer('http://localhost:4001', 'zag_k_1_abc123');

      mockSocket._trigger('connect');

      expect(mockSocket.emit).toHaveBeenCalledWith('register', {
        key: 'zag_k_1_abc123',
        hostname: 'test-machine',
        version: '1.1.1',
        resumeToken: undefined,
      });
    });

    it('should start heartbeat on registered', () => {
      const mockSocket = createMockSocket();
      vi.mocked(io).mockReturnValue(mockSocket as never);

      connectToServer('http://localhost:4001', 'zag_k_1_abc123');

      mockSocket._trigger('registered', { controllerId: 'ctrl123' });

      expect(MockHeartbeat).toHaveBeenCalled();
      expect(mockStart).toHaveBeenCalled();
    });

    it('should disconnect and exit on error', () => {
      const mockSocket = createMockSocket();
      vi.mocked(io).mockReturnValue(mockSocket as never);

      connectToServer('http://localhost:4001', 'zag_k_1_abc123');

      mockSocket._trigger('error', { code: 'INVALID_KEY', message: 'Invalid key' });

      expect(mockSocket.disconnect).toHaveBeenCalled();
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('should clear config and exit on unregistered', () => {
      const mockSocket = createMockSocket();
      vi.mocked(io).mockReturnValue(mockSocket as never);

      connectToServer('http://localhost:4001', 'zag_k_1_abc123');

      mockSocket._trigger('unregistered');

      expect(mockStop).toHaveBeenCalled();
      expect(clearConfigKey).toHaveBeenCalled();
      expect(mockSocket.close).toHaveBeenCalled();
      expect(process.exit).toHaveBeenCalledWith(0);
    });

    it('should clear config and exit on shutdown', () => {
      const mockSocket = createMockSocket();
      vi.mocked(io).mockReturnValue(mockSocket as never);

      connectToServer('http://localhost:4001', 'zag_k_1_abc123');

      mockSocket._trigger('shutdown', { reason: 'key_revoked' });

      expect(mockStop).toHaveBeenCalled();
      expect(clearConfigKey).toHaveBeenCalled();
      expect(mockSocket.close).toHaveBeenCalled();
      expect(process.exit).toHaveBeenCalledWith(0);
    });

    it('should stop heartbeat on disconnect', () => {
      const mockSocket = createMockSocket();
      vi.mocked(io).mockReturnValue(mockSocket as never);

      connectToServer('http://localhost:4001', 'zag_k_1_abc123');

      mockSocket._trigger('disconnect', 'transport close');

      expect(mockStop).toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith('Disconnected: transport close');
    });

    it('should log on connect_error', () => {
      const mockSocket = createMockSocket();
      vi.mocked(io).mockReturnValue(mockSocket as never);

      connectToServer('http://localhost:4001', 'zag_k_1_abc123');

      mockSocket._trigger('connect_error', new Error('connection failed'));

      expect(console.error).toHaveBeenCalledWith('Connection error: connection failed');
    });
  });

  describe('unregister', () => {
    it('should emit unregister event', () => {
      const mockSocket = createMockSocket();
      vi.mocked(io).mockReturnValue(mockSocket as never);

      const socket = connectToServer('http://localhost:4001', 'zag_k_1_abc123');
      unregister(socket);

      expect(mockSocket.emit).toHaveBeenCalledWith('unregister', { reason: 'user_detach' });
    });
  });

  describe('fs:browse', () => {
    it('should list drives on Windows when path is /', async () => {
      vi.mocked(os.platform).mockReturnValue('win32');
      vi.mocked(access).mockImplementation(async (p: string) => {
        if (p === 'C:\\' || p === 'D:\\') return;
        throw new Error('not found');
      });

      const mockSocket = createMockSocket();
      vi.mocked(io).mockReturnValue(mockSocket as never);

      connectToServer('http://localhost:4001', 'zag_k_1_abc123');
      mockSocket._trigger('connect');
      mockSocket._trigger('registered', { controllerId: 'ctrl-1' });

      mockSocket._trigger('fs:browse', { requestId: 'req-1', path: '/' });
      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('fs:browse:result', {
          requestId: 'req-1',
          entries: [
            { name: 'C:', path: 'C:\\', isDirectory: true },
            { name: 'D:', path: 'D:\\', isDirectory: true },
          ],
        });
      });
    });

    it('should list drives on Windows when path is empty string', async () => {
      vi.mocked(os.platform).mockReturnValue('win32');
      vi.mocked(access).mockImplementation(async (p: string) => {
        if (p === 'C:\\') return;
        throw new Error('not found');
      });

      const mockSocket = createMockSocket();
      vi.mocked(io).mockReturnValue(mockSocket as never);

      connectToServer('http://localhost:4001', 'zag_k_1_abc123');
      mockSocket._trigger('connect');
      mockSocket._trigger('registered', { controllerId: 'ctrl-1' });

      mockSocket._trigger('fs:browse', { requestId: 'req-2', path: '' });
      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('fs:browse:result', {
          requestId: 'req-2',
          entries: [
            { name: 'C:', path: 'C:\\', isDirectory: true },
          ],
        });
      });
    });

    it('should NOT list drives on Linux when path is /', async () => {
      vi.mocked(os.platform).mockReturnValue('linux');
      vi.mocked(readdir).mockResolvedValue([
        { name: 'home', isDirectory: () => true },
        { name: 'usr', isDirectory: () => true },
      ] as never);

      const mockSocket = createMockSocket();
      vi.mocked(io).mockReturnValue(mockSocket as never);

      connectToServer('http://localhost:4001', 'zag_k_1_abc123');
      mockSocket._trigger('connect');
      mockSocket._trigger('registered', { controllerId: 'ctrl-1' });

      mockSocket._trigger('fs:browse', { requestId: 'req-3', path: '/' });
      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('fs:browse:result', {
          requestId: 'req-3',
          entries: [
            { name: 'home', path: '/home', isDirectory: true },
            { name: 'usr', path: '/usr', isDirectory: true },
          ],
        });
      });
    });

    it('should skip unavailable drives on Windows', async () => {
      vi.mocked(os.platform).mockReturnValue('win32');
      vi.mocked(access).mockImplementation(async (p: string) => {
        if (p === 'C:\\') return;
        throw new Error('not found');
      });

      const mockSocket = createMockSocket();
      vi.mocked(io).mockReturnValue(mockSocket as never);

      connectToServer('http://localhost:4001', 'zag_k_1_abc123');
      mockSocket._trigger('connect');
      mockSocket._trigger('registered', { controllerId: 'ctrl-1' });

      mockSocket._trigger('fs:browse', { requestId: 'req-4', path: '/' });
      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('fs:browse:result', {
          requestId: 'req-4',
          entries: [
            { name: 'C:', path: 'C:\\', isDirectory: true },
          ],
        });
      });
    });
  });

  describe('acp:list-sessions', () => {
    function setup() {
      mockBridge.connect.mockClear();
      mockBridge.disconnect.mockClear();
      mockBridge.listSessions.mockClear();
      const mockSocket = createMockSocket();
      vi.mocked(io).mockReturnValue(mockSocket as never);
      connectToServer('http://localhost:4001', 'zag_k_1_abc123');
      mockSocket._trigger('connect');
      mockSocket._trigger('registered', { controllerId: 'ctrl-1' });
      return mockSocket;
    }

    it('should pass cursor and emit nextCursor in result', async () => {
      mockBridge.listSessions.mockResolvedValue({
        sessions: [{ sessionId: 'hist-2', title: 'Session 2', cwd: '/home/user', updatedAt: null }],
        nextCursor: 'cursor-2',
      });
      const mockSocket = setup();

      mockSocket._trigger('acp:list-sessions', {
        requestId: 'req-1',
        serverType: 'opencode',
        cwd: '/home/user',
        cursor: 'cursor-1',
      });

      await vi.waitFor(() => {
        expect(mockBridge.listSessions).toHaveBeenCalledWith('/home/user', 'cursor-1');
        expect(mockSocket.emit).toHaveBeenCalledWith('acp:list-sessions:result', {
          requestId: 'req-1',
          success: true,
          sessions: [{ sessionId: 'hist-2', title: 'Session 2', cwd: '/home/user', updatedAt: null }],
          nextCursor: 'cursor-2',
        });
      });
    });

    it('should omit nextCursor when absent', async () => {
      mockBridge.listSessions.mockResolvedValue({
        sessions: [{ sessionId: 'hist-1', title: 'Session 1', cwd: '/home/user', updatedAt: null }],
      });
      const mockSocket = setup();

      mockSocket._trigger('acp:list-sessions', {
        requestId: 'req-2',
        serverType: 'opencode',
        cwd: '/home/user',
      });

      await vi.waitFor(() => {
        expect(mockBridge.listSessions).toHaveBeenCalledWith('/home/user', undefined);
        expect(mockSocket.emit).toHaveBeenCalledWith('acp:list-sessions:result', {
          requestId: 'req-2',
          success: true,
          sessions: [{ sessionId: 'hist-1', title: 'Session 1', cwd: '/home/user', updatedAt: null }],
        });
      });
    });

    it('should emit failure result on error', async () => {
      mockBridge.listSessions.mockRejectedValue(new Error('boom'));
      const mockSocket = setup();

      mockSocket._trigger('acp:list-sessions', {
        requestId: 'req-3',
        serverType: 'opencode',
        cwd: '/home/user',
      });

      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('acp:list-sessions:result', {
          requestId: 'req-3',
          success: false,
          error: 'boom',
        });
      });
    });
  });

  describe('acp:delete-history-session', () => {
    function setup() {
      mockBridge.connect.mockClear();
      mockBridge.disconnect.mockClear();
      mockBridge.deleteSession.mockClear();
      mockBridge.supportsDelete.mockClear();
      const mockSocket = createMockSocket();
      vi.mocked(io).mockReturnValue(mockSocket as never);
      connectToServer('http://localhost:4001', 'zag_k_1_abc123');
      mockSocket._trigger('connect');
      mockSocket._trigger('registered', { controllerId: 'ctrl-1' });
      return mockSocket;
    }

    it('should delete session via sync bridge when supported', async () => {
      mockBridge.supportsDelete.mockReturnValue(true);
      mockBridge.deleteSession.mockResolvedValue(undefined);
      const mockSocket = setup();

      mockSocket._trigger('acp:delete-history-session', {
        requestId: 'req-1',
        sessionId: 'db-id-1',
        externalSessionId: 'ext-1',
        cwd: '/home/user',
        serverType: 'opencode',
      });

      await vi.waitFor(() => {
        expect(mockBridge.connect).toHaveBeenCalled();
        expect(mockBridge.supportsDelete).toHaveBeenCalled();
        expect(mockBridge.deleteSession).toHaveBeenCalledWith('ext-1');
        expect(mockSocket.emit).toHaveBeenCalledWith('acp:delete-history-session:result', {
          requestId: 'req-1',
          sessionId: 'db-id-1',
          success: true,
          supported: true,
        });
      });
    });

    it('should report unsupported without deleting when agent lacks capability', async () => {
      mockBridge.supportsDelete.mockReturnValue(false);
      const mockSocket = setup();

      mockSocket._trigger('acp:delete-history-session', {
        requestId: 'req-2',
        sessionId: 'db-id-2',
        externalSessionId: 'ext-2',
        cwd: '/home/user',
      });

      await vi.waitFor(() => {
        expect(mockBridge.deleteSession).not.toHaveBeenCalled();
        expect(mockSocket.emit).toHaveBeenCalledWith('acp:delete-history-session:result', {
          requestId: 'req-2',
          sessionId: 'db-id-2',
          success: false,
          supported: false,
          error: 'Session delete not supported by agent',
        });
      });
    });

    it('should emit failure result on error', async () => {
      mockBridge.supportsDelete.mockReturnValue(true);
      mockBridge.deleteSession.mockRejectedValue(new Error('boom'));
      const mockSocket = setup();

      mockSocket._trigger('acp:delete-history-session', {
        requestId: 'req-3',
        sessionId: 'db-id-3',
        externalSessionId: 'ext-3',
        cwd: '/home/user',
      });

      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('acp:delete-history-session:result', {
          requestId: 'req-3',
          sessionId: 'db-id-3',
          success: false,
          supported: true,
          error: 'boom',
        });
      });
    });
  });
});
