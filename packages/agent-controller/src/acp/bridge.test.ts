import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockNewSession, mockResumeSession, mockInitialize, mockClientSideConnection } = vi.hoisted(() => {
  const mockNewSession = vi.fn().mockResolvedValue({ sessionId: 'acp-sess-abc' });
  const mockResumeSession = vi.fn().mockResolvedValue({});
  const mockInitialize = vi.fn().mockResolvedValue({ protocolVersion: 1 });
  const mockClientSideConnection = vi.fn(function () {
    return {
      initialize: mockInitialize,
      newSession: mockNewSession,
      resumeSession: mockResumeSession,
      prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
      cancel: vi.fn().mockResolvedValue(undefined),
      closeSession: vi.fn().mockResolvedValue({}),
      setSessionMode: vi.fn().mockResolvedValue({}),
      setSessionConfigOption: vi.fn().mockResolvedValue({}),
    };
  });
  return { mockNewSession, mockResumeSession, mockInitialize, mockClientSideConnection };
});

vi.mock('@agentclientprotocol/sdk', () => ({
  ndJsonStream: vi.fn(() => ({})),
  ClientSideConnection: mockClientSideConnection,
}));

import { AcpSessionBridge } from './bridge.js';

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

describe('AcpSessionBridge - requestPermission', () => {
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
    mockSocket = createMockSocket();
    mockSpawner = new MockAcpSpawner();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should emit acp:permission and wait for response', async () => {
    const bridge = createBridge();
    const options = [
      { optionId: 'opt-1', name: 'Allow', kind: 'allow_once' as const },
      { optionId: 'opt-2', name: 'Reject', kind: 'reject_once' as const },
    ];

    const promise = bridge.requestPermission({
      toolCall: { toolCallId: 'tc-1' },
      options,
    } as never);

    expect(mockSocket.emit).toHaveBeenCalledWith('acp:permission', expect.objectContaining({
      sessionId: 'sess-1',
      toolCall: { toolCallId: 'tc-1' },
      options,
    }));

    const emitCall = mockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'acp:permission');
    const requestId = (emitCall![1] as { requestId: string }).requestId;
    expect(requestId).toMatch(/^perm_\d+_/);

    bridge.handlePermissionResponse(requestId, { outcome: 'selected', optionId: 'opt-1' });

    const result = await promise;
    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-1' } });
  });

  it('should resolve with cancelled after 65s timeout', async () => {
    const bridge = createBridge();

    const promise = bridge.requestPermission({
      toolCall: { toolCallId: 'tc-1' },
      options: [{ optionId: 'opt-1', name: 'Allow', kind: 'allow_once' }],
    } as never);

    await vi.advanceTimersByTimeAsync(65_000);

    const result = await promise;
    expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('should not resolve with cancelled if response arrives before timeout', async () => {
    const bridge = createBridge();

    const promise = bridge.requestPermission({
      toolCall: { toolCallId: 'tc-1' },
      options: [{ optionId: 'opt-1', name: 'Allow', kind: 'allow_once' }],
    } as never);

    const emitCall = mockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'acp:permission');
    const requestId = (emitCall![1] as { requestId: string }).requestId;

    await vi.advanceTimersByTimeAsync(30_000);
    bridge.handlePermissionResponse(requestId, { outcome: 'selected', optionId: 'opt-1' });

    const result = await promise;
    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-1' } });

    await vi.advanceTimersByTimeAsync(35_000);
  });

  it('should warn and ignore invalid requestId in handlePermissionResponse', () => {
    const bridge = createBridge();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    bridge.handlePermissionResponse('invalid-id', { outcome: 'selected', optionId: 'opt-1' });

    expect(warnSpy).toHaveBeenCalledWith('Permission request invalid-id not found');
    warnSpy.mockRestore();
  });

  it('should handle cancelled outcome from user', async () => {
    const bridge = createBridge();

    const promise = bridge.requestPermission({
      toolCall: { toolCallId: 'tc-1' },
      options: [{ optionId: 'opt-1', name: 'Allow', kind: 'allow_once' }],
    } as never);

    const emitCall = mockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'acp:permission');
    const requestId = (emitCall![1] as { requestId: string }).requestId;

    bridge.handlePermissionResponse(requestId, { outcome: 'cancelled' });

    const result = await promise;
    expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('should handle concurrent permission requests independently', async () => {
    const bridge = createBridge();

    const promise1 = bridge.requestPermission({
      toolCall: { toolCallId: 'tc-1' },
      options: [{ optionId: 'opt-1', name: 'Allow', kind: 'allow_once' }],
    } as never);

    const promise2 = bridge.requestPermission({
      toolCall: { toolCallId: 'tc-2' },
      options: [{ optionId: 'opt-2', name: 'Reject', kind: 'reject_once' }],
    } as never);

    const calls = mockSocket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'acp:permission');
    expect(calls).toHaveLength(2);

    const requestId1 = (calls[0][1] as { requestId: string }).requestId;
    const requestId2 = (calls[1][1] as { requestId: string }).requestId;
    expect(requestId1).not.toBe(requestId2);

    bridge.handlePermissionResponse(requestId2, { outcome: 'selected', optionId: 'opt-2' });
    bridge.handlePermissionResponse(requestId1, { outcome: 'selected', optionId: 'opt-1' });

    const [result1, result2] = await Promise.all([promise1, promise2]);
    expect(result1).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-1' } });
    expect(result2).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-2' } });
  });

  it('should clean up pending entry after timeout', async () => {
    const bridge = createBridge();

    const promise = bridge.requestPermission({
      toolCall: { toolCallId: 'tc-1' },
      options: [{ optionId: 'opt-1', name: 'Allow', kind: 'allow_once' }],
    } as never);

    await vi.advanceTimersByTimeAsync(65_000);
    await promise;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emitCall = mockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'acp:permission');
    const requestId = (emitCall![1] as { requestId: string }).requestId;

    bridge.handlePermissionResponse(requestId, { outcome: 'selected', optionId: 'opt-1' });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('AcpSessionBridge - mcpEndpoint injection', () => {
  let mockSocket: ReturnType<typeof createMockSocket>;
  let mockSpawner: MockAcpSpawner;

  function createBridge(mcpEndpoint?: { token: string; serverNames: string[] }) {
    return new AcpSessionBridge(
      mockSocket as never,
      { sessionId: 'sess-1', cwd: '/home/user', mcpEndpoint, mcpPort: 47291 },
      mockSpawner as never,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockSocket = createMockSocket();
    mockSpawner = new MockAcpSpawner();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should pass http mcpServers to newSession when mcpEndpoint provided', async () => {
    const bridge = createBridge({
      token: 'tok-1',
      serverNames: ['github-mcp', 'fs-mcp'],
    });

    await bridge.start();

    expect(mockNewSession).toHaveBeenCalledWith(expect.objectContaining({
      mcpServers: [
        { type: 'http', name: 'github-mcp', url: 'http://127.0.0.1:47291/mcp/sess-1/github-mcp', headers: [{ name: 'Authorization', value: 'Bearer tok-1' }] },
        { type: 'http', name: 'fs-mcp', url: 'http://127.0.0.1:47291/mcp/sess-1/fs-mcp', headers: [{ name: 'Authorization', value: 'Bearer tok-1' }] },
      ],
    }));
  });

  it('should not set mcpServers when mcpEndpoint absent', async () => {
    const bridge = createBridge();
    await bridge.start();

    expect(mockNewSession).toHaveBeenCalledWith(expect.objectContaining({
      mcpServers: [],
    }));
  });

  it('should pass http mcpServers to resumeSession when mcpEndpoint provided', async () => {
    const bridge = createBridge({
      token: 'tok-1',
      serverNames: ['github-mcp'],
    });

    await bridge.resume('ext-123');

    expect(mockResumeSession).toHaveBeenCalledWith(expect.objectContaining({
      mcpServers: [
        { type: 'http', name: 'github-mcp', url: 'http://127.0.0.1:47291/mcp/sess-1/github-mcp', headers: [{ name: 'Authorization', value: 'Bearer tok-1' }] },
      ],
    }));
  });

  it('should fail with a diagnosable error when mcpEndpoint.serverNames is missing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bridge = createBridge({
      token: 'tok-1',
      // simulate an upstream payload that drifts from the contract
      serverNames: undefined as never,
    });

    await bridge.start();

    expect(mockNewSession).not.toHaveBeenCalled();
    expect(mockSocket.emit).toHaveBeenCalledWith('acp:stopped', expect.objectContaining({
      sessionId: 'sess-1',
      reason: 'error',
      error: expect.stringContaining('serverNames'),
    }));
    // the failure must be visible in local logs, not only via socket events
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('serverNames'));
    expect(mockSpawner.stop).toHaveBeenCalled();
  });

  it('should fail with a diagnosable error when mcpEndpoint.serverNames is empty', async () => {
    const bridge = createBridge({
      token: 'tok-1',
      serverNames: [],
    });

    await bridge.start();

    expect(mockNewSession).not.toHaveBeenCalled();
    expect(mockSocket.emit).toHaveBeenCalledWith('acp:stopped', expect.objectContaining({
      sessionId: 'sess-1',
      reason: 'error',
      error: expect.stringContaining('serverNames'),
    }));
  });

  it('should log the MCP servers passed to session/new without leaking the token', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bridge = createBridge({
      token: 'secret-token',
      serverNames: ['fluentui-mcp'],
    });

    await bridge.start();

    const logLines = logSpy.mock.calls.map((c) => String(c[0]));
    const mcpLog = logLines.find((l) => l.includes('passing MCP servers via session/new'));
    expect(mcpLog).toBeDefined();
    expect(mcpLog).toContain('fluentui-mcp(type=http, url=http://127.0.0.1:47291/mcp/sess-1/fluentui-mcp');
    expect(mcpLog).not.toContain('secret-token');
  });

  it('should warn when passing http MCP servers to an agent without http MCP capability', async () => {
    mockInitialize.mockResolvedValueOnce({
      protocolVersion: 1,
      agentCapabilities: { mcpCapabilities: { http: false, sse: true } },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bridge = createBridge({
      token: 'tok-1',
      serverNames: ['fluentui-mcp'],
    });

    await bridge.start();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('mcpCapabilities.http'));
    // still passes the servers through — the agent decides
    expect(mockNewSession).toHaveBeenCalledWith(expect.objectContaining({
      mcpServers: [expect.objectContaining({ type: 'http', name: 'fluentui-mcp' })],
    }));
  });

  it('T-C11 generates only loopback URLs with Bearer headers and no public address', async () => {
    const bridge = createBridge({
      token: 'tok-1',
      serverNames: ['github-mcp', 'fs-mcp'],
    });

    await bridge.start();

    const servers = mockNewSession.mock.calls[0][0].mcpServers as Array<{ url: string; headers: Array<{ name: string; value: string }> }>;
    expect(servers).toHaveLength(2);
    const urls = servers.map((s) => s.url);
    expect(urls).toEqual([
      'http://127.0.0.1:47291/mcp/sess-1/github-mcp',
      'http://127.0.0.1:47291/mcp/sess-1/fs-mcp',
    ]);
    for (const url of urls) {
      expect(url.startsWith('http://127.0.0.1:')).toBe(true);
    }
    expect(JSON.stringify(urls)).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
    for (const s of servers) {
      expect(s.headers).toEqual([{ name: 'Authorization', value: 'Bearer tok-1' }]);
    }
  });
});

