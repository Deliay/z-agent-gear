import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function buildMockConn() {
  return {
    initialize: vi.fn<[unknown], Promise<{ protocolVersion: number }>>().mockResolvedValue({ protocolVersion: 1 }),
    newSession: vi.fn<[unknown], Promise<{ sessionId: string }>>().mockResolvedValue({ sessionId: 'acp-sess-abc' }),
    resumeSession: vi.fn<[unknown], Promise<object>>().mockResolvedValue({}),
    prompt: vi.fn<[unknown], Promise<{ stopReason: string }>>().mockResolvedValue({ stopReason: 'end_turn' }),
    cancel: vi.fn<[unknown], Promise<void>>().mockResolvedValue(undefined),
    closeSession: vi.fn<[unknown], Promise<object>>().mockResolvedValue({}),
    setSessionMode: vi.fn<[unknown], Promise<object>>().mockResolvedValue({}),
    unstable_setSessionModel: vi.fn<[unknown], Promise<object>>().mockResolvedValue({}),
  };
}

let mockConnInstance = buildMockConn();

vi.mock('@agentclientprotocol/sdk', () => ({
  ndJsonStream: vi.fn(() => ({})),
  ClientSideConnection: vi.fn(function () { return mockConnInstance; }),
}));

import { AcpSessionBridge } from '../../src/acp/bridge.js';

class MockAcpSpawner {
  start = vi.fn();
  stop = vi.fn();
  isRunning = vi.fn().mockReturnValue(true);
  _stdin = new WritableStream();
  _stdout = new ReadableStream();
  get stdin() { return this._stdin; }
  get stdout() { return this._stdout; }
  get closed() { return Promise.resolve(); }
}

function createMockSocket() {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
}

function mc() { return mockConnInstance; }

