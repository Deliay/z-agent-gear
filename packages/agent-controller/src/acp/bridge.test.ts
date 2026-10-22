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
  CreateElicitationRequest: {
    isForm: vi.fn((params: { mode?: string }) => params?.mode === 'form'),
    isUrl: vi.fn((params: { mode?: string }) => params?.mode === 'url'),
  },
}));

import { AcpSessionBridge } from './bridge.js';
import { CLIENT_CAPABILITIES, FEATURE_IDS } from './capabilities.js';

class MockAcpSpawner {
  start = vi.fn();
  stop = vi.fn();
  isRunning = vi.fn().mockReturnValue(true);
  _stdin = new WritableStream();
  _stdout = new ReadableStream();
  /** 可控进程退出：默认不退出，测试显式 triggerExit() */
  private resolveClosed!: () => void;
  private closedPromise = new Promise<void>((resolve) => { this.resolveClosed = resolve; });
  triggerExit(): void { this.resolveClosed(); }
  get stdin() { return this._stdin; }
  get stdout() { return this._stdout; }
  get closed() { return this.closedPromise; }
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

describe('AcpSessionBridge - capability snapshot', () => {
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

  it('T-B1: start() 后 acp:initialized 含 capabilities', async () => {
    const bridge = createBridge();
    const initialized = vi.fn();
    bridge.on('acp:initialized', initialized);

    await bridge.start();

    const payload = initialized.mock.calls[0][0] as { capabilities?: { features?: unknown[]; raw?: { clientCapabilities?: { elicitation?: unknown } } } };
    expect(payload.capabilities).toBeDefined();
    expect(payload.capabilities?.features).toHaveLength(FEATURE_IDS.length);
    // 不引用被测常量自身（否则常量改成 {} 仍恒绿）：显式断言 elicitation 能力实际随 initialize 上送
    expect(payload.capabilities?.raw?.clientCapabilities).toEqual({
      session: { configOptions: { boolean: {} } },
      elicitation: { form: {}, url: {} },
    });
  });

  it('T-B2: resume() 后同样携带 capabilities', async () => {
    const bridge = createBridge();
    const initialized = vi.fn();
    bridge.on('acp:initialized', initialized);

    await bridge.resume('ext-123');

    const payload = initialized.mock.calls[0][0] as { capabilities?: { features?: unknown[] } };
    expect(payload.capabilities?.features).toHaveLength(FEATURE_IDS.length);
  });

  it('T-B6: raw.authMethods 保留 initialize 原文（穿过 start/buildInitializedPayload 调用点）', async () => {
    // 原文含 name/link 等归一化会丢弃的字段，且 type 未重命名为 kind
    const rawAuthMethods = [
      { type: 'env_var', id: 'login', name: 'Login', description: 'sign in', link: 'https://example.com/auth' },
      { id: 'legacy-agent' },
    ];
    mockInitialize.mockResolvedValueOnce({ protocolVersion: 1, authMethods: rawAuthMethods });

    const bridge = createBridge();
    const initialized = vi.fn();
    bridge.on('acp:initialized', initialized);

    await bridge.start();

    const payload = initialized.mock.calls[0][0] as {
      authMethods: unknown;
      capabilities: { raw: { authMethods: unknown } };
    };
    // 下发/展示用归一化产物
    expect(payload.authMethods).toEqual([
      { id: 'login', kind: 'env_var', description: 'sign in', url: null },
      { id: 'legacy-agent', kind: 'agent', description: null, url: null },
    ]);
    // 快照 raw 必须是原文，不能是转换后产物
    expect(payload.capabilities.raw.authMethods).toEqual(rawAuthMethods);
    expect(payload.capabilities.raw.authMethods).not.toEqual(payload.authMethods);
  });
});

describe('AcpSessionBridge - elicitation observability', () => {
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

  it('T-B3: 未知 elicitation 模式返回 cancel 并发出 resolved(unsupported_mode)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bridge = createBridge();

    const result = await bridge.unstable_createElicitation({ mode: 'custom' } as never);

    expect(result).toEqual({ action: 'cancel' });
    expect(mockSocket.emit).toHaveBeenCalledWith('acp:elicitation:resolved', expect.objectContaining({
      requestId: expect.stringMatching(/^elic_\d+_/),
      sessionId: 'sess-1',
      reason: 'unsupported_mode',
      detail: 'custom',
    }));
    expect(mockSocket.emit).not.toHaveBeenCalledWith('acp:elicitation', expect.anything());
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('T-B3b: unsupported_mode 的 detail 截断 Agent 可控字符串', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bridge = createBridge();

    await bridge.unstable_createElicitation({ mode: 'x'.repeat(500) } as never);

    const resolved = mockSocket.emit.mock.calls.find(
      (c: unknown[]) => c[0] === 'acp:elicitation:resolved',
    );
    expect((resolved![1] as { detail: string }).detail).toHaveLength(100);
  });

  it('T-B4: 65s 超时返回 cancel 并发出 resolved(timeout)，不残留 pending', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bridge = createBridge();

    const promise = bridge.unstable_createElicitation({
      mode: 'form',
      message: 'Need input',
      requestedSchema: { type: 'object', properties: {} },
    } as never);

    const emitCall = mockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'acp:elicitation');
    const requestId = (emitCall![1] as { requestId: string }).requestId;

    await vi.advanceTimersByTimeAsync(65_000);

    expect(await promise).toEqual({ action: 'cancel' });
    expect(mockSocket.emit).toHaveBeenCalledWith('acp:elicitation:resolved', expect.objectContaining({
      requestId,
      reason: 'timeout',
      detail: 'bridge timeout (65s)',
    }));
    expect(warnSpy).toHaveBeenCalled();

    bridge.handleElicitationResponse(requestId, 'accept', { answer: 'x' });
    expect(warnSpy).toHaveBeenCalledWith(`Elicitation request ${requestId} not found`);
  });

