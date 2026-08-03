import { describe, it, expect, vi, beforeEach } from 'vitest';

function buildMockConn() {
  return {
    initialize: vi.fn<[unknown], Promise<{ protocolVersion: number }>>().mockResolvedValue({ protocolVersion: 1 }),
    newSession: vi.fn<[unknown], Promise<{ sessionId: string }>>().mockResolvedValue({ sessionId: 'sync-sess-1' }),
    listSessions: vi.fn<[unknown], Promise<{ sessions: Array<{ sessionId: string; title: string | null; cwd: string; updatedAt: string | null }>; nextCursor?: string | null }>>()
      .mockResolvedValue({ sessions: [{ sessionId: 'hist-1', title: 'Session 1', cwd: '/home/user', updatedAt: '2026-01-01T00:00:00Z' }] }),
    deleteSession: vi.fn<[unknown], Promise<object>>().mockResolvedValue({}),
    loadSession: vi.fn<[unknown], Promise<object>>().mockResolvedValue({}),
    cancel: vi.fn<[unknown], Promise<void>>().mockResolvedValue(undefined),
    closeSession: vi.fn<[unknown], Promise<object>>().mockResolvedValue({}),
  };
}

let mockConnInstance = buildMockConn();

vi.mock('@agentclientprotocol/sdk', () => ({
  ndJsonStream: vi.fn(() => ({})),
  ClientSideConnection: vi.fn(function () { return mockConnInstance; }),
}));

import { AcpSyncBridge } from '../src/acp/sync-bridge.js';

class MockAcpSpawner {
  start = vi.fn();
  stop = vi.fn();
  isRunning = vi.fn().mockReturnValue(true);
  _stdin = new WritableStream();
  _stdout = new ReadableStream();
  private _resolveClosed: (() => void) | null = null;
  private _closed: Promise<void>;

  constructor() {
    this._closed = new Promise((resolve) => { this._resolveClosed = resolve; });
  }

  get stdin() { return this._stdin; }
  get stdout() { return this._stdout; }
  get closed() { return this._closed; }

  triggerExit() {
    this._resolveClosed?.();
  }
}

function createBridge(spawner?: MockAcpSpawner) {
  return new AcpSyncBridge({ cwd: '/home/user' }, spawner as never);
}

function mc() { return mockConnInstance; }

