import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Socket } from 'socket.io-client';
import {
  CLOUD_HOST_MODE_KEYS,
  DEFAULT_HARNESS_INIT_WAIT_MS,
  DEFAULT_WORKSPACE,
  CloudHostEnvError,
  isCloudHostMode,
  parseInitWaitMs,
  readCloudHostEnv,
  startCloudHostSupervisor,
} from './supervisor.js';
import type { ConnectToServerOptions } from '../socketio-client.js';

const TMP_BASE = '/tmp/opencode';

const BASE_ENV: NodeJS.ProcessEnv = {
  ZAG_HOST_ENDPOINT: 'wss://controller.example.com',
  ZAG_HOST_KEY: 'zag_k_1_host_key_secret',
  ZAG_CONTROLLER_KEY: 'controller-token-secret',
  ZAG_SERVER_ENDPOINT: 'wss://cloud-controller.example.com/worker',
  ZAG_HOST_NAME: 'my-cloud-host',
  ZAG_DEFAULT_WORKSPACE: '/root/workspace',
};

interface FakeSocket {
  disconnect: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
}

function fakeSocket(): FakeSocket {
  return { disconnect: vi.fn(), emit: vi.fn() };
}

function setup(overrides: { env?: NodeJS.ProcessEnv; makeDir?: (path: string) => Promise<void> } = {}) {
  const worker = fakeSocket();
  const controller = fakeSocket();
  const connect = vi.fn((endpoint: string, key: string, options?: ConnectToServerOptions) => {
    void endpoint;
    void key;
    void options;
    return (connect.mock.calls.length === 1 ? worker : controller) as unknown as Socket;
  });
  const exit = vi.fn();
  const logs: string[] = [];
  return {
    worker,
    controller,
    connect,
    exit,
    logs,
    deps: {
      env: overrides.env ?? { ...BASE_ENV },
      connect: connect as never,
      makeDir: overrides.makeDir ?? (async () => {}),
      exit,
      log: (message: string) => logs.push(message),
      installSignalHandlers: false,
    },
  };
}

describe('cloud host mode detection (T-AG2)', () => {
  it('requires all three cloud-host env variables to be non-empty', () => {
    expect(isCloudHostMode(BASE_ENV)).toBe(true);
    for (const key of CLOUD_HOST_MODE_KEYS) {
      expect(isCloudHostMode({ ...BASE_ENV, [key]: '' })).toBe(false);
      expect(isCloudHostMode({ ...BASE_ENV, [key]: '   ' })).toBe(false);
      expect(isCloudHostMode({ ...BASE_ENV, [key]: undefined })).toBe(false);
    }
    // 本地控制器单连接（无 ZAG_HOST_*）不进入云电脑模式
    expect(isCloudHostMode({
      ZAG_SERVER_ENDPOINT: 'http://localhost:4001',
      ZAG_CONTROLLER_KEY: 'zag_k_1_local',
    })).toBe(false);
  });

  it('parses HARNESS_INIT_WAIT_MS with the 10 minute default', () => {
    expect(parseInitWaitMs(undefined)).toBe(DEFAULT_HARNESS_INIT_WAIT_MS);
    expect(DEFAULT_HARNESS_INIT_WAIT_MS).toBe(600_000);
    expect(parseInitWaitMs('1500')).toBe(1500);
    expect(parseInitWaitMs('0')).toBe(DEFAULT_HARNESS_INIT_WAIT_MS);
    expect(parseInitWaitMs('-1')).toBe(DEFAULT_HARNESS_INIT_WAIT_MS);
    expect(parseInitWaitMs('abc')).toBe(DEFAULT_HARNESS_INIT_WAIT_MS);
  });
});

