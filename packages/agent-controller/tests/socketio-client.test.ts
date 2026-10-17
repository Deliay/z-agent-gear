import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockStart, mockStop, MockHeartbeat } = vi.hoisted(() => {
  const start = vi.fn();
  const stop = vi.fn();
  const HB = vi.fn().mockImplementation(function () {
    return { start, stop };
  });
  return { mockStart: start, mockStop: stop, MockHeartbeat: HB };
});

const { relayInstances, localServerInstances } = vi.hoisted(() => ({
  relayInstances: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
  localServerInstances: [] as Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; port: number }>,
}));

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

const { bridgeInstances } = vi.hoisted(() => ({
  bridgeInstances: [] as Array<{ sessionId: string; emit: (event: string, payload: unknown) => boolean }>,
}));

vi.mock('../src/acp/bridge.js', async () => {
  const { EventEmitter } = await import('events');
  class FakeAcpSessionBridge extends EventEmitter {
    sessionId: string;
    constructor(_socket: unknown, options: { sessionId: string }, _spawner: unknown) {
      super();
      this.sessionId = options.sessionId;
      bridgeInstances.push(this as never);
    }
    async start() {
      this.emit('acp:initialized', {
        sessionId: this.sessionId,
        acpSessionId: 'acp-ext-1',
        modes: [],
        availableModels: [],
        configOptions: [],
        authMethods: [],
      });
    }
    async resume() {
      this.emit('acp:initialized', {
        sessionId: this.sessionId,
        acpSessionId: 'acp-ext-1',
        modes: [],
        availableModels: [],
        configOptions: [],
        authMethods: [],
      });
    }
    async stop() {
      this.emit('acp:stopped', { sessionId: this.sessionId, reason: 'user_close' });
    }
    sendInput() {}
    cancel() {}
  }
  return { AcpSessionBridge: FakeAcpSessionBridge };
});

vi.mock('../src/acp/spawner.js', () => ({
  AcpSpawner: class {
    pid = 4321;
    constructor(_options: unknown) {}
    start() {}
    stop() {}
    get closed() { return Promise.resolve(); }
  },
}));

vi.mock('../src/acp/detector.js', () => ({
  acpDetector: {
    detect: vi.fn(async () => []),
    getSpawnerConfig: vi.fn(() => ({ command: 'opencode', args: ['acp'] })),
  },
}));

vi.mock('../src/acp/process-registry.js', () => ({
  processRegistry: {
    register: vi.fn(),
    deregister: vi.fn(),
    get: vi.fn(),
    list: vi.fn(() => []),
    listEntries: vi.fn(() => []),
  },
  isProcessAlive: vi.fn(() => true),
}));

vi.mock('socket.io-client', () => ({
  io: vi.fn(),
}));

vi.mock('../src/heartbeat.js', () => ({
  Heartbeat: MockHeartbeat,
}));

vi.mock('../src/mcp/relay.js', () => ({
  McpRelay: class {
    registerSession = vi.fn();
    unregisterSession = vi.fn();
    handleDisconnect = vi.fn();
    handleMcpResponse = vi.fn();
    hasSession = vi.fn(() => true);
    hasServer = vi.fn(() => true);
    forward = vi.fn();
    constructor() {
      relayInstances.push(this as never);
    }
  },
}));