describe('AcpSessionBridge', () => {
  let mockSocket: ReturnType<typeof createMockSocket>;
  let mockSpawner: MockAcpSpawner;

  function createBridge() {
    return new AcpSessionBridge(
      mockSocket as never,
      { sessionId: 'sess-1', cwd: '/home/user' },
      mockSpawner as never,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockConnInstance = buildMockConn();

    mockSocket = createMockSocket();
    mockSpawner = new MockAcpSpawner();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('start', () => {
    it('should start the spawner and initialize connection', async () => {
      const bridge = createBridge();
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSpawner.start).toHaveBeenCalledOnce();
      expect(mc().initialize).toHaveBeenCalledWith({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'agent-gear', version: '1.0.0' },
      });
      expect(mc().newSession).toHaveBeenCalledWith({
        cwd: '/home/user',
        mcpServers: [],
      });
    });

    it('should emit acp:initialized after successful start', async () => {
      const bridge = createBridge();
      const emitSpy = vi.fn();
      bridge.on('acp:initialized', emitSpy);

      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess-1',
        acpSessionId: 'acp-sess-abc',
      }));
    });

    it('should include modes in acp:initialized when available', async () => {
      mockConnInstance.newSession = vi.fn().mockResolvedValue({
        sessionId: 'acp-sess-abc',
        modes: {
          availableModes: [{ id: 'mode-1', name: 'Code', description: 'Coding mode' }],
          currentModeId: 'mode-1',
        },
      });
      const bridge = createBridge();
      const emitSpy = vi.fn();
      bridge.on('acp:initialized', emitSpy);

      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({
        modes: [{ id: 'mode-1', name: 'Code', description: 'Coding mode' }],
        currentModeId: 'mode-1',
      }));
    });

    it('should include currentModel in acp:initialized when available', async () => {
      mockConnInstance.newSession = vi.fn().mockResolvedValue({
        sessionId: 'acp-sess-abc',
        models: {
          availableModels: [{ modelId: 'gpt-4', name: 'GPT-4' }],
          currentModelId: 'gpt-4',
        },
      });
      const bridge = createBridge();
      const emitSpy = vi.fn();
      bridge.on('acp:initialized', emitSpy);

      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({
        currentModel: { id: 'gpt-4', name: 'GPT-4' },
      }));
    });

    it('should include availableModels and currentModelId in acp:initialized', async () => {
      mockConnInstance.newSession = vi.fn().mockResolvedValue({
        sessionId: 'acp-sess-abc',
        models: {
          availableModels: [
            { modelId: 'gpt-4', name: 'GPT-4' },
            { modelId: 'claude-3', name: 'Claude 3' },
          ],
          currentModelId: 'claude-3',
        },
      });
      const bridge = createBridge();
      const emitSpy = vi.fn();
      bridge.on('acp:initialized', emitSpy);

      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({
        availableModels: [
          { id: 'gpt-4', name: 'GPT-4' },
          { id: 'claude-3', name: 'Claude 3' },
        ],
        currentModelId: 'claude-3',
      }));
    });

    it('should emit acp:stopped on initialize failure', async () => {
      mc().initialize.mockRejectedValue(new Error('init failed'));
      const bridge = createBridge();

      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSocket.emit).toHaveBeenCalledWith('acp:stopped', {
        sessionId: 'sess-1',
        reason: 'error',
        error: 'init failed',
      });
    });

    it('should not start concurrently', async () => {
      const bridge = createBridge();
      bridge.start();
      bridge.start();  // concurrent call while first is still running
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSpawner.start).toHaveBeenCalledTimes(1);
    });
  });

  describe('resume', () => {
    it('should resume an existing ACP session', async () => {
      const bridge = createBridge();
      const emitSpy = vi.fn();
      bridge.on('acp:initialized', emitSpy);

      bridge.resume('existing-sess-id');
      await vi.advanceTimersByTimeAsync(0);

      expect(mc().resumeSession).toHaveBeenCalledWith({
        sessionId: 'existing-sess-id',
        cwd: '/home/user',
      });
      expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess-1',
        acpSessionId: 'existing-sess-id',
      }));
    });

    it('should fallback to newSession when resumeSession fails', async () => {
      mc().resumeSession.mockRejectedValue(new Error('not supported'));
      const bridge = createBridge();
      const emitSpy = vi.fn();
      bridge.on('acp:initialized', emitSpy);

      bridge.resume('existing-sess-id');
      await vi.advanceTimersByTimeAsync(0);

      expect(mc().newSession).toHaveBeenCalledWith({
        cwd: '/home/user',
        mcpServers: [],
      });
      expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess-1',
      }));
    });

    it('should emit acp:stopped when both resume and fallback fail', async () => {
      mc().resumeSession.mockRejectedValue(new Error('not supported'));
      mc().newSession.mockRejectedValue(new Error('new also failed'));
      const bridge = createBridge();

      bridge.resume('existing-sess-id');
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSocket.emit).toHaveBeenCalledWith('acp:stopped', {
        sessionId: 'sess-1',
        reason: 'error',
        error: 'new also failed',
      });
    });
  });

  describe('cancel', () => {
    it('should call connection.cancel', async () => {
      const bridge = createBridge();
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      bridge.cancel();

      expect(mc().cancel).toHaveBeenCalledWith({
        sessionId: 'acp-sess-abc',
      });
    });

    it('should not throw when not initialized', () => {
      const bridge = createBridge();
      expect(() => bridge.cancel()).not.toThrow();
    });
  });

  describe('stop', () => {
    it('should cancel, close session, and stop spawner', async () => {
      const bridge = createBridge();
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      bridge.stop();
      await vi.advanceTimersByTimeAsync(0);

      expect(mc().cancel).toHaveBeenCalled();
      expect(mc().closeSession).toHaveBeenCalledWith({
        sessionId: 'acp-sess-abc',
      });
      expect(mockSpawner.stop).toHaveBeenCalledOnce();
      expect(mockSocket.emit).toHaveBeenCalledWith('acp:stopped', {
        sessionId: 'sess-1',
        reason: 'user_close',
        exitCode: undefined,
      });
    });

    it('should not throw when not initialized', () => {
      const bridge = createBridge();
      expect(() => bridge.stop()).not.toThrow();
    });
  });

  describe('sendInput', () => {
    it('should call connection.prompt', async () => {
      const bridge = createBridge();
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      bridge.sendInput({ type: 'text', content: 'Hello' });

      expect(mc().prompt).toHaveBeenCalledWith({
        sessionId: 'acp-sess-abc',
        prompt: [{ type: 'text', text: 'Hello' }],
      });
    });

    it('should queue input when prompt is active', async () => {
      const bridge = createBridge();
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      mc().prompt.mockReturnValue(new Promise(() => {}));
      bridge.sendInput({ type: 'text', content: 'First' });
      bridge.sendInput({ type: 'text', content: 'Second' });

      expect(mc().prompt).toHaveBeenCalledTimes(1);
    });

    it('should process queue after prompt completes', async () => {
      const bridge = createBridge();
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      mc().prompt
        .mockResolvedValueOnce({ stopReason: 'end_turn' })
        .mockResolvedValueOnce({ stopReason: 'end_turn' });

      bridge.sendInput({ type: 'text', content: 'First' });
      await vi.advanceTimersByTimeAsync(0);

      bridge.sendInput({ type: 'text', content: 'Second' });
      await vi.advanceTimersByTimeAsync(0);

      expect(mc().prompt).toHaveBeenCalledTimes(2);
    });

    it('should emit acp:prompt:start when prompt begins', async () => {
      const bridge = createBridge();
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      mc().prompt.mockReturnValue(new Promise(() => {}));
      bridge.sendInput({ type: 'text', content: 'Hello' });

      expect(mockSocket.emit).toHaveBeenCalledWith('acp:prompt:start', {
        sessionId: 'sess-1',
      });
    });

    it('should emit acp:prompt:complete when prompt ends successfully', async () => {
      const bridge = createBridge();
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      bridge.sendInput({ type: 'text', content: 'Hello' });
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSocket.emit).toHaveBeenCalledWith('acp:prompt:complete', {
        sessionId: 'sess-1',
        stopReason: 'end_turn',
      });
    });

    it('should emit acp:prompt:complete with error stopReason on prompt failure', async () => {
      const bridge = createBridge();
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      mc().prompt.mockRejectedValueOnce(new Error('prompt failed'));
      bridge.sendInput({ type: 'text', content: 'Hello' });
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSocket.emit).toHaveBeenCalledWith('acp:prompt:complete', {
        sessionId: 'sess-1',
        stopReason: 'error',
      });
    });

    it('should not emit acp:prompt:complete after stop', async () => {
      const bridge = createBridge();
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      mc().prompt.mockReturnValue(new Promise(() => {}));
      bridge.sendInput({ type: 'text', content: 'Hello' });

      mockSocket.emit.mockClear();
      bridge.stop();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSocket.emit).toHaveBeenCalledWith('acp:stopped', expect.objectContaining({
        sessionId: 'sess-1',
        reason: 'user_close',
      }));
      expect(mockSocket.emit).not.toHaveBeenCalledWith('acp:prompt:complete', expect.anything());
    });
  });

  describe('sessionUpdate handling', () => {
    it('should buffer text chunks and flush after 50ms', async () => {
      const bridge = createBridge();

      await bridge.sessionUpdate({
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi ' } },
      } as never);
      await bridge.sessionUpdate({
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'agent' } },
      } as never);

      expect(mockSocket.emit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(50);

      expect(mockSocket.emit).toHaveBeenCalledWith('acp:message', {
        sessionId: 'sess-1',
        message: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi agent' } },
      });
    });

    it('should flush text buffer on tool_call', async () => {
      const bridge = createBridge();

      await bridge.sessionUpdate({
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'searching' } },
      } as never);
      await bridge.sessionUpdate({
        update: { sessionUpdate: 'tool_call', content: { toolName: 'search' } },
      } as never);

      expect(mockSocket.emit).toHaveBeenCalledWith('acp:message', {
        sessionId: 'sess-1',
        message: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'searching' } },
      });
      expect(mockSocket.emit).toHaveBeenCalledWith('acp:message', {
        sessionId: 'sess-1',
        message: { sessionUpdate: 'tool_call', content: { toolName: 'search' } },
      });
    });

    it('should ignore user_message_chunk', async () => {
      const bridge = createBridge();

      await bridge.sessionUpdate({
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'user input' } },
      } as never);

      const acpMessageCalls = mockSocket.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === 'acp:message',
      );
      expect(acpMessageCalls).toHaveLength(0);
    });
  });

  describe('requestPermission', () => {
    it('should auto-accept with allow_once', async () => {
      const bridge = createBridge();
      const result = await bridge.requestPermission({
        options: [
          { optionId: 'opt-1', kind: 'allow_once', label: 'Allow' },
          { optionId: 'opt-2', kind: 'reject', label: 'Reject' },
        ],
      } as never);

      expect(result).toEqual({
        outcome: { outcome: 'selected', optionId: 'opt-1' },
      });
    });
  });

  describe('setMode', () => {
    it('should call connection.setSessionMode', async () => {
      const bridge = createBridge();
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      await bridge.setMode('mode-2');

      expect(mc().setSessionMode).toHaveBeenCalledWith({
        sessionId: 'acp-sess-abc',
        modeId: 'mode-2',
      });
    });

    it('should not throw when not initialized', async () => {
      const bridge = createBridge();

      await expect(bridge.setMode('mode-1')).resolves.toBeUndefined();
      expect(mc().setSessionMode).not.toHaveBeenCalled();
    });
  });

  describe('setModel', () => {
    it('should call connection.unstable_setSessionModel with correct params', async () => {
      const bridge = createBridge();
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      await bridge.setModel('model-2');

      expect(mc().unstable_setSessionModel).toHaveBeenCalledWith({
        sessionId: 'acp-sess-abc',
        modelId: 'model-2',
      });
    });

    it('should not throw when not initialized', async () => {
      const bridge = createBridge();

      await expect(bridge.setModel('model-1')).resolves.toBeUndefined();
      expect(mc().unstable_setSessionModel).not.toHaveBeenCalled();
    });
  });

  describe('extractAvailableModels', () => {
    it('should return null when models is null', () => {
      const bridge = createBridge();

      // Access private method via bracket notation
      const result = (bridge as unknown as Record<string, unknown>).extractAvailableModels(null);
      expect(result).toBeNull();
    });

    it('should return null when models is undefined', () => {
      const bridge = createBridge();

      const result = (bridge as unknown as Record<string, unknown>).extractAvailableModels(undefined);
      expect(result).toBeNull();
    });

    it('should return null when availableModels is missing', () => {
      const bridge = createBridge();

      const result = (bridge as unknown as Record<string, unknown>).extractAvailableModels({});
      expect(result).toBeNull();
    });
  });
});