  it('T-B5: 正常 form 模式只发 acp:elicitation，响应后 65s 内不发 resolved（clearTimeout 生效）', async () => {
    const bridge = createBridge();

    const promise = bridge.unstable_createElicitation({
      mode: 'form',
      message: 'Need input',
      requestedSchema: { type: 'object', properties: {} },
    } as never);

    const emitCall = mockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'acp:elicitation');
    const requestId = (emitCall![1] as { requestId: string }).requestId;

    bridge.handleElicitationResponse(requestId, 'accept', { answer: 'x' });

    expect(await promise).toEqual({ action: 'accept', content: { answer: 'x' } });

    // 推进 65s：已响应的请求不得再发 timeout resolved
    await vi.advanceTimersByTimeAsync(65_000);
    expect(mockSocket.emit).not.toHaveBeenCalledWith('acp:elicitation:resolved', expect.anything());
  });

  it('T-B5b: url 模式 payload 携带 elicitationId/url 且不带 requestedSchema', async () => {
    const bridge = createBridge();

    const promise = bridge.unstable_createElicitation({
      mode: 'url',
      message: 'Authorize',
      elicitationId: 'gh-oauth-1',
      url: 'https://github.com/login/oauth/authorize?x=1',
    } as never);

    expect(mockSocket.emit).toHaveBeenCalledWith('acp:elicitation', {
      requestId: expect.stringMatching(/^elic_\d+_/),
      sessionId: 'sess-1',
      mode: 'url',
      message: 'Authorize',
      elicitationId: 'gh-oauth-1',
      url: 'https://github.com/login/oauth/authorize?x=1',
    });

    const emitCall = mockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'acp:elicitation');
    bridge.handleElicitationResponse((emitCall![1] as { requestId: string }).requestId, 'cancel');
    expect(await promise).toEqual({ action: 'cancel' });
  });

  it('T-B5c: stop() 就地收敛 pending 问询为 cancelled，65s 后不再发 timeout', async () => {
    const bridge = createBridge();

    const promise = bridge.unstable_createElicitation({
      mode: 'form',
      message: 'Need input',
      requestedSchema: { type: 'object', properties: {} },
    } as never);
    const requestId = (mockSocket.emit.mock.calls.find(
      (c: unknown[]) => c[0] === 'acp:elicitation',
    )![1] as { requestId: string }).requestId;

    await bridge.stop();

    expect(await promise).toEqual({ action: 'cancel' });
    expect(mockSocket.emit).toHaveBeenCalledWith('acp:elicitation:resolved', expect.objectContaining({
      requestId,
      reason: 'cancelled',
    }));

    mockSocket.emit.mockClear();
    await vi.advanceTimersByTimeAsync(65_000);
    expect(mockSocket.emit).not.toHaveBeenCalledWith('acp:elicitation:resolved', expect.anything());
  });

  it('T-B5d: stop() 同时收敛 pending 授权为 cancelled 并发出 settled', async () => {
    const bridge = createBridge();
    const settled = vi.fn();
    bridge.on('permission:settled', settled);

    const promise = bridge.requestPermission({
      toolCall: { toolCallId: 'tc-1' },
      options: [{ optionId: 'opt-1', name: 'Allow', kind: 'allow_once' }],
    } as never);

    await bridge.stop();

    expect(await promise).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(settled).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(65_000);
    // timer 已清理：65s 后不会再有新的 permission 事件，且不会二次 settled
    expect(mockSocket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'acp:permission')).toHaveLength(1);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('R1: stop({silent:true}) 不发 acp:stopped（替换/对账旧 bridge 不误删新会话）', async () => {
    const bridge = createBridge();
    const stopped = vi.fn();
    bridge.on('acp:stopped', stopped);
    await bridge.start();

    await bridge.stop({ silent: true });

    expect(mockSocket.emit).not.toHaveBeenCalledWith('acp:stopped', expect.anything());
    expect(stopped).not.toHaveBeenCalled();
  });

  it('R6a: 非 silent stop 在途被 silent stop 覆盖后，迟到 emitStopped 不发 stopped（服务端+本地）', async () => {
    const bridge = createBridge();
    const localStopped = vi.fn();
    bridge.on('acp:stopped', localStopped);
    await bridge.start();
    const connection = (bridge as unknown as {
      connection: { cancel: ReturnType<typeof vi.fn> };
    }).connection;
    connection.cancel.mockReturnValue(new Promise(() => {}));
    mockSocket.emit.mockClear();

    const first = bridge.stop();
    const second = bridge.stop({ silent: true });
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([first, second]);

    expect(mockSocket.emit).not.toHaveBeenCalledWith('acp:stopped', expect.anything());
    expect(localStopped).not.toHaveBeenCalled();
  });

  it('R6b: stop 5s race 在途（stopped 尚未置位）时 handleError 仍被 silentStop 抑制（服务端+本地）', async () => {
    const bridge = createBridge();
    const localStopped = vi.fn();
    bridge.on('acp:stopped', localStopped);
    await bridge.start();
    const connection = (bridge as unknown as {
      connection: { cancel: ReturnType<typeof vi.fn> };
    }).connection;
    connection.cancel.mockReturnValue(new Promise(() => {}));
    mockSocket.emit.mockClear();

    const first = bridge.stop();
    const second = bridge.stop({ silent: true });
    // 此时 stopped 仍为 false（emitStopped 尚未执行），只能靠 silentStop 早退
    (bridge as unknown as { handleError: (error: unknown) => void })
      .handleError(new Error('late init failure in stop race window'));

    expect(mockSocket.emit).not.toHaveBeenCalledWith('acp:stopped', expect.anything());
    expect(localStopped).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([first, second]);
    expect(localStopped).not.toHaveBeenCalled();
  });

  it('R5a: silent stop 后迟到的 handleError 不再向服务端/本地发 acp:stopped', async () => {
    const bridge = createBridge();
    const stopped = vi.fn();
    bridge.on('acp:stopped', stopped);
    await bridge.start();
    await bridge.stop({ silent: true });
    mockSocket.emit.mockClear();

    (bridge as unknown as { handleError: (error: unknown) => void })
      .handleError(new Error('late init failure after replacement'));

    expect(mockSocket.emit).not.toHaveBeenCalledWith('acp:stopped', expect.anything());
    expect(stopped).not.toHaveBeenCalled();
  });

  it('R3: stop() 在 cancel/closeSession 的 5s race 之前同步收敛 pending', async () => {
    const bridge = createBridge();
    await bridge.start();

    const promise = bridge.unstable_createElicitation({
      mode: 'form',
      message: 'Need input',
      requestedSchema: { type: 'object', properties: {} },
    } as never);

    // 模拟 cancel 永久挂起：若 settle 在 5s race 之后，下面的 await 会超时
    const connection = (bridge as unknown as {
      connection: { cancel: ReturnType<typeof vi.fn> };
    }).connection;
    connection.cancel.mockReturnValue(new Promise(() => {}));

    const stopPromise = bridge.stop();
    expect(await promise).toEqual({ action: 'cancel' });
    expect(mockSocket.emit).toHaveBeenCalledWith('acp:elicitation:resolved', expect.objectContaining({
      reason: 'cancelled',
    }));

    await vi.advanceTimersByTimeAsync(5000);
    await stopPromise;
  });

  it('T-B11: 进程退出（spawner.closed）收敛 pending 并发 cancelled，65s 后不再发 timeout', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bridge = createBridge();
    await bridge.start();

    const promise = bridge.unstable_createElicitation({
      mode: 'form',
      message: 'Need input',
      requestedSchema: { type: 'object', properties: {} },
    } as never);
    const requestId = (mockSocket.emit.mock.calls.find(
      (c: unknown[]) => c[0] === 'acp:elicitation',
    )![1] as { requestId: string }).requestId;

    mockSpawner.triggerExit();
    await Promise.resolve();
    await Promise.resolve();

    expect(await promise).toEqual({ action: 'cancel' });
    expect(mockSocket.emit).toHaveBeenCalledWith('acp:elicitation:resolved', expect.objectContaining({
      requestId,
      reason: 'cancelled',
      detail: 'process exited',
    }));

    // 真实时钟推进 65s：timer 已清理，不得再发 timeout
    const resolvedReasons = mockSocket.emit.mock.calls
      .filter((c: unknown[]) => c[0] === 'acp:elicitation:resolved')
      .map((c: unknown[]) => (c[1] as { reason: string }).reason);
    await vi.advanceTimersByTimeAsync(65_000);
    const afterReasons = mockSocket.emit.mock.calls
      .filter((c: unknown[]) => c[0] === 'acp:elicitation:resolved')
      .map((c: unknown[]) => (c[1] as { reason: string }).reason);
    expect(afterReasons).toEqual(resolvedReasons);
    expect(afterReasons).not.toContain('timeout');
  });

  it('T-B11b: 连接断开（settlePendingOnDisconnect）收敛 pending 且不发 timeout', async () => {
    const bridge = createBridge();
    await bridge.start();

    const promise = bridge.unstable_createElicitation({
      mode: 'form',
      message: 'Need input',
      requestedSchema: { type: 'object', properties: {} },
    } as never);

    bridge.settlePendingOnDisconnect();

    expect(await promise).toEqual({ action: 'cancel' });
    await vi.advanceTimersByTimeAsync(65_000);
    const reasons = mockSocket.emit.mock.calls
      .filter((c: unknown[]) => c[0] === 'acp:elicitation:resolved')
      .map((c: unknown[]) => (c[1] as { reason: string }).reason);
    expect(reasons).toEqual(['cancelled']);
  });

  it('T-B11c: 收敛时发出 settled 事件（供请求级 Map 清理），响应/超时同样触发', async () => {
    const bridge = createBridge();
    const elicitationSettled = vi.fn();
    const permissionSettled = vi.fn();
    bridge.on('elicitation:settled', elicitationSettled);
    bridge.on('permission:settled', permissionSettled);

    const elicitationPromise = bridge.unstable_createElicitation({
      mode: 'form',
      message: 'Need input',
      requestedSchema: { type: 'object', properties: {} },
    } as never);
    const elicitationId = (mockSocket.emit.mock.calls.find(
      (c: unknown[]) => c[0] === 'acp:elicitation',
    )![1] as { requestId: string }).requestId;
    bridge.handleElicitationResponse(elicitationId, 'decline');
    await elicitationPromise;
    expect(elicitationSettled).toHaveBeenCalledWith(elicitationId);

    const permissionPromise = bridge.requestPermission({
      toolCall: { toolCallId: 'tc-1' },
      options: [{ optionId: 'opt-1', name: 'Allow', kind: 'allow_once' }],
    } as never);
    const permissionId = (mockSocket.emit.mock.calls.find(
      (c: unknown[]) => c[0] === 'acp:permission',
    )![1] as { requestId: string }).requestId;
    await vi.advanceTimersByTimeAsync(65_000);
    await permissionPromise;
    expect(permissionSettled).toHaveBeenCalledWith(permissionId);
  });

  it('T-B5e: Agent 自发 complete 时收敛 pending 并发 resolved(cancelled)', async () => {
    const bridge = createBridge();

    const promise = bridge.unstable_createElicitation({
      mode: 'url',
      message: 'Authorize',
      elicitationId: 'gh-oauth-2',
      url: 'https://example.com/auth',
    } as never);

    const requestId = (mockSocket.emit.mock.calls.find(
      (c: unknown[]) => c[0] === 'acp:elicitation',
    )![1] as { requestId: string }).requestId;

    await bridge.unstable_completeElicitation({ elicitationId: 'gh-oauth-2' } as never);

    expect(await promise).toEqual({ action: 'cancel' });
    expect(mockSocket.emit).toHaveBeenCalledWith('acp:elicitation:complete', {
      sessionId: 'sess-1',
      elicitationId: 'gh-oauth-2',
    });
    expect(mockSocket.emit).toHaveBeenCalledWith('acp:elicitation:resolved', expect.objectContaining({
      requestId,
      reason: 'cancelled',
      detail: 'agent completed elicitation',
    }));

    mockSocket.emit.mockClear();
    await vi.advanceTimersByTimeAsync(65_000);
    expect(mockSocket.emit).not.toHaveBeenCalledWith('acp:elicitation:resolved', expect.anything());
  });
});
