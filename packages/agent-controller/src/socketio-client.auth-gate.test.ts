import { describe, it, expect, vi } from 'vitest';

const fake = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => void>();
  const socket: Record<string, any> = {};
  socket.on = (event: string, handler: (...args: any[]) => void) => {
    handlers.set(event, handler);
    return socket;
  };
  socket.emit = vi.fn(() => socket);
  socket.disconnect = vi.fn(() => socket);
  socket.connect = vi.fn(() => socket);
  socket.close = vi.fn(() => socket);
  return { handlers, socket };
});

vi.mock('socket.io-client', () => ({ io: () => fake.socket }));

const probe = vi.hoisted(() => ({ probeAcpServerOptions: vi.fn() }));
vi.mock('./acp/prober.js', () => probe);

const login = vi.hoisted(() => ({
  instances: [] as Array<{
    run: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    finish: (outcome: unknown) => void;
  }>,
}));

vi.mock('./harness/kimi-login.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./harness/kimi-login.js')>();
  class FakeKimiLoginFlow {
    run = vi.fn((handlers: any) => {
      (this as any).handlersRef = handlers;
      return new Promise((resolve) => {
        (this as any).resolveRef = resolve;
      });
    });
    cancel = vi.fn();
    constructor() {
      login.instances.push(this as never);
    }
  }
  return { ...actual, KimiLoginFlow: FakeKimiLoginFlow };
});

import { connectToServer } from './socketio-client.js';
import { version as PACKAGE_VERSION } from '../package.json';

function setup() {
  fake.handlers.clear();
  fake.socket.emit.mockClear();
  login.instances.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  probe.probeAcpServerOptions.mockReset().mockResolvedValue({
    modes: [],
    availableModels: [],
    currentModeId: null,
    currentModelId: null,
  });
  connectToServer('http://localhost:4001', 'key', {
    handshakeToken: 'key',
    skipLocalMcpStart: true,
    handleWorkload: false,
    persistConfig: false,
    onShutdown: vi.fn(),
  });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
function emitted(event: string) {
  return fake.socket.emit.mock.calls.filter((call: unknown[]) => call[0] === event).map((call: unknown[]) => call[1]);
}

describe('CONTROLLER_VERSION', () => {
  it('register 上报版本取自 package.json（2.8.0，无第二处常量）', () => {
    setup();
    fake.handlers.get('connect')?.();
    expect(PACKAGE_VERSION).toBe('2.8.0');
    expect(emitted('register')[0]).toMatchObject({ version: '2.8.0' });
  });
});

describe('harness 登录闸门接线', () => {
  it('非 kimi_code: 零登录流程零事件，探测直接执行', async () => {
    setup();
    await fake.handlers.get('acp:probe-options')?.({
      requestId: 'r1',
      serverType: 'opencode',
    });
    expect(login.instances).toHaveLength(0);
    expect(probe.probeAcpServerOptions).toHaveBeenCalledWith('opencode');
    expect(emitted('harness:login:required')).toHaveLength(0);
  });

  it('kimi_code: required 上行形状 → 登录成功后自动继续探测', async () => {
    setup();
    const pending = fake.handlers.get('acp:probe-options')?.({
      requestId: 'r2',
      serverType: 'kimi_code',
    });
    await tick();
    expect(login.instances).toHaveLength(1);
    expect(emitted('harness:login:required')).toHaveLength(0);

    (login.instances[0] as any).handlersRef.onDeviceFlow({
      url: 'https://www.kimi.com/code/authorize_device?user_code=4CQ4-0XIG',
      userCode: '4CQ4-0XIG',
      expiresInSeconds: 1800,
    });
    const required = emitted('harness:login:required')[0];
    expect(required).toEqual({
      requestId: expect.any(String),
      serverType: 'kimi_code',
      trigger: 'probe-options',
      url: 'https://www.kimi.com/code/authorize_device?user_code=4CQ4-0XIG',
      userCode: '4CQ4-0XIG',
      expiresInSeconds: 1800,
    });

    (login.instances[0] as any).resolveRef({ state: 'logged-in', account: 'managed:kimi-code' });
    await pending;
    expect(emitted('harness:login:succeeded')[0]).toEqual({
      requestId: required.requestId,
      account: 'managed:kimi-code',
    });
    expect(emitted('acp:probe-options:result')[0]).toMatchObject({ requestId: 'r2', success: true });
  });

  it('acp:start 失败：result 带 reason:auth + 文案，并上行 failed', async () => {
    setup();
    const pending = fake.handlers.get('acp:start')?.({
      requestId: 'r3',
      sessionId: 's3',
      serverType: 'kimi_code',
      cwd: '/tmp',
    });
    await tick();
    (login.instances[0] as any).resolveRef({ state: 'failed', reason: 'timeout' });
    await pending;
    expect(emitted('harness:login:failed')[0]).toEqual({
      requestId: expect.any(String),
      reason: 'timeout',
      // error 缺省不输出该键
    });
    expect(emitted('acp:start:result')[0]).toEqual({
      requestId: 'r3',
      sessionId: 's3',
      success: false,
      error: 'Kimi Code 未登录',
      reason: 'auth',
    });
  });

  it('acp:resume 失败：result 带 reason:auth', async () => {
    setup();
    const pending = fake.handlers.get('acp:resume')?.({
      requestId: 'r4',
      sessionId: 's4',
      serverType: 'kimi_code',
      cwd: '/tmp',
      externalSessionId: 'ext-4',
    });
    await tick();
    (login.instances[0] as any).resolveRef({ state: 'failed', reason: 'cancelled' });
    await pending;
    expect(emitted('acp:resume:result')[0]).toMatchObject({
      success: false,
      error: 'Kimi Code 未登录',
      reason: 'auth',
    });
  });

  it('harness:login:cancel 下行：requestId 匹配才 cancel', async () => {
    setup();
    const pending = fake.handlers.get('acp:probe-options')?.({
      requestId: 'r5',
      serverType: 'kimi_code',
    });
    await tick();
    const flow = login.instances[0];
    (flow as any).handlersRef.onDeviceFlow({
      url: 'https://kimi.test/login',
      userCode: 'CODE-1',
      expiresInSeconds: 1800,
    });
    const requestId = (emitted('harness:login:required')[0] as any).requestId;

    fake.handlers.get('harness:login:cancel')?.({ requestId: 'req-other' });
    expect(flow.cancel).not.toHaveBeenCalled();
    fake.handlers.get('harness:login:cancel')?.({ requestId });
    expect(flow.cancel).toHaveBeenCalledTimes(1);

    (flow as any).resolveRef({ state: 'failed', reason: 'cancelled' });
    await pending;
    expect(emitted('acp:probe-options:result')[0]).toMatchObject({ success: false, reason: 'auth' });
  });
});