vi.mock('../src/mcp/local-server.js', () => ({
  LocalMcpServer: class {
    port = 0;
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
    constructor() {
      localServerInstances.push(this as never);
    }
  },
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
import { fsHandler } from '../src/fs-handler.js';
import { processRegistry, isProcessAlive } from '../src/acp/process-registry.js';

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
  relayInstances.length = 0;
  localServerInstances.length = 0;
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
        auth: { token: 'zag_k_1_abc123' },
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
        version: '2.1.1',
        resumeToken: undefined,
        homeDir: '/home/user',
        platform: 'linux',
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
        version: '2.1.1',
        resumeToken: undefined,
        homeDir: '/home/user',
        platform: 'linux',
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

  describe('acp:set-config-option', () => {
    it('should emit failure result when bridge not found', async () => {
      const mockSocket = createMockSocket();
      vi.mocked(io).mockReturnValue(mockSocket as never);
      connectToServer('http://localhost:4001', 'zag_k_1_abc123');
      mockSocket._trigger('connect');
      mockSocket._trigger('registered', { controllerId: 'ctrl-1' });

      mockSocket._trigger('acp:set-config-option', {
        sessionId: 'unknown-sess',
        configId: 'opt-1',
        value: 'val-1',
      });

      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('acp:set-config-option:result', {
          sessionId: 'unknown-sess',
          success: false,
          configId: 'opt-1',
          error: 'ACP bridge not found for session',
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

  describe('acp:start registry lifecycle', () => {
    function setup() {
      bridgeInstances.length = 0;
      const mockSocket = createMockSocket();
      vi.mocked(io).mockReturnValue(mockSocket as never);
      connectToServer('http://localhost:4001', 'zag_k_1_abc123');
      return mockSocket;
    }

    async function startSession(mockSocket: ReturnType<typeof createMockSocket>, sessionId: string, cwd: string) {
      mockSocket._trigger('acp:start', {
        requestId: 'req-start',
        sessionId,
        serverType: 'opencode',
        cwd,
      });
      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('acp:start:result', expect.objectContaining({ sessionId, success: true }));
      });
    }

    it('registers the session cwd as an allowed fs path', async () => {
      const registerSpy = vi.spyOn(fsHandler, 'registerAllowedPath');
      const mockSocket = setup();

      await startSession(mockSocket, 'sess-1', '/home/user/wt-1');

      expect(registerSpy).toHaveBeenCalledWith('/home/user/wt-1');
    });

    it('stops the previous bridge when acp:start arrives for the same sessionId again', async () => {
      const mockSocket = setup();
      await startSession(mockSocket, 'sess-1', '/home/user/wt-1');
      const oldBridge = bridgeInstances[0] as unknown as { stop: () => Promise<void> };
      const stopSpy = vi.spyOn(oldBridge, 'stop');

      // 同 sessionId 再次 acp:start（如超时重试/兜底 resume 后迟到）：旧 bridge 必须先停，
      // 否则同会话双进程、旧 bridge 泄漏
      mockSocket._trigger('acp:start', {
        requestId: 'req-start-2',
        sessionId: 'sess-1',
        serverType: 'opencode',
        cwd: '/home/user/wt-1',
      });

      await vi.waitFor(() => {
        expect(stopSpy).toHaveBeenCalled();
      });
      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('acp:start:result', expect.objectContaining({
          requestId: 'req-start-2',
          sessionId: 'sess-1',
          success: true,
        }));
      });
      expect(bridgeInstances).toHaveLength(2);
    });

    it('deregisters the PID when the bridge emits acp:stopped', async () => {
      const mockSocket = setup();
      await startSession(mockSocket, 'sess-1', '/home/user/wt-1');
      vi.mocked(processRegistry.deregister).mockClear();

      bridgeInstances[0].emit('acp:stopped', { sessionId: 'sess-1', reason: 'user_close' });

      expect(processRegistry.deregister).toHaveBeenCalledWith('sess-1');
    });

    it('deregisters the PID on the acp:stop bridge path', async () => {
      const mockSocket = setup();
      await startSession(mockSocket, 'sess-1', '/home/user/wt-1');
      vi.mocked(processRegistry.deregister).mockClear();

      mockSocket._trigger('acp:stop', { sessionId: 'sess-1' });

      await vi.waitFor(() => {
        expect(processRegistry.deregister).toHaveBeenCalledWith('sess-1');
      });
    });
  });

  describe('acp:stop fallback kill', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.mocked(os.platform).mockReturnValue('linux');
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function setup() {
      bridgeInstances.length = 0;
      const mockSocket = createMockSocket();
      vi.mocked(io).mockReturnValue(mockSocket as never);
      connectToServer('http://localhost:4001', 'zag_k_1_abc123');
      return mockSocket;
    }

    it('kills by registry PID and probes liveness before SIGKILL', async () => {
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
      vi.mocked(processRegistry.get).mockReturnValue({ pid: 2222, cwd: '/x', acpServerType: 'opencode', startedAt: '2026-01-01' });
      vi.mocked(isProcessAlive).mockReturnValue(true);
      const mockSocket = setup();

      mockSocket._trigger('acp:stop', { sessionId: 'sess-x', ackRequired: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(killSpy).toHaveBeenCalledWith(-2222, 'SIGTERM');
      expect(processRegistry.deregister).toHaveBeenCalledWith('sess-x');
      expect(mockSocket.emit).toHaveBeenCalledWith('acp:stopped', {
        sessionId: 'sess-x',
        reason: 'user_close',
        killed: true,
      });

      await vi.advanceTimersByTimeAsync(5000);
      expect(isProcessAlive).toHaveBeenCalledWith(2222);
      expect(killSpy).toHaveBeenCalledWith(-2222, 'SIGKILL');
    });

    it('skips SIGKILL when the process is already dead (PID reuse guard)', async () => {
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
      vi.mocked(processRegistry.get).mockReturnValue({ pid: 2222, cwd: '/x', acpServerType: 'opencode', startedAt: '2026-01-01' });
      vi.mocked(isProcessAlive).mockReturnValue(false);
      const mockSocket = setup();

      mockSocket._trigger('acp:stop', { sessionId: 'sess-x' });
      await vi.advanceTimersByTimeAsync(0);
      expect(killSpy).toHaveBeenCalledWith(-2222, 'SIGTERM');

      await vi.advanceTimersByTimeAsync(5000);
      expect(killSpy).not.toHaveBeenCalledWith(-2222, 'SIGKILL');
    });

    it('ignores malformed payloads with a warning', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
      const mockSocket = setup();

      mockSocket._trigger('acp:stop', { ackRequired: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(warnSpy).toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
      expect(mockSocket.emit).not.toHaveBeenCalledWith('acp:stopped', expect.anything());
    });
  });

  describe('acp:reconcile', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.mocked(os.platform).mockReturnValue('linux');
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function setup() {
      bridgeInstances.length = 0;
      const mockSocket = createMockSocket();
      vi.mocked(io).mockReturnValue(mockSocket as never);
      connectToServer('http://localhost:4001', 'zag_k_1_abc123');
      return mockSocket;
    }

    it('kills orphan registry entries and probes liveness before SIGKILL', async () => {
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
      vi.mocked(processRegistry.listEntries).mockReturnValue([
        { sessionId: 's1', pid: 3333, cwd: '/x', acpServerType: 'opencode', startedAt: '2026-01-01' },
      ]);
      vi.mocked(isProcessAlive).mockReturnValue(false);
      const mockSocket = setup();

      mockSocket._trigger('acp:reconcile', { activeSessionIds: [], pendingKillSessionIds: [] });
      await vi.advanceTimersByTimeAsync(0);

      expect(killSpy).toHaveBeenCalledWith(-3333, 'SIGTERM');
      expect(processRegistry.deregister).toHaveBeenCalledWith('s1');

      await vi.advanceTimersByTimeAsync(5000);
      expect(isProcessAlive).toHaveBeenCalledWith(3333);
      expect(killSpy).not.toHaveBeenCalledWith(-3333, 'SIGKILL');
    });

    it('keeps sessions listed in activeSessionIds', async () => {
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
      vi.mocked(processRegistry.listEntries).mockReturnValue([
        { sessionId: 's1', pid: 3333, cwd: '/x', acpServerType: 'opencode', startedAt: '2026-01-01' },
      ]);
      const mockSocket = setup();

      mockSocket._trigger('acp:reconcile', { activeSessionIds: ['s1'], pendingKillSessionIds: [] });
      await vi.advanceTimersByTimeAsync(5000);

      expect(killSpy).not.toHaveBeenCalled();
      expect(processRegistry.deregister).not.toHaveBeenCalled();
    });

    it('ignores malformed payloads with a warning', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
      const mockSocket = setup();
      // connectToServer seeds the fs whitelist via listEntries once; clear it
      vi.mocked(processRegistry.listEntries).mockClear();

      mockSocket._trigger('acp:reconcile', { activeSessionIds: 'oops', pendingKillSessionIds: null });
      await vi.advanceTimersByTimeAsync(0);

      expect(warnSpy).toHaveBeenCalled();
      expect(processRegistry.listEntries).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
    });
  });

  describe('MCP local endpoint lifecycle', () => {
    function setup() {
      bridgeInstances.length = 0;
      const mockSocket = createMockSocket();
      vi.mocked(io).mockReturnValue(mockSocket as never);
      connectToServer('http://localhost:4001', 'zag_k_1_abc123');
      return mockSocket;
    }

    it('starts the local loopback server exactly once at daemon startup and never stops on disconnect', async () => {
      const mockSocket = setup();
      const server = localServerInstances[0];
      expect(server).toBeDefined();
      expect(server.start).toHaveBeenCalledTimes(1);

      // 断线→重连后服务不停止、端口不变（存活会话注入的旧 URL 仍可用）
      mockSocket._trigger('disconnect', 'transport close');
      expect(server.stop).not.toHaveBeenCalled();
      mockSocket._trigger('connect');
      expect(server.start).toHaveBeenCalledTimes(1);
      // disconnect 仅触发 relay 快速失败（503），不触碰 HTTP 服务
      const relay = relayInstances[0];
      expect(relay.handleDisconnect).toHaveBeenCalled();
    });

    it('registers the session endpoint and injects the loopback port on acp:start', async () => {
      const mockSocket = setup();
      localServerInstances[0].port = 34567;
      const relay = relayInstances[0];

      mockSocket._trigger('acp:start', {
        requestId: 'req-mcp',
        sessionId: 'sess-mcp',
        serverType: 'opencode',
        cwd: '/home/user/wt',
        mcpEndpoint: { token: 'tok-1', serverNames: ['tools', 'proxy'] },
      });

      await vi.waitFor(() => {
        expect(relay.registerSession).toHaveBeenCalledWith('sess-mcp', {
          token: 'tok-1',
          serverNames: ['tools', 'proxy'],
        });
      });
      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('acp:start:result', expect.objectContaining({ sessionId: 'sess-mcp', success: true }));
      });
    });

    it('fails loudly (does not inject port 0) when the loopback server is not listening', async () => {
      const mockSocket = setup();
      localServerInstances[0].port = 0;
      const relay = relayInstances[0];

      mockSocket._trigger('acp:start', {
        requestId: 'req-mcp0',
        sessionId: 'sess-mcp0',
        serverType: 'opencode',
        cwd: '/home/user/wt',
        mcpEndpoint: { token: 'tok-0', serverNames: ['tools'] },
      });

      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('acp:start:result', expect.objectContaining({
          sessionId: 'sess-mcp0',
          success: false,
        }));
      });
      // registerSession 不得被调用（端口校验失败，不注入坏 URL）
      expect(relay.registerSession).not.toHaveBeenCalledWith('sess-mcp0', expect.anything());
    });

    it('routes mcp:response to the relay', async () => {
      const mockSocket = setup();
      const relay = relayInstances[0];

      mockSocket._trigger('mcp:response', { requestId: 'mcpreq_1', status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } });

      expect(relay.handleMcpResponse).toHaveBeenCalledWith('mcpreq_1', 200, { jsonrpc: '2.0', id: 1, result: {} });
    });

    it('outputs an upgrade guide and exits on VERSION_MISMATCH', () => {
      const mockSocket = setup();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockSocket._trigger('error', { code: 'VERSION_MISMATCH', message: 'Version mismatch' });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('upgrade agent-controller'));
      expect(mockSocket.disconnect).toHaveBeenCalled();
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('unregisters the session endpoint when the agent process exits on its own (onStopped)', async () => {
      const mockSocket = setup();
      localServerInstances[0].port = 34567;
      const relay = relayInstances[0];

      mockSocket._trigger('acp:start', {
        requestId: 'req-exit',
        sessionId: 'sess-exit',
        serverType: 'opencode',
        cwd: '/home/user/wt',
        mcpEndpoint: { token: 'tok-x', serverNames: ['tools'] },
      });
      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('acp:start:result', expect.objectContaining({ sessionId: 'sess-exit', success: true }));
      });

      vi.mocked(relay.unregisterSession).mockClear();
      bridgeInstances[0].emit('acp:stopped', { sessionId: 'sess-exit', reason: 'user_close' });

      expect(relay.unregisterSession).toHaveBeenCalledWith('sess-exit');
    });

    it('unregisters the session endpoint on acp:stop', async () => {
      const mockSocket = setup();
      localServerInstances[0].port = 34567;
      const relay = relayInstances[0];

      mockSocket._trigger('acp:start', {
        requestId: 'req-stop',
        sessionId: 'sess-stop',
        serverType: 'opencode',
        cwd: '/home/user/wt',
        mcpEndpoint: { token: 'tok-s', serverNames: ['tools'] },
      });
      await vi.waitFor(() => {
        expect(mockSocket.emit).toHaveBeenCalledWith('acp:start:result', expect.objectContaining({ sessionId: 'sess-stop', success: true }));
      });

      vi.mocked(relay.unregisterSession).mockClear();
      mockSocket._trigger('acp:stop', { sessionId: 'sess-stop' });

      await vi.waitFor(() => {
        expect(relay.unregisterSession).toHaveBeenCalledWith('sess-stop');
      });
    });

    it('unregisters the session endpoint on acp:reconcile kill', async () => {
      const mockSocket = setup();
      vi.mocked(processRegistry.listEntries).mockReturnValue([
        { sessionId: 's-recon', pid: 4444, cwd: '/x', acpServerType: 'opencode', startedAt: '2026-01-01' },
      ]);
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
      vi.mocked(isProcessAlive).mockReturnValue(false);
      const relay = relayInstances[0];
      vi.mocked(relay.unregisterSession).mockClear();

      mockSocket._trigger('acp:reconcile', { activeSessionIds: [], pendingKillSessionIds: [] });

      await vi.waitFor(() => {
        expect(relay.unregisterSession).toHaveBeenCalledWith('s-recon');
      });
      expect(killSpy).toHaveBeenCalledWith(-4444, 'SIGTERM');
    });
  });
});
