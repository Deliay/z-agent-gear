import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fake = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const socket = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
      return socket;
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
    connect: vi.fn(),
    close: vi.fn(),
  };
  return { handlers, socket };
});

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => fake.socket),
}));

// 用可控 fake bridge 验证 reconcile / disconnect 的生命周期接线（不启动真实 ACP 进程）
const fakeBridges = vi.hoisted(() => ({ instances: [] as Array<Record<string, unknown>> }));
vi.mock('./acp/bridge.js', async () => {
  const { EventEmitter } = await import('events');
  class FakeAcpSessionBridge extends EventEmitter {
    start = vi.fn().mockResolvedValue(undefined);
    resume = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    settlePendingOnDisconnect = vi.fn();
    constructor() {
      super();
      fakeBridges.instances.push(this as unknown as Record<string, unknown>);
    }
  }
  return { AcpSessionBridge: FakeAcpSessionBridge };
});

vi.mock('./acp/spawner.js', () => ({
  AcpSpawner: class {
    pid = undefined as number | undefined;
    start = vi.fn();
    stop = vi.fn();
    closed = Promise.resolve();
    stdin = {};
    stdout = {};
  },
}));

import { buildAcpInitResult, cloudHostReconnectDelay, connectToServer } from './socketio-client.js';
import { processRegistry } from './acp/process-registry.js';
import { McpRelay } from './mcp/relay.js';

function errorHandler(): (payload: { code: string; message: string }) => void {
  const handler = fake.handlers.get('error');
  if (!handler) throw new Error('error handler not registered');
  return handler as (payload: { code: string; message: string }) => void;
}

function shutdownHandler(): (payload: { reason: string }) => void {
  const handler = fake.handlers.get('shutdown');
  if (!handler) throw new Error('shutdown handler not registered');
  return handler as (payload: { reason: string }) => void;
}

function setup(withShutdown = true) {
  const onShutdown = vi.fn();
  connectToServer('http://localhost:4001', 'controller-key', {
    serverName: 'test-controller',
    handshakeToken: 'controller-key',
    skipLocalMcpStart: true,
    handleWorkload: false,
    persistConfig: false,
    ...(withShutdown ? { onShutdown } : {}),
  });
  return { onShutdown };
}