describe('AcpSyncBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnInstance = buildMockConn();
  });

  describe('connect', () => {
    it('should spawn ACP process and initialize connection', async () => {
      const mockSpawner = new MockAcpSpawner();
      const bridge = createBridge(mockSpawner);
      await bridge.connect();

      expect(mockSpawner.start).toHaveBeenCalledOnce();
      expect(mc().initialize).toHaveBeenCalledWith({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'agent-gear', version: '1.0.0' },
      });
    });

    it('should throw when connection fails', async () => {
      mc().initialize.mockRejectedValue(new Error('connection failed'));
      const mockSpawner = new MockAcpSpawner();
      const bridge = createBridge(mockSpawner);

      await expect(bridge.connect()).rejects.toThrow('connection failed');
    });

    it('should throw when process exits during connect', async () => {
      mc().initialize.mockReturnValue(new Promise(() => {}));
      const mockSpawner = new MockAcpSpawner();
      const bridge = createBridge(mockSpawner);

      mockSpawner.triggerExit();

      await expect(bridge.connect()).rejects.toThrow('ACP process exited unexpectedly');
    });

    it('should throw on connect timeout', async () => {
      vi.useFakeTimers();
      try {
        mc().initialize.mockReturnValue(new Promise(() => {}));
        const mockSpawner = new MockAcpSpawner();
        const bridge = createBridge(mockSpawner);

        const connectPromise = bridge.connect(1000);
        vi.advanceTimersByTime(1000);

        await expect(connectPromise).rejects.toThrow('timed out');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('listSessions', () => {
    it('should return session list from ACP', async () => {
      const mockSpawner = new MockAcpSpawner();
      const bridge = createBridge(mockSpawner);
      await bridge.connect();

      const result = await bridge.listSessions('/home/user');

      expect(mc().listSessions).toHaveBeenCalledWith({ cwd: '/home/user' });
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].sessionId).toBe('hist-1');
      expect(result.sessions[0].title).toBe('Session 1');
    });

    it('should return empty list when no sessions', async () => {
      mc().listSessions.mockResolvedValue({ sessions: [] });
      const mockSpawner = new MockAcpSpawner();
      const bridge = createBridge(mockSpawner);
      await bridge.connect();

      const result = await bridge.listSessions('/home/user');

      expect(result.sessions).toEqual([]);
    });

    it('should pass cursor to ACP and return nextCursor', async () => {
      mc().listSessions.mockResolvedValue({
        sessions: [{ sessionId: 'hist-2', title: 'Session 2', cwd: '/home/user', updatedAt: null }],
        nextCursor: 'cursor-2',
      });
      const mockSpawner = new MockAcpSpawner();
      const bridge = createBridge(mockSpawner);
      await bridge.connect();

      const result = await bridge.listSessions('/home/user', 'cursor-1');

      expect(mc().listSessions).toHaveBeenCalledWith({ cwd: '/home/user', cursor: 'cursor-1' });
      expect(result.nextCursor).toBe('cursor-2');
    });
  });

  describe('deleteSession', () => {
    it('should call ACP deleteSession with the given session ID', async () => {
      const mockSpawner = new MockAcpSpawner();
      const bridge = createBridge(mockSpawner);
      await bridge.connect();

      await bridge.deleteSession('hist-1');

      expect(mc().deleteSession).toHaveBeenCalledWith({ sessionId: 'hist-1' });
    });

    it('should throw when not connected', async () => {
      const bridge = createBridge(new MockAcpSpawner());
      await expect(bridge.deleteSession('hist-1')).rejects.toThrow();
    });
  });

  describe('loadSession', () => {
    it('should return config and collected updates', async () => {
      mc().loadSession.mockResolvedValue({});
      const mockSpawner = new MockAcpSpawner();
      const bridge = createBridge(mockSpawner);
      await bridge.connect();

      const result = await bridge.loadSession('hist-1', '/home/user');

      expect(mc().loadSession).toHaveBeenCalledWith({
        cwd: '/home/user',
        sessionId: 'hist-1',
        mcpServers: [],
      });
      expect(result.updates).toEqual([]);
    });

    it('should collect sessionUpdate notifications during load', async () => {
      let bridge!: AcpSyncBridge;
      mc().loadSession.mockImplementation(async () => {
        await bridge.sessionUpdate({
          sessionId: 'hist-1',
          update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } },
        } as never);
        await bridge.sessionUpdate({
          sessionId: 'hist-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi there' } },
        } as never);
        return {};
      });

      const mockSpawner = new MockAcpSpawner();
      bridge = createBridge(mockSpawner);
      await bridge.connect();

      const result = await bridge.loadSession('hist-1', '/home/user');

      expect(result.updates).toHaveLength(2);
      expect(result.updates[0].update.sessionUpdate).toBe('user_message_chunk');
      expect(result.updates[1].update.sessionUpdate).toBe('agent_message_chunk');
    });

    it('should throw when process exits during loadSession', async () => {
      mc().loadSession.mockReturnValue(new Promise(() => {}));
      const mockSpawner = new MockAcpSpawner();
      const bridge = createBridge(mockSpawner);
      await bridge.connect();

      mockSpawner.triggerExit();

      await expect(bridge.loadSession('hist-1', '/home/user')).rejects.toThrow('ACP process exited unexpectedly');
    });

    it('should throw on load-session timeout', async () => {
      vi.useFakeTimers();
      try {
        mc().loadSession.mockReturnValue(new Promise(() => {}));
        const mockSpawner = new MockAcpSpawner();
        const bridge = createBridge(mockSpawner);
        await bridge.connect();

        const loadPromise = bridge.loadSession('hist-1', '/home/user', 1000);
        vi.advanceTimersByTime(1000);

        await expect(loadPromise).rejects.toThrow('timed out');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('disconnect', () => {
    it('should close session with given ID and stop spawner', async () => {
      const mockSpawner = new MockAcpSpawner();
      const bridge = createBridge(mockSpawner);
      await bridge.connect();

      await bridge.disconnect('hist-1');

      expect(mc().closeSession).toHaveBeenCalledWith({ sessionId: 'hist-1' });
      expect(mockSpawner.stop).toHaveBeenCalledOnce();
    });

    it('should skip closeSession when no sessionId given', async () => {
      const mockSpawner = new MockAcpSpawner();
      const bridge = createBridge(mockSpawner);
      await bridge.connect();

      await bridge.disconnect();

      expect(mc().closeSession).not.toHaveBeenCalled();
      expect(mockSpawner.stop).toHaveBeenCalledOnce();
    });

    it('should not throw when not connected', async () => {
      const mockSpawner = new MockAcpSpawner();
      const bridge = createBridge(mockSpawner);
      await expect(bridge.disconnect()).resolves.not.toThrow();
    });
  });

  describe('sessionUpdate', () => {
    it('should collect notifications and return them in loadSession', async () => {
      let bridge!: AcpSyncBridge;
      mc().loadSession.mockImplementation(async () => {
        await bridge.sessionUpdate({
          sessionId: 'hist-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'test' } },
        } as never);
        return {};
      });

      const mockSpawner = new MockAcpSpawner();
      bridge = createBridge(mockSpawner);
      await bridge.connect();

      const result = await bridge.loadSession('hist-1', '/home/user');
      expect(result.updates).toHaveLength(1);
    });
  });

  describe('requestPermission', () => {
    it('should always reject', async () => {
      const mockSpawner = new MockAcpSpawner();
      const bridge = createBridge(mockSpawner);
      const result = await bridge.requestPermission({} as never);

      expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
    });
  });
});
