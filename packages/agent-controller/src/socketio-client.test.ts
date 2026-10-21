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

import { buildAcpInitResult, cloudHostReconnectDelay, connectToServer } from './socketio-client.js';

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
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
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