describe('readCloudHostEnv (T-AG7)', () => {
  it('reads required values and applies defaults', () => {
    const env = readCloudHostEnv({
      ZAG_HOST_ENDPOINT: ' wss://controller.example.com ',
      ZAG_HOST_KEY: 'host-key',
      ZAG_CONTROLLER_KEY: 'worker-token',
      ZAG_SERVER_ENDPOINT: 'wss://cc.example.com/worker',
    });

    expect(env).toMatchObject({
      hostEndpoint: 'wss://controller.example.com',
      hostKey: 'host-key',
      controllerKey: 'worker-token',
      serverEndpoint: 'wss://cc.example.com/worker',
      workspace: DEFAULT_WORKSPACE,
      initWaitMs: DEFAULT_HARNESS_INIT_WAIT_MS,
    });
    expect(env.hostName.length).toBeGreaterThan(0);
  });

  it('lists every missing variable by name without leaking values of present ones', () => {
    let error: unknown;
    try {
      readCloudHostEnv({
        ZAG_HOST_ENDPOINT: 'wss://controller.example.com',
        ZAG_HOST_KEY: 'super-secret-host-key',
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CloudHostEnvError);
    const message = (error as Error).message;
    expect(message).toContain('ZAG_CONTROLLER_KEY');
    expect(message).toContain('ZAG_SERVER_ENDPOINT');
    expect(message).not.toContain('super-secret-host-key');
    expect(message).not.toContain('wss://controller.example.com');
  });
});

describe('startCloudHostSupervisor', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('T-AG6: creates the default workspace idempotently before connecting', async () => {
    await mkdir(TMP_BASE, { recursive: true });
    const dir = await mkdtemp(join(TMP_BASE, 'supervisor-'));
    dirs.push(dir);
    const workspace = join(dir, 'workspace', 'nested');

    const context = setup({
      env: { ...BASE_ENV, ZAG_DEFAULT_WORKSPACE: workspace },
      makeDir: async (path: string) => {
        await mkdir(path, { recursive: true });
      },
    });
    const handle = await startCloudHostSupervisor(context.deps);
    await startCloudHostSupervisor(context.deps);

    expect((await stat(workspace)).isDirectory()).toBe(true);
    expect(handle.workspace).toBe(workspace);
    // makeDir 在连接之前完成（connect 的调用发生在其后）
    expect(context.connect).toHaveBeenCalledTimes(2);
  });

  it('T-AG3: connects /worker first with the one-time token and no local MCP server', async () => {
    const context = setup();
    const handle = await startCloudHostSupervisor(context.deps);

    expect(context.connect).toHaveBeenCalledTimes(1);
    const [endpoint, key, options] = context.connect.mock.calls[0] as [string, string, ConnectToServerOptions];
    expect(endpoint).toBe(BASE_ENV.ZAG_SERVER_ENDPOINT);
    expect(key).toBe(BASE_ENV.ZAG_CONTROLLER_KEY);
    expect(options).toMatchObject({
      serverName: 'my-cloud-host',
      handshakeToken: BASE_ENV.ZAG_CONTROLLER_KEY,
      skipLocalMcpStart: true,
      handleWorkload: true,
      persistConfig: false,
    });
    expect(handle.controllerSocket).toBeNull();
  });

  it('T-AG3b: connects controller-api immediately when initializing is false/absent', async () => {
    const context = setup();
    await startCloudHostSupervisor(context.deps);

    const workerOptions = context.connect.mock.calls[0][2] as ConnectToServerOptions;
    workerOptions.onRegistered?.({ controllerId: 'container-1', initializing: false });

    expect(context.connect).toHaveBeenCalledTimes(2);
    const [endpoint, key, options] = context.connect.mock.calls[1] as [string, string, ConnectToServerOptions];
    expect(endpoint).toBe(BASE_ENV.ZAG_HOST_ENDPOINT);
    expect(key).toBe(BASE_ENV.ZAG_HOST_KEY);
    expect(options).toMatchObject({
      handshakeToken: BASE_ENV.ZAG_HOST_KEY,
      skipLocalMcpStart: false,
      handleWorkload: false,
      persistConfig: false,
    });

    // 重复 registered（重连）不应重复建连
    workerOptions.onRegistered?.({ controllerId: 'container-1' });
    expect(context.connect).toHaveBeenCalledTimes(2);
  });

  it('T-AG4: waits for the first init workload batch when initializing=true', async () => {
    const context = setup();
    await startCloudHostSupervisor(context.deps);
    const workerOptions = context.connect.mock.calls[0][2] as ConnectToServerOptions;

    workerOptions.onRegistered?.({ controllerId: 'container-1', initializing: true });
    expect(context.connect).toHaveBeenCalledTimes(1);

    // post 批次不触发标准连接
    workerOptions.onWorkloadBatchComplete?.({ phase: 'post', itemCount: 1, status: 'completed' });
    expect(context.connect).toHaveBeenCalledTimes(1);

    workerOptions.onWorkloadBatchComplete?.({ phase: 'init', itemCount: 2, status: 'completed' });
    expect(context.connect).toHaveBeenCalledTimes(2);
  });

  it('T-AG4b: connects after a failed init batch too', async () => {
    const context = setup();
    await startCloudHostSupervisor(context.deps);
    const workerOptions = context.connect.mock.calls[0][2] as ConnectToServerOptions;

    workerOptions.onRegistered?.({ controllerId: 'container-1', initializing: true });
    workerOptions.onWorkloadBatchComplete?.({ phase: 'init', itemCount: 1, status: 'failed', error: 'boom' });

    expect(context.connect).toHaveBeenCalledTimes(2);
  });

  it('T-AG4e: does not treat an interrupted (cancelled) init batch as complete', async () => {
    const context = setup();
    await startCloudHostSupervisor(context.deps);
    const workerOptions = context.connect.mock.calls[0][2] as ConnectToServerOptions;

    workerOptions.onRegistered?.({ controllerId: 'container-1', initializing: true });
    workerOptions.onWorkloadBatchComplete?.({
      phase: 'init',
      itemCount: 1,
      status: 'cancelled',
      cancelled: true,
      failedCount: 0,
    });

    expect(context.connect).toHaveBeenCalledTimes(1);

    // 重连重放后的真实 init 完成才建立标准连接
    workerOptions.onWorkloadBatchComplete?.({
      phase: 'init',
      itemCount: 1,
      status: 'completed',
      cancelled: false,
      failedCount: 0,
    });
    expect(context.connect).toHaveBeenCalledTimes(2);
  });

  it('T-AG4c: connects after the init wait timeout', async () => {
    const context = setup({ env: { ...BASE_ENV, HARNESS_INIT_WAIT_MS: '20' } });
    await startCloudHostSupervisor(context.deps);
    const workerOptions = context.connect.mock.calls[0][2] as ConnectToServerOptions;

    workerOptions.onRegistered?.({ controllerId: 'container-1', initializing: true });
    expect(context.connect).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => {
      expect(context.connect).toHaveBeenCalledTimes(2);
    });

    // 超时后迟到的 initializing registered 不得再次进入等待（不产生幽灵定时器/重复连接）
    workerOptions.onRegistered?.({ controllerId: 'container-1', initializing: true });
    expect(context.connect).toHaveBeenCalledTimes(2);
    expect(context.logs.join('\n')).toContain('timed out');
  });

  it('T-AG4d: connects immediately when the init batch finished before registered', async () => {
    const context = setup();
    await startCloudHostSupervisor(context.deps);
    const workerOptions = context.connect.mock.calls[0][2] as ConnectToServerOptions;

    workerOptions.onWorkloadBatchComplete?.({ phase: 'init', itemCount: 1, status: 'completed' });
    expect(context.connect).toHaveBeenCalledTimes(1);

    workerOptions.onRegistered?.({ controllerId: 'container-1', initializing: true });
    expect(context.connect).toHaveBeenCalledTimes(2);
  });

  it('T-AG17: shutdown from either side closes both sockets and exits 0 without unregister', async () => {
    const context = setup();
    const handle = await startCloudHostSupervisor(context.deps);
    const workerOptions = context.connect.mock.calls[0][2] as ConnectToServerOptions;
    workerOptions.onRegistered?.({ controllerId: 'container-1', initializing: false });
    const controllerOptions = context.connect.mock.calls[1][2] as ConnectToServerOptions;

    workerOptions.onShutdown?.({ reason: '必须工作负载初始化失败' });

    expect(context.worker.disconnect).toHaveBeenCalled();
    expect(context.controller.disconnect).toHaveBeenCalled();
    expect(context.exit).toHaveBeenCalledWith(0);
    expect(context.worker.emit).not.toHaveBeenCalledWith('unregister', expect.anything());
    expect(context.controller.emit).not.toHaveBeenCalledWith('unregister', expect.anything());

    // 另一端 shutdown / 重复 shutdown 幂等
    controllerOptions.onShutdown?.({ reason: 'duplicate' });
    handle.shutdown('signal');
    expect(context.exit).toHaveBeenCalledTimes(1);
  });

  it('T-AG17b: worker shutdown before the controller connection only closes the worker', async () => {
    const context = setup();
    await startCloudHostSupervisor(context.deps);
    const workerOptions = context.connect.mock.calls[0][2] as ConnectToServerOptions;

    workerOptions.onShutdown?.({ reason: 'required init failed' });

    expect(context.worker.disconnect).toHaveBeenCalled();
    expect(context.controller.disconnect).not.toHaveBeenCalled();
    expect(context.exit).toHaveBeenCalledWith(0);
  });

  it('T-AG7b: rejects with a clear error instead of connecting when cloud-host env is incomplete', async () => {
    const context = setup({ env: { ...BASE_ENV, ZAG_HOST_KEY: '' } });

    await expect(startCloudHostSupervisor(context.deps)).rejects.toBeInstanceOf(CloudHostEnvError);
    expect(context.connect).not.toHaveBeenCalled();
    expect(context.exit).not.toHaveBeenCalled();
  });
});
