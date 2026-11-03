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
    setSessionConfigOption: vi.fn<[unknown], Promise<object>>().mockResolvedValue({}),
    authenticate: vi.fn<[unknown], Promise<object>>().mockResolvedValue({}),
    logout: vi.fn<[unknown], Promise<object>>().mockResolvedValue({}),
  };
}

let mockConnInstance = buildMockConn();

vi.mock('@agentclientprotocol/sdk', () => ({
  ndJsonStream: vi.fn(() => ({})),
  ClientSideConnection: vi.fn(function () { return mockConnInstance; }),
  CreateElicitationRequest: {
    isForm: (v: { mode?: string }) => v.mode === 'form',
    isUrl: (v: { mode?: string }) => v.mode === 'url',
  },
}));

import { AcpSessionBridge, extractConfigOptions } from '../../src/acp/bridge.js';
import { createTestLogger, type TestLogger } from '../../src/observability/testing.js';

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
  let testLog: TestLogger;

  function createBridge() {
    return new AcpSessionBridge(
      mockSocket as never,
      { sessionId: 'sess-1', cwd: '/home/user', logger: testLog.logger },
      mockSpawner as never,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockConnInstance = buildMockConn();

    mockSocket = createMockSocket();
    mockSpawner = new MockAcpSpawner();
    testLog = createTestLogger('acp-bridge');
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
        clientCapabilities: {
          session: {
            configOptions: { boolean: {} },
          },
          elicitation: { form: {}, url: {} },
        },
        clientInfo: { name: 'agent-gear', version: '1.1.5' },
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
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'gpt-4',
            options: [{ value: 'gpt-4', name: 'GPT-4' }],
          },
        ],
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
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'claude-3',
            options: [
              { value: 'gpt-4', name: 'GPT-4' },
              { value: 'claude-3', name: 'Claude 3' },
            ],
          },
        ],
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

    it('should map auth method without type field to kind agent', async () => {
      mc().initialize.mockResolvedValue({
        protocolVersion: 1,
        authMethods: [{ id: 'oauth', description: 'Login with agent' }],
      });
      const bridge = createBridge();

      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSocket.emit).toHaveBeenCalledWith('acp:auth:required', {
        sessionId: 'sess-1',
        authMethods: [{ id: 'oauth', kind: 'agent', description: null, url: null }],
      });
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
        mcpServers: [],
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
    it('should emit acp:permission and wait for response', async () => {
      const bridge = createBridge();
      const options = [
        { optionId: 'opt-1', kind: 'allow_once', label: 'Allow' },
        { optionId: 'opt-2', kind: 'reject', label: 'Reject' },
      ];

      const promise = bridge.requestPermission({
        options,
        toolCall: { toolCallId: 'tc-1' },
      } as never);

      expect(mockSocket.emit).toHaveBeenCalledWith('acp:permission', expect.objectContaining({
        sessionId: 'sess-1',
        toolCall: { toolCallId: 'tc-1' },
        options,
      }));

      const emitCall = mockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'acp:permission');
      const requestId = (emitCall![1] as { requestId: string }).requestId;

      bridge.handlePermissionResponse(requestId, { outcome: 'selected', optionId: 'opt-1' });

      const result = await promise;
      expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-1' } });
    });

    it('should resolve with cancelled on 65s timeout', async () => {
      const bridge = createBridge();

      const promise = bridge.requestPermission({
        options: [{ optionId: 'opt-1', kind: 'allow_once', label: 'Allow' }],
        toolCall: { toolCallId: 'tc-1' },
      } as never);

      await vi.advanceTimersByTimeAsync(65_000);

      const result = await promise;
      expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
    });
  });

  describe('unstable_createElicitation', () => {
    it('form 模式：emit acp:elicitation 并在响应后 resolve accept + content', async () => {
      const bridge = createBridge();
      const requestedSchema = {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      };

      const promise = bridge.unstable_createElicitation({
        mode: 'form',
        message: 'Need your name',
        sessionId: 'acp-sess-abc',
        toolCallId: 'tc-1',
        requestedSchema,
      } as never);

      expect(mockSocket.emit).toHaveBeenCalledWith('acp:elicitation', expect.objectContaining({
        sessionId: 'sess-1',
        mode: 'form',
        message: 'Need your name',
        toolCallId: 'tc-1',
        requestedSchema,
      }));

      const emitCall = mockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'acp:elicitation');
      const requestId = (emitCall![1] as { requestId: string }).requestId;
      expect(requestId).toMatch(/^elic_/);

      bridge.handleElicitationResponse(requestId, 'accept', { name: 'ash' });

      const result = await promise;
      expect(result).toEqual({ action: 'accept', content: { name: 'ash' } });
    });

    it('url 模式：透传 elicitationId 与 url', async () => {
      const bridge = createBridge();

      const promise = bridge.unstable_createElicitation({
        mode: 'url',
        message: 'Authorize access',
        sessionId: 'acp-sess-abc',
        elicitationId: 'elic-agent-1',
        url: 'https://example.com/auth',
      } as never);

      expect(mockSocket.emit).toHaveBeenCalledWith('acp:elicitation', expect.objectContaining({
        sessionId: 'sess-1',
        mode: 'url',
        message: 'Authorize access',
        elicitationId: 'elic-agent-1',
        url: 'https://example.com/auth',
      }));

      const emitCall = mockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'acp:elicitation');
      const requestId = (emitCall![1] as { requestId: string }).requestId;
      bridge.handleElicitationResponse(requestId, 'decline');

      const result = await promise;
      expect(result).toEqual({ action: 'decline' });
    });

    it('custom/未知模式：立即返回 cancel 且不 emit socket 事件', async () => {
      const bridge = createBridge();

      const result = await bridge.unstable_createElicitation({
        mode: '_vendor_custom',
        message: 'custom request',
        sessionId: 'acp-sess-abc',
      } as never);

      expect(result).toEqual({ action: 'cancel' });
      expect(mockSocket.emit).not.toHaveBeenCalledWith('acp:elicitation', expect.anything());
    });

    it('65s 超时自动 resolve cancel', async () => {
      const bridge = createBridge();

      const promise = bridge.unstable_createElicitation({
        mode: 'form',
        message: 'm',
        sessionId: 'acp-sess-abc',
        requestedSchema: { type: 'object' },
      } as never);

      await vi.advanceTimersByTimeAsync(65_000);

      const result = await promise;
      expect(result).toEqual({ action: 'cancel' });
    });

    it('handleElicitationResponse 未知 requestId 打 warn 不抛错', () => {
      const bridge = createBridge();

      expect(() => bridge.handleElicitationResponse('elic_unknown', 'cancel')).not.toThrow();
      expect(testLog.records).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          msg: 'elicitation request not found',
          elicitationId: 'elic_unknown',
        }),
      );
    });
  });

  describe('unstable_completeElicitation', () => {
    it('emit acp:elicitation:complete', async () => {
      const bridge = createBridge();

      await bridge.unstable_completeElicitation({ elicitationId: 'elic-agent-1' } as never);

      expect(mockSocket.emit).toHaveBeenCalledWith('acp:elicitation:complete', {
        sessionId: 'sess-1',
        elicitationId: 'elic-agent-1',
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

    it('should use setSessionConfigOption when mode config option exists', async () => {
      mockConnInstance.newSession = vi.fn().mockResolvedValue({
        sessionId: 'acp-sess-abc',
        configOptions: [
          {
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'code',
            options: [{ value: 'code', name: 'Code' }, { value: 'plan', name: 'Plan' }],
          },
        ],
      });
      const bridge = createBridge();
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      await bridge.setMode('plan');

      expect(mc().setSessionConfigOption).toHaveBeenCalledWith({
        sessionId: 'acp-sess-abc',
        configId: 'mode',
        value: 'plan',
      });
    });
  });

  describe('setModel', () => {
    it('should call setSessionConfigOption when model config option exists', async () => {
      mockConnInstance.newSession = vi.fn().mockResolvedValue({
        sessionId: 'acp-sess-abc',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'gpt-4',
            options: [{ value: 'gpt-4', name: 'GPT-4' }, { value: 'claude-3', name: 'Claude 3' }],
          },
        ],
      });
      const bridge = createBridge();
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      await bridge.setModel('claude-3');

      expect(mc().setSessionConfigOption).toHaveBeenCalledWith({
        sessionId: 'acp-sess-abc',
        configId: 'model',
        value: 'claude-3',
      });
    });

    it('should throw when initialized but no model config option', async () => {
      const bridge = createBridge();
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      await expect(bridge.setModel('model-1')).rejects.toThrow(
        'Model switching is not supported',
      );
      expect(mc().setSessionConfigOption).not.toHaveBeenCalled();
    });

    it('should not throw when not initialized', async () => {
      const bridge = createBridge();

      await expect(bridge.setModel('model-1')).resolves.toBeUndefined();
    });
  });

  describe('setConfigOption', () => {
    it('should call connection.setSessionConfigOption with boolean value', async () => {
      const bridge = createBridge();
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      await bridge.setConfigOption('opt-1', true);

      expect(mc().setSessionConfigOption).toHaveBeenCalledWith({
        sessionId: 'acp-sess-abc',
        configId: 'opt-1',
        value: true,
        type: 'boolean',
      });
    });

    it('should call connection.setSessionConfigOption with select value', async () => {
      const bridge = createBridge();
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      await bridge.setConfigOption('opt-2', 'val-1');

      expect(mc().setSessionConfigOption).toHaveBeenCalledWith({
        sessionId: 'acp-sess-abc',
        configId: 'opt-2',
        value: 'val-1',
      });
    });

    it('should update snapshot and emit acp:config-options from set_config_option response', async () => {
      mockConnInstance.setSessionConfigOption = vi.fn().mockResolvedValue({
        configOptions: [
          {
            id: 'flags',
            name: 'Flags',
            category: null,
            type: 'boolean',
            currentValue: true,
          },
        ],
      });
      const bridge = createBridge();
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      await bridge.setConfigOption('flags', 'true');

      expect(bridge.getConfigOptions()).toEqual([
        {
          id: 'flags',
          name: 'Flags',
          description: null,
          category: null,
          type: 'boolean',
          currentValue: 'true',
          options: [],
        },
      ]);
      expect(mockSocket.emit).toHaveBeenCalledWith('acp:config-options', {
        sessionId: 'sess-1',
        configOptions: bridge.getConfigOptions(),
      });
    });

    it('should not emit acp:config-options when response has no configOptions', async () => {
      mockConnInstance.setSessionConfigOption = vi.fn().mockResolvedValue({});
      const bridge = createBridge();
      bridge.start();
      await vi.advanceTimersByTimeAsync(0);

      await bridge.setConfigOption('opt-2', 'val-1');

      expect(mockSocket.emit).not.toHaveBeenCalledWith('acp:config-options', expect.anything());
    });
  });

  describe('extractConfigOptions', () => {
    it('should return empty array when configOptions is null or undefined', () => {
      expect(extractConfigOptions(null)).toEqual([]);
      expect(extractConfigOptions(undefined)).toEqual([]);
    });

    it('should flatten grouped select options with group name prefix', () => {
      const result = extractConfigOptions([
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gpt-4',
          options: [
            {
              group: 'openai',
              name: 'OpenAI',
              options: [
                { value: 'gpt-4', name: 'GPT-4' },
                { value: 'gpt-4o', name: 'GPT-4o' },
              ],
            },
            {
              group: 'anthropic',
              name: 'Anthropic',
              options: [{ value: 'claude-3', name: 'Claude 3' }],
            },
          ],
        },
      ]);

      expect(result[0].options).toEqual([
        { value: 'gpt-4', name: 'OpenAI/GPT-4' },
        { value: 'gpt-4o', name: 'OpenAI/GPT-4o' },
        { value: 'claude-3', name: 'Anthropic/Claude 3' },
      ]);
    });

    it('should map select and boolean config options', () => {
      const result = extractConfigOptions([
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gpt-4',
          options: [{ value: 'gpt-4', name: 'GPT-4' }],
        },
        {
          id: 'flags',
          name: 'Flags',
          category: null,
          type: 'boolean',
          currentValue: true,
        },
      ]);

      expect(result).toEqual([
        {
          id: 'model',
          name: 'Model',
          description: null,
          category: 'model',
          type: 'select',
          currentValue: 'gpt-4',
          options: [{ value: 'gpt-4', name: 'GPT-4' }],
        },
        {
          id: 'flags',
          name: 'Flags',
          description: null,
          category: null,
          type: 'boolean',
          currentValue: 'true',
          options: [],
        },
      ]);
    });
  });
});