describe('cloud-host reconnect backoff (C-3)', () => {
  beforeEach(() => {
    fake.handlers.clear();
    fake.socket.on.mockClear();
    fake.socket.emit.mockClear();
    fake.socket.disconnect.mockClear();
    fake.socket.connect.mockClear();
    fake.socket.close.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('backs off exponentially from 1s and caps at 30s', () => {
    expect(cloudHostReconnectDelay(0)).toBe(1000);
    expect(cloudHostReconnectDelay(1)).toBe(2000);
    expect(cloudHostReconnectDelay(2)).toBe(4000);
    expect(cloudHostReconnectDelay(4)).toBe(16000);
    expect(cloudHostReconnectDelay(5)).toBe(30000);
    expect(cloudHostReconnectDelay(10)).toBe(30000);
  });

  it('KEY_ALREADY_ONLINE reconnects in cloud-host mode after 1s then 2s', () => {
    const { onShutdown } = setup(true);
    const handler = errorHandler();

    handler({ code: 'KEY_ALREADY_ONLINE', message: 'Key already has an active session' });

    expect(fake.socket.disconnect).toHaveBeenCalledTimes(1);
    expect(onShutdown).not.toHaveBeenCalled();
    expect(fake.socket.connect).not.toHaveBeenCalled();

    vi.advanceTimersByTime(999);
    expect(fake.socket.connect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fake.socket.connect).toHaveBeenCalledTimes(1);

    // 再次冲突：退避翻倍到 2s
    handler({ code: 'KEY_ALREADY_ONLINE', message: 'Key already has an active session' });
    vi.advanceTimersByTime(1999);
    expect(fake.socket.connect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fake.socket.connect).toHaveBeenCalledTimes(2);
  });

  it('escalates backoff across real connect→error cycles (R2-6)', () => {
    setup(true);
    const handler = errorHandler();

    // 第一次冲突：1s
    handler({ code: 'KEY_ALREADY_ONLINE', message: 'busy' });
    vi.advanceTimersByTime(1000);
    expect(fake.socket.connect).toHaveBeenCalledTimes(1);

    // 真实时序：先 connect，再收到 KEY_ALREADY_ONLINE；不得因 connect 归零
    fake.handlers.get('connect')?.();
    handler({ code: 'KEY_ALREADY_ONLINE', message: 'busy' });
    vi.advanceTimersByTime(1999);
    expect(fake.socket.connect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fake.socket.connect).toHaveBeenCalledTimes(2);

    // 注册成功（registered）才重置：下一轮恢复 1s
    fake.handlers.get('registered')?.({ controllerId: 'c-1' });
    handler({ code: 'KEY_ALREADY_ONLINE', message: 'busy' });
    vi.advanceTimersByTime(999);
    expect(fake.socket.connect).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(fake.socket.connect).toHaveBeenCalledTimes(3);
  });

  it('does not reconnect after a normal shutdown (timer is cleared)', () => {
    const { onShutdown } = setup(true);
    errorHandler()({ code: 'KEY_ALREADY_ONLINE', message: 'busy' });

    shutdownHandler()({ reason: 'server requested shutdown' });

    expect(onShutdown).toHaveBeenCalledWith({ reason: 'server requested shutdown' });
    vi.advanceTimersByTime(60_000);
    expect(fake.socket.connect).not.toHaveBeenCalled();
  });

  it('keeps legacy behaviour outside cloud-host mode (no manual reconnect)', () => {
    setup(false);
    errorHandler()({ code: 'KEY_ALREADY_ONLINE', message: 'busy' });

    expect(fake.socket.disconnect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(fake.socket.connect).not.toHaveBeenCalled();
  });

  it('forwards error paths with failure-prefixed reasons for exit-code classification', () => {
    const { onShutdown } = setup(true);

    errorHandler()({ code: 'VERSION_MISMATCH', message: 'too old' });
    expect(onShutdown).toHaveBeenCalledWith({ reason: 'version_mismatch: too old' });

    const second = setup(true);
    errorHandler()({ code: 'REGISTER_FAILED', message: 'boom' });
    expect(second.onShutdown).toHaveBeenCalledWith({ reason: 'error: REGISTER_FAILED' });
  });
});

describe('idle-path exit codes (contract §3.7)', () => {
  beforeEach(() => {
    fake.handlers.clear();
    fake.socket.on.mockClear();
    fake.socket.emit.mockClear();
    fake.socket.disconnect.mockClear();
    fake.socket.close.mockClear();
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('unregistered exits 42 (server termination)', () => {
    setup(false);
    expect(() => fake.handlers.get('unregistered')?.()).toThrow('exit:42');
  });

  it('server shutdown exits 42, failure shutdown exits 1', () => {
    setup(false);
    expect(() => shutdownHandler()({ reason: 'server requested shutdown' })).toThrow('exit:42');

    fake.handlers.clear();
    setup(false);
    expect(() => shutdownHandler()({ reason: 'error: REGISTER_FAILED' })).toThrow('exit:1');
  });

  it('error INVALID_TOKEN exits 42 instead of the generic failure code', () => {
    setup(false);
    expect(() => errorHandler()({ code: 'INVALID_TOKEN', message: 'token expired' })).toThrow('exit:42');
  });

  it('connect_error INVALID_TOKEN exits 42', () => {
    setup(false);
    const error = Object.assign(new Error('INVALID_TOKEN'), { data: { code: 'INVALID_TOKEN' } });
    expect(() => fake.handlers.get('connect_error')?.(error)).toThrow('exit:42');
  });
});

describe('buildAcpInitResult', () => {
  it('T-SC1: payload 带 capabilities 时透传，既有字段一个不少', () => {
    const capabilities = {
      protocolVersion: 1,
      agentInfo: { name: 'OpenCode', version: '2.0.31' },
      features: [{ id: 'session.load', status: 'supported', detail: null }],
      raw: { agentCapabilities: {}, authMethods: [], clientCapabilities: {} },
    };
    const payload = {
      sessionId: 'sess-1',
      acpSessionId: 'acp-1',
      modes: [{ id: 'build', name: 'Build' }],
      currentModeId: 'build',
      currentModel: { id: 'm1', name: 'M1' },
      availableModels: [{ id: 'm1', name: 'M1' }],
      currentModelId: 'm1',
      configOptions: [{ id: 'model', type: 'select' }],
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      agentInfo: { name: 'OpenCode', version: '2.0.31' },
      authMethods: [{ id: 'login', kind: 'agent' }],
      supportsAdditionalDirectories: true,
      capabilities,
    };

    const result = buildAcpInitResult(payload);

    expect(result.capabilities).toEqual(capabilities);
    expect(result.modes).toEqual(payload.modes);
    expect(result.currentModeId).toBe('build');
    expect(result.currentModel).toEqual(payload.currentModel);
    expect(result.availableModels).toEqual(payload.availableModels);
    expect(result.currentModelId).toBe('m1');
    expect(result.configOptions).toEqual(payload.configOptions);
    expect(result.promptCapabilities).toEqual(payload.promptCapabilities);
    expect(result.agentInfo).toEqual(payload.agentInfo);
    expect(result.authMethods).toEqual(payload.authMethods);
    expect(result.supportsAdditionalDirectories).toBe(true);
    // requestId/sessionId/success 由调用处补充，纯函数不负责
    expect(result).not.toHaveProperty('requestId');
  });

  it('T-SC2: 旧 payload 不带 capabilities 时结果不含该键（零退化）', () => {
    const result = buildAcpInitResult({
      modes: [],
      availableModels: [],
      configOptions: [],
    });

    expect(result).not.toHaveProperty('capabilities');
    expect(result.modes).toEqual([]);
    expect(result.availableModels).toEqual([]);
    expect(result.configOptions).toEqual([]);
    expect(result).not.toHaveProperty('currentModeId');
    expect(result).not.toHaveProperty('agentInfo');
  });
});

describe('ACP bridge lifecycle wiring (reconcile / disconnect)', () => {
  beforeEach(() => {
    fake.handlers.clear();
    fakeBridges.instances.length = 0;
    fake.socket.emit.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function startBridge(sessionId: string) {
    setup(true);
    fake.handlers.get('acp:start')?.({
      requestId: `req-${sessionId}`,
      sessionId,
      serverType: 'opencode',
      cwd: '/tmp',
    });
    await vi.waitFor(() => {
      expect(fakeBridges.instances.length).toBe(1);
    });
    return fakeBridges.instances[0] as unknown as {
      stop: ReturnType<typeof vi.fn>;
      settlePendingOnDisconnect: ReturnType<typeof vi.fn>;
    };
  }

  /** 由 acp:resume 创建旧 bridge：其内联/onStopped 监听器属于 resume 路径（R8a） */
  async function startBridgeViaResume(sessionId: string) {
    setup(true);
    fake.handlers.get('acp:resume')?.({
      requestId: `resume-${sessionId}`,
      sessionId,
      serverType: 'opencode',
      cwd: '/tmp',
      externalSessionId: 'ext-r8',
    });
    await vi.waitFor(() => {
      expect(fakeBridges.instances.length).toBe(1);
    });
    return fakeBridges.instances[0] as unknown as {
      stop: ReturnType<typeof vi.fn>;
      settlePendingOnDisconnect: ReturnType<typeof vi.fn>;
      emit: (event: string, payload: unknown) => void;
    };
  }

  it('N3-reconcile: 对账杀会话调用 bridge.stop()（收敛 pending，不再迟发 timeout）', async () => {
    const bridge = await startBridge('sess-reconcile');
    processRegistry.register('sess-reconcile', { pid: 999999, cwd: '/tmp', acpServerType: 'opencode' });

    fake.handlers.get('acp:reconcile')?.({
      activeSessionIds: [],
      pendingKillSessionIds: ['sess-reconcile'],
    });
    await vi.waitFor(() => {
      expect(bridge.stop).toHaveBeenCalledWith({ silent: true });
    });
    expect(bridge.settlePendingOnDisconnect).toHaveBeenCalled();

    processRegistry.deregister('sess-reconcile');
    expect(fake.socket.emit).not.toHaveBeenCalledWith('acp:elicitation:resolved', expect.anything());
    expect(fake.socket.emit).not.toHaveBeenCalledWith('acp:stopped', expect.anything());
  });

  it('R1: 同 sessionId 重建后旧 bridge 的迟到 stopped 不影响新会话', async () => {
    const unregisterSpy = vi.spyOn(McpRelay.prototype, 'unregisterSession');
    const oldBridge = await startBridge('sess-replace');
    // 同 sessionId 再次 acp:start：旧 bridge 被 silent 停掉并新建
    fake.handlers.get('acp:start')?.({
      requestId: 'req-new',
      sessionId: 'sess-replace',
      serverType: 'opencode',
      cwd: '/tmp',
    });
    await vi.waitFor(() => {
      expect(fakeBridges.instances.length).toBe(2);
    });
    processRegistry.register('sess-replace', { pid: 123456, cwd: '/tmp', acpServerType: 'opencode' });
    fake.socket.emit.mockClear();

    // 旧 bridge 迟到 stopped（例如 5s race 后 emitStopped）：内联监听器与 onStopped 的
    // 持有权守卫都必须拦住，不得注销新会话的 process registry / MCP relay 注册。
    (oldBridge as unknown as { emit: (event: string, payload: unknown) => void })
      .emit('acp:stopped', { sessionId: 'sess-replace', reason: 'user_close' });

    expect(processRegistry.get('sess-replace')).toBeDefined();
    expect(unregisterSpy).not.toHaveBeenCalledWith('sess-replace');
    expect(fake.socket.emit).not.toHaveBeenCalledWith('acp:start:result', expect.anything());
    processRegistry.deregister('sess-replace');
  });

  it('R6a-空档: 替换 delete→set 窗口（current===undefined）旧 stopped 不注销注册/relay', async () => {
    const unregisterSpy = vi.spyOn(McpRelay.prototype, 'unregisterSession');
    const oldBridge = await startBridge('sess-gap');
    processRegistry.register('sess-gap', { pid: 654321, cwd: '/tmp', acpServerType: 'opencode' });

    let releaseStop!: () => void;
    (oldBridge as unknown as { stop: ReturnType<typeof vi.fn> }).stop.mockReturnValueOnce(
      new Promise<void>((resolve) => { releaseStop = resolve; }),
    );
    // 替换路径：delete 后 await 旧 stop，此时 acpBridges 处于「无当前 bridge」空档
    const restartPromise = (fake.handlers.get('acp:start') as unknown as (
      payload: Record<string, unknown>,
    ) => Promise<void>)({
      requestId: 'req-gap',
      sessionId: 'sess-gap',
      serverType: 'opencode',
      cwd: '/tmp',
    });
    await vi.waitFor(() => {
      expect((oldBridge as unknown as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalledWith({ silent: true });
    });

    (oldBridge as unknown as { emit: (event: string, payload: unknown) => void })
      .emit('acp:stopped', { sessionId: 'sess-gap', reason: 'user_close' });

    expect(processRegistry.get('sess-gap')).toBeDefined();
    expect(unregisterSpy).not.toHaveBeenCalledWith('sess-gap');
    releaseStop();
    await restartPromise;
    processRegistry.deregister('sess-gap');
  });

  it('R6a-resume: resume 替换同 sessionId 后旧 stopped 不注销新会话注册/relay', async () => {
    const unregisterSpy = vi.spyOn(McpRelay.prototype, 'unregisterSession');
    const oldBridge = await startBridge('sess-resume-replace');
    processRegistry.register('sess-resume-replace', { pid: 777777, cwd: '/tmp', acpServerType: 'opencode' });

    (fake.handlers.get('acp:resume') as unknown as (payload: Record<string, unknown>) => Promise<void>)({
      requestId: 'req-resume',
      sessionId: 'sess-resume-replace',
      serverType: 'opencode',
      cwd: '/tmp',
      externalSessionId: 'ext-1',
    });
    await vi.waitFor(() => expect(fakeBridges.instances.length).toBe(2));
    fake.socket.emit.mockClear();

    (oldBridge as unknown as { emit: (event: string, payload: unknown) => void })
      .emit('acp:stopped', { sessionId: 'sess-resume-replace', reason: 'error' });

    expect(processRegistry.get('sess-resume-replace')).toBeDefined();
    expect(unregisterSpy).not.toHaveBeenCalledWith('sess-resume-replace');
    expect(fake.socket.emit).not.toHaveBeenCalledWith('acp:resume:result', expect.anything());
    processRegistry.deregister('sess-resume-replace');
  });

  it('R8a: resume 创建的旧 bridge 在替换空档迟到 stopped 不注销 registry/relay、不发 resume result', async () => {
    const unregisterSpy = vi.spyOn(McpRelay.prototype, 'unregisterSession');
    const oldBridge = await startBridgeViaResume('sess-r8');
    processRegistry.register('sess-r8', { pid: 888888, cwd: '/tmp', acpServerType: 'opencode' });

    let releaseStop!: () => void;
    oldBridge.stop.mockReturnValueOnce(new Promise<void>((resolve) => { releaseStop = resolve; }));
    const restartPromise = (fake.handlers.get('acp:start') as unknown as (
      payload: Record<string, unknown>,
    ) => Promise<void>)({
      requestId: 'req-r8',
      sessionId: 'sess-r8',
      serverType: 'opencode',
      cwd: '/tmp',
    });
    await vi.waitFor(() => {
      expect(oldBridge.stop).toHaveBeenCalledWith({ silent: true });
    });

    // 替换 delete→set 空档：resume 路径的内联 + onStopped 监听器都会被触达
    oldBridge.emit('acp:stopped', { sessionId: 'sess-r8', reason: 'error' });

    expect(processRegistry.get('sess-r8')).toBeDefined();
    expect(unregisterSpy).not.toHaveBeenCalledWith('sess-r8');
    expect(fake.socket.emit).not.toHaveBeenCalledWith('acp:resume:result', expect.anything());

    releaseStop();
    await restartPromise;
    processRegistry.deregister('sess-r8');
  });

  it('R6c: acp:stop 在途时同 sessionId 被替换，迟到 ack 不得发 acp:stopped', async () => {
    const oldBridge = await startBridge('sess-stop-replace');
    let releaseStop!: () => void;
    (oldBridge as unknown as { stop: ReturnType<typeof vi.fn> }).stop.mockReturnValueOnce(
      new Promise<void>((resolve) => { releaseStop = resolve; }),
    );

    const stopHandler = fake.handlers.get('acp:stop') as unknown as (
      payload: { sessionId: string; ackRequired: boolean },
    ) => Promise<void>;
    const stopPromise = stopHandler({ sessionId: 'sess-stop-replace', ackRequired: true });

    // 替换路径：同 sessionId 重新 acp:start（旧 bridge.stop 第二次调用走 mockResolvedValue）
    fake.handlers.get('acp:start')?.({
      requestId: 'req-shift',
      sessionId: 'sess-stop-replace',
      serverType: 'opencode',
      cwd: '/tmp',
    });
    await vi.waitFor(() => expect(fakeBridges.instances.length).toBe(2));

    releaseStop();
    await stopPromise;

    expect(fake.socket.emit).not.toHaveBeenCalledWith('acp:stopped', expect.anything());
  });

  it('N3-disconnect: 断线时对每个 bridge 调用 settlePendingOnDisconnect（socket.io 不缓存迟到 timeout）', async () => {
    const bridge = await startBridge('sess-disconnect');

    fake.handlers.get('disconnect')?.('transport close');

    expect(bridge.settlePendingOnDisconnect).toHaveBeenCalledTimes(1);
  });
});
