import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

class MockAcpSpawner extends EventEmitter {
  start = vi.fn();
  stop = vi.fn();
  send = vi.fn();
  isRunning = vi.fn().mockReturnValue(true);
}

import { AcpWebSocketBridge } from '../src/acp/bridge.js';

function createMockSocket() {
  const listeners = new Map<string, Function[]>();
  return {
    emit: vi.fn(),
    on: vi.fn((event: string, cb: Function) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(cb);
    }),
    off: vi.fn((event: string, cb: Function) => {
      const cbs = listeners.get(event);
      if (cbs) {
        const idx = cbs.indexOf(cb);
        if (idx >= 0) cbs.splice(idx, 1);
      }
    }),
  };
}

describe('AcpWebSocketBridge', () => {
  let mockSocket: ReturnType<typeof createMockSocket>;
  let mockSpawner: MockAcpSpawner;
  let bridge: AcpWebSocketBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockSocket = createMockSocket();
    mockSpawner = new MockAcpSpawner();
    bridge = new AcpWebSocketBridge(mockSocket as never, {
      sessionId: 'sess-1',
      controllerId: 'ctrl-1',
      cwd: '/home/user',
    }, mockSpawner as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should start the spawner', () => {
    bridge.start();
    expect(mockSpawner.start).toHaveBeenCalledOnce();
  });

  it('should stop the spawner', () => {
    bridge.stop();
    expect(mockSpawner.stop).toHaveBeenCalledOnce();
  });

  describe('initialization', () => {
    it('should send initialize request on start', async () => {
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSpawner.send).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: '2.0',
          method: 'initialize',
          params: expect.objectContaining({
            protocolVersion: 1,
            clientCapabilities: expect.objectContaining({
              fs: expect.objectContaining({ readTextFile: true, writeTextFile: true }),
              terminal: true,
            }),
            clientInfo: expect.objectContaining({
              name: 'agent-controller',
            }),
          }),
        }),
      );
    });

    it('should send session/new after initialize response', async () => {
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      const initCall = mockSpawner.send.mock.calls[0][0];
      const initId = initCall.id;

      mockSpawner.emit('message', {
        jsonrpc: '2.0',
        id: initId,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          agentInfo: { name: 'opencode', version: '1.0.0' },
        },
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(mockSpawner.send).toHaveBeenCalledTimes(2);
      expect(mockSpawner.send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          jsonrpc: '2.0',
          method: 'session/new',
          params: expect.objectContaining({
            cwd: '/home/user',
            mcpServers: [],
          }),
        }),
      );
    });

    it('should emit acp:initialized after session/new response', async () => {
      const emitSpy = vi.fn();
      bridge.on('acp:initialized', emitSpy);

      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      const initCall = mockSpawner.send.mock.calls[0][0];
      mockSpawner.emit('message', {
        jsonrpc: '2.0',
        id: initCall.id,
        result: { protocolVersion: 1, agentCapabilities: {} },
      });

      await vi.advanceTimersByTimeAsync(0);

      const sessionCall = mockSpawner.send.mock.calls[1][0];
      mockSpawner.emit('message', {
        jsonrpc: '2.0',
        id: sessionCall.id,
        result: { sessionId: 'acp-sess-abc' },
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(emitSpy).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        acpSessionId: 'acp-sess-abc',
      });
    });

    it('should emit acp:stopped on initialize failure', async () => {
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      const initCall = mockSpawner.send.mock.calls[0][0];
      mockSpawner.emit('message', {
        jsonrpc: '2.0',
        id: initCall.id,
        error: { code: -32600, message: 'Invalid request' },
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(mockSocket.emit).toHaveBeenCalledWith('acp:stopped', {
        sessionId: 'sess-1',
        reason: 'error',
        error: expect.stringContaining('ACP error'),
      });
    });

    it('should emit acp:stopped on initialize timeout', async () => {
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(30_001);

      expect(mockSocket.emit).toHaveBeenCalledWith('acp:stopped', {
        sessionId: 'sess-1',
        reason: 'error',
        error: expect.stringContaining('timed out'),
      });
    });
  });

  describe('sendInput', () => {
    it('should buffer input before initialization completes', async () => {
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);
      bridge.sendInput({ type: 'text', content: 'Hello' });

      const promptCalls = mockSpawner.send.mock.calls.filter(
        (call: Record<string, unknown>[]) => call[0]?.method === 'session/prompt',
      );
      expect(promptCalls).toHaveLength(0);
    });

    it('should flush queued input after initialization', async () => {
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);
      bridge.sendInput({ type: 'text', content: 'Hello' });
      bridge.sendInput({ type: 'text', content: 'World' });

      const initCall = mockSpawner.send.mock.calls[0][0];
      mockSpawner.emit('message', {
        jsonrpc: '2.0',
        id: initCall.id,
        result: { protocolVersion: 1, agentCapabilities: {} },
      });
      await vi.advanceTimersByTimeAsync(0);

      const sessionCall = mockSpawner.send.mock.calls[1][0];
      mockSpawner.emit('message', {
        jsonrpc: '2.0',
        id: sessionCall.id,
        result: { sessionId: 'acp-sess-abc' },
      });
      await vi.advanceTimersByTimeAsync(0);

      const promptCalls = mockSpawner.send.mock.calls.filter(
        (call: Record<string, unknown>[]) => call[0]?.method === 'session/prompt',
      );
      expect(promptCalls).toHaveLength(2);
      expect(promptCalls[0][0]).toMatchObject({
        method: 'session/prompt',
        params: {
          sessionId: 'acp-sess-abc',
          prompt: [{ type: 'text', text: 'Hello' }],
        },
      });
      expect(promptCalls[1][0]).toMatchObject({
        method: 'session/prompt',
        params: {
          sessionId: 'acp-sess-abc',
          prompt: [{ type: 'text', text: 'World' }],
        },
      });
    });

    it('should send prompt with ACP session ID after initialization', async () => {
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      const initCall = mockSpawner.send.mock.calls[0][0];
      mockSpawner.emit('message', {
        jsonrpc: '2.0',
        id: initCall.id,
        result: { protocolVersion: 1, agentCapabilities: {} },
      });
      await vi.advanceTimersByTimeAsync(0);

      const sessionCall = mockSpawner.send.mock.calls[1][0];
      mockSpawner.emit('message', {
        jsonrpc: '2.0',
        id: sessionCall.id,
        result: { sessionId: 'acp-sess-abc' },
      });
      await vi.advanceTimersByTimeAsync(0);

      bridge.sendInput({ type: 'text', content: 'Hello' });

      expect(mockSpawner.send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          jsonrpc: '2.0',
          method: 'session/prompt',
          params: expect.objectContaining({
            sessionId: 'acp-sess-abc',
            prompt: [{ type: 'text', text: 'Hello' }],
          }),
        }),
      );
    });
  });

  describe('message handling', () => {
    it('should buffer text chunks and flush after delay', async () => {
      vi.useFakeTimers();
      mockSpawner.emit('message', {
        method: 'session/update',
        params: {
          update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Hi ' } },
        },
      });
      mockSpawner.emit('message', {
        method: 'session/update',
        params: {
          update: { sessionUpdate: 'agent_message_chunk', content: { text: 'agent' } },
        },
      });
      expect(mockSocket.emit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(50);
      expect(mockSocket.emit).toHaveBeenCalledWith('acp:message', {
        sessionId: 'sess-1',
        message: { sessionUpdate: 'agent_message_chunk', content: { text: 'Hi agent' } },
      });
      vi.useRealTimers();
    });

    it('should flush text buffer on tool_call', () => {
      mockSpawner.emit('message', {
        method: 'session/update',
        params: {
          update: { sessionUpdate: 'agent_message_chunk', content: { text: 'searching' } },
        },
      });
      mockSpawner.emit('message', {
        method: 'session/update',
        params: {
          update: { sessionUpdate: 'tool_call', content: { toolName: 'search' } },
        },
      });
      expect(mockSocket.emit).toHaveBeenCalledWith('acp:message', {
        sessionId: 'sess-1',
        message: { sessionUpdate: 'agent_message_chunk', content: { text: 'searching' } },
      });
      expect(mockSocket.emit).toHaveBeenCalledWith('acp:message', {
        sessionId: 'sess-1',
        message: { sessionUpdate: 'tool_call', content: { toolName: 'search' } },
      });
    });

    it('should emit acp:message for tool_result', () => {
      mockSpawner.emit('message', {
        method: 'session/update',
        params: {
          update: { sessionUpdate: 'tool_result', content: { result: 'ok' } },
        },
      });
      expect(mockSocket.emit).toHaveBeenCalledWith('acp:message', {
        sessionId: 'sess-1',
        message: { sessionUpdate: 'tool_result', content: { result: 'ok' } },
      });
    });

    it('should ignore user_message_chunk', () => {
      mockSpawner.emit('message', {
        method: 'session/update',
        params: {
          update: { sessionUpdate: 'user_message_chunk', content: { text: 'user input' } },
        },
      });
      const acpMessageCalls = mockSocket.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === 'acp:message',
      );
      expect(acpMessageCalls).toHaveLength(0);
    });

    it('should ignore non session/update methods', () => {
      mockSpawner.emit('message', { method: 'other', params: {} });
      const acpMessageCalls = mockSocket.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === 'acp:message',
      );
      expect(acpMessageCalls).toHaveLength(0);
    });
  });

  describe('exit handling', () => {
    it('should emit acp:stopped with user_close on SIGTERM', () => {
      mockSpawner.emit('exit', { code: null, signal: 'SIGTERM' });
      expect(mockSocket.emit).toHaveBeenCalledWith('acp:stopped', {
        sessionId: 'sess-1', reason: 'user_close', exitCode: null,
      });
    });

    it('should emit acp:stopped with agent_exit on code 0', () => {
      mockSpawner.emit('exit', { code: 0, signal: null });
      expect(mockSocket.emit).toHaveBeenCalledWith('acp:stopped', {
        sessionId: 'sess-1', reason: 'agent_exit', exitCode: 0,
      });
    });

    it('should emit acp:stopped with error on non-zero exit', () => {
      mockSpawner.emit('exit', { code: 1, signal: null });
      expect(mockSocket.emit).toHaveBeenCalledWith('acp:stopped', {
        sessionId: 'sess-1', reason: 'error', exitCode: 1,
      });
    });

    it('should emit acp:stopped on spawner error', () => {
      mockSpawner.emit('error', new Error('fail'));
      expect(mockSocket.emit).toHaveBeenCalledWith('acp:stopped', {
        sessionId: 'sess-1', reason: 'error',
      });
    });

    it('should reject pending requests on exit', async () => {
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(30_001);

      expect(mockSocket.emit).toHaveBeenCalledWith('acp:stopped', expect.objectContaining({
        sessionId: 'sess-1',
        reason: 'error',
      }));
    });
  });
});
