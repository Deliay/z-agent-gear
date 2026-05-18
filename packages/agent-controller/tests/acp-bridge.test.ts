import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

class MockAcpSpawner extends EventEmitter {
  start = vi.fn();
  stop = vi.fn();
  send = vi.fn();
  isRunning = vi.fn().mockReturnValue(true);
}

import { AcpWebSocketBridge } from '../src/acp/bridge.js';

function createMockSocket() {
  return { emit: vi.fn(), on: vi.fn() };
}

describe('AcpWebSocketBridge', () => {
  let mockSocket: ReturnType<typeof createMockSocket>;
  let mockSpawner: MockAcpSpawner;
  let bridge: AcpWebSocketBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket = createMockSocket();
    mockSpawner = new MockAcpSpawner();
    bridge = new AcpWebSocketBridge(mockSocket as never, {
      sessionId: 'sess-1',
      controllerId: 'ctrl-1',
      cwd: '/home/user',
    }, mockSpawner as never);
  });

  it('should start the spawner', () => {
    bridge.start();
    expect(mockSpawner.start).toHaveBeenCalledOnce();
  });

  it('should stop the spawner', () => {
    bridge.stop();
    expect(mockSpawner.stop).toHaveBeenCalledOnce();
  });

  it('should send input as JSON-RPC message', () => {
    bridge.sendInput({ type: 'text', content: 'Hello' });
    expect(mockSpawner.send).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: '2.0',
        method: 'session/prompt',
        params: expect.objectContaining({
          sessionId: 'sess-1',
          prompt: [{ type: 'text', text: 'Hello' }],
        }),
      }),
    );
  });

  it('should emit acp:message on agent_message_chunk', () => {
    mockSpawner.emit('message', {
      method: 'session/update',
      params: {
        update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Hi agent' } },
      },
    });
    expect(mockSocket.emit).toHaveBeenCalledWith('acp:message', {
      sessionId: 'sess-1',
      message: { type: 'text', content: 'Hi agent', metadata: null },
    });
  });

  it('should emit acp:message for tool_call', () => {
    mockSpawner.emit('message', {
      method: 'session/update',
      params: {
        update: { sessionUpdate: 'tool_call', content: { toolName: 'search' } },
      },
    });
    expect(mockSocket.emit).toHaveBeenCalledWith('acp:message', {
      sessionId: 'sess-1',
      message: { type: 'tool_call', content: 'search', metadata: { toolName: 'search' } },
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
      message: expect.objectContaining({ type: 'tool_result' }),
    });
  });

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

  it('should ignore non session/update methods', () => {
    mockSpawner.emit('message', { method: 'other', params: {} });
    expect(mockSocket.emit).not.toHaveBeenCalled();
  });
});