describe('AcpSessionBridge - initial mode/model', () => {
  let mockSocket: ReturnType<typeof createMockSocket>;
  let mockSpawner: MockAcpSpawner;

  function createBridge(opts: { modeId?: string; modelId?: string } = {}) {
    const options: { sessionId: string; cwd: string; initialModeId?: string; initialModelId?: string } = {
      sessionId: 'sess-1',
      cwd: '/home/user',
    };
    if (opts.modeId) options.initialModeId = opts.modeId;
    if (opts.modelId) options.initialModelId = opts.modelId;
    return new AcpSessionBridge(mockSocket as never, options, mockSpawner as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockSocket = createMockSocket();
    mockSpawner = new MockAcpSpawner();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should apply initial mode via setSessionMode after session/new', async () => {
    const bridge = createBridge({ modeId: 'code' });

    await bridge.start();

    expect(mockNewSession).toHaveBeenCalled();
    const conn = mockClientSideConnection.mock.results[0].value;
    expect(conn.setSessionMode).toHaveBeenCalledWith({
      sessionId: 'acp-sess-abc',
      modeId: 'code',
    });
  });

  it('should apply initial mode via setSessionConfigOption when agent exposes mode config option', async () => {
    mockNewSession.mockResolvedValueOnce({
      sessionId: 'acp-sess-abc',
      configOptions: [
        { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'build', options: [{ value: 'build', name: 'Build' }, { value: 'code', name: 'Code' }] },
      ],
    });
    const bridge = createBridge({ modeId: 'code' });

    await bridge.start();

    const conn = mockClientSideConnection.mock.results[0].value;
    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'acp-sess-abc',
      configId: 'mode',
      value: 'code',
    });
  });

  it('should apply initial model via setSessionConfigOption when agent exposes model config option', async () => {
    mockNewSession.mockResolvedValueOnce({
      sessionId: 'acp-sess-abc',
      configOptions: [
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gpt-4', options: [{ value: 'gpt-4', name: 'GPT-4' }, { value: 'gpt-5', name: 'GPT-5' }] },
      ],
    });
    const bridge = createBridge({ modelId: 'gpt-5' });

    await bridge.start();

    const conn = mockClientSideConnection.mock.results[0].value;
    expect(conn.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'acp-sess-abc',
      configId: 'model',
      value: 'gpt-5',
    });
  });

  it('should warn and continue the session when agent does not expose model config option', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bridge = createBridge({ modelId: 'gpt-5' });
    const initialized = vi.fn();
    bridge.on('acp:initialized', initialized);

    await bridge.start();

    // session still initializes successfully; only a warning is logged
    expect(initialized).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1',
    }));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('initial model'));
  });

  it('should not apply mode/model when not provided', async () => {
    const bridge = createBridge();

    await bridge.start();

    const conn = mockClientSideConnection.mock.results[0].value;
    expect(conn.setSessionMode).not.toHaveBeenCalled();
    expect(conn.setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('resume: should apply initial mode before acp:initialized (rework 时序受控)', async () => {
    const bridge = createBridge({ modeId: 'code' });
    const initialized = vi.fn();
    bridge.on('acp:initialized', initialized);

    await bridge.resume('ext-123');

    // 初始 mode 必须在 acp:initialized 之前应用（initialized → resume:result → prompt 补发）
    const conn = mockClientSideConnection.mock.results[0].value;
    expect(conn.setSessionMode).toHaveBeenCalledWith({
      sessionId: 'ext-123',
      modeId: 'code',
    });
    const setModeOrder = conn.setSessionMode.mock.invocationCallOrder[0];
    expect(setModeOrder).toBeLessThan(initialized.mock.invocationCallOrder[0]);
  });

  it('resume fallback (newSession): should apply initial mode/model before acp:initialized', async () => {
    mockResumeSession.mockRejectedValueOnce(new Error('resume not supported'));
    const bridge = createBridge({ modeId: 'code', modelId: 'gpt-5' });
    const initialized = vi.fn();
    bridge.on('acp:initialized', initialized);

    await bridge.resume('ext-123');

    const conn = mockClientSideConnection.mock.results[0].value;
    // fallback newSession 产生新 acpSessionId，初始 mode/model 仍须先应用
    expect(mockNewSession).toHaveBeenCalled();
    expect(conn.setSessionMode).toHaveBeenCalledWith({
      sessionId: 'acp-sess-abc',
      modeId: 'code',
    });
    expect(conn.setSessionMode.mock.invocationCallOrder[0]).toBeLessThan(
      initialized.mock.invocationCallOrder[0],
    );
  });
});
