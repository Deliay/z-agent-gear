import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server as IOServer, type Socket as ServerSocket } from 'socket.io';
import { version as PACKAGE_VERSION } from '../package.json';

// 只测连接/事件层：屏蔽守护进程其余副作用（本地 MCP 回环服务、心跳定时器、~/.zag 配置写入）。
vi.mock('../src/mcp/local-server.js', () => ({
  LocalMcpServer: class {
    port = 0;
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
  },
}));

vi.mock('../src/heartbeat.js', () => ({
  Heartbeat: class {
    start = vi.fn();
    stop = vi.fn();
  },
}));

vi.mock('../src/config.js', () => ({
  clearConfigKey: vi.fn(),
  saveKeyToConfig: vi.fn(),
  saveEndpointToConfig: vi.fn(),
  getResumeTokenFromConfig: vi.fn(() => undefined),
  saveResumeTokenToConfig: vi.fn(),
  clearResumeTokenFromConfig: vi.fn(),
}));

import { connectToServer } from '../src/socketio-client.js';
import type { Socket } from 'socket.io-client';
import { createTestLogger, type TestLogger } from '../src/observability/testing.js';

interface Harness {
  port: number;
  upgradeResults: Array<Record<string, unknown>>;
  url: (path?: string) => string;
  emitUpgrade: (payload?: Record<string, unknown>) => void;
  emitShutdown: (payload: Record<string, unknown>) => void;
  emitUnregistered: () => void;
  close: () => Promise<void>;
}

const openSockets: Socket[] = [];

async function startServer(): Promise<Harness> {
  const httpServer: HttpServer = createServer();
  const ioServer = new IOServer(httpServer);
  const upgradeResults: Array<Record<string, unknown>> = [];
  const sockets: ServerSocket[] = [];

  const nsp = ioServer.of('/worker');
  nsp.on('connection', (socket: ServerSocket) => {
    sockets.push(socket);
    socket.on('register', () => {
      socket.emit('registered', { controllerId: 'test-container' });
    });
    socket.on('agent-gear:upgrade:result', (payload: Record<string, unknown>) => {
      upgradeResults.push(payload);
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  const port = address.port;

  const emitToAll = (event: string, payload?: Record<string, unknown>): void => {
    for (const socket of nsp.sockets.values()) {
      if (payload === undefined) socket.emit(event);
      else socket.emit(event, payload);
    }
  };

  return {
    port,
    upgradeResults,
    url: (path = '') => `http://127.0.0.1:${port}${path}`,
    emitUpgrade: (payload) => emitToAll('agent-gear:upgrade', payload ?? {}),
    emitShutdown: (payload) => emitToAll('shutdown', payload),
    emitUnregistered: () => emitToAll('unregistered'),
    close: async () => {
      for (const socket of sockets.splice(0)) socket.disconnect(true);
      await ioServer.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

async function connectWorker(
  harness: Harness,
  options: {
    onShutdown?: (payload: { reason: string; exitCode?: number }) => void;
    logger?: TestLogger;
  } = {},
): Promise<Socket> {
  const socket = connectToServer(harness.url('/worker?token=once-token'), 'controller-key', {
    serverName: 'test-worker',
    handshakeToken: 'once-token',
    skipLocalMcpStart: true,
    handleWorkload: false,
    persistConfig: false,
    ...(options.onShutdown ? { onShutdown: options.onShutdown } : {}),
    ...(options.logger ? { logger: options.logger.logger } : {}),
  });
  openSockets.push(socket);

  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', (err) => reject(err));
    setTimeout(() => reject(new Error('connect timeout')), 3000);
  });

  // 等待 register/registered 完成，避免心跳等接线与断言交错（heartbeat 已 mock）。
  await vi.waitFor(() => {
    expect(socket.connected).toBe(true);
  });
  return socket;
}

function spyProcessExit(): number[] {
  const calls: number[] = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    calls.push(code ?? 0);
  }) as never);
  return calls;
}

afterEach(() => {
  for (const socket of openSockets.splice(0)) socket.close();
  vi.restoreAllMocks();
});

describe('agent-gear:upgrade 事件（AGU，契约 §2.11/§2.12）', () => {
  it('T-AGU1: 回执 accepted:true + currentVersion，随后 onShutdown 以 exitCode:0 调用', async () => {
    const harness = await startServer();
    const onShutdown = vi.fn();
    const testLog = createTestLogger('socketio-client');
    try {
      await connectWorker(harness, { onShutdown, logger: testLog });

      harness.emitUpgrade({ targetVersion: '2.21.0' });

      await vi.waitFor(() => expect(harness.upgradeResults).toHaveLength(1), { timeout: 3000 });
      expect(harness.upgradeResults[0]).toEqual({
        accepted: true,
        currentVersion: PACKAGE_VERSION,
      });

      await vi.waitFor(
        () => expect(onShutdown).toHaveBeenCalledWith({ reason: 'agent-gear upgrade', exitCode: 0 }),
        { timeout: 3000 },
      );

      // 日志：agent_gear_upgrade 仅含 targetVersion/currentVersion/accepted，无凭据
      const upgradeLog = testLog.records.find((record) => record.event === 'agent_gear_upgrade');
      expect(upgradeLog).toBeDefined();
      expect(upgradeLog).toEqual(
        expect.objectContaining({
          event: 'agent_gear_upgrade',
          targetVersion: '2.21.0',
          currentVersion: PACKAGE_VERSION,
          accepted: true,
        }),
      );
      expect(upgradeLog).not.toHaveProperty('token');
      expect(upgradeLog).not.toHaveProperty('key');
    } finally {
      await harness.close();
    }
  });

  it('T-AGU2: 回执先到达服务端，停机存在延迟窗口（D5 ack flush）', async () => {
    const harness = await startServer();
    const onShutdown = vi.fn();
    try {
      await connectWorker(harness, { onShutdown });

      const emittedAt = Date.now();
      harness.emitUpgrade({ targetVersion: '2.21.0' });

      await vi.waitFor(() => expect(harness.upgradeResults).toHaveLength(1), { timeout: 3000 });
      // 回执到达时尚未停机（ack 先于优雅退出）
      expect(onShutdown).not.toHaveBeenCalled();

      await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledTimes(1), { timeout: 3000 });
      // 自事件发出起至少经过一个 ~100ms 的延迟窗口（含 emit/传输开销）。
      expect(Date.now() - emittedAt).toBeGreaterThanOrEqual(90);
    } finally {
      await harness.close();
    }
  });

  it('T-AGU3: 幂等守卫——重复事件回执 shutting_down 且不重复停机', async () => {
    const harness = await startServer();
    const onShutdown = vi.fn();
    try {
      await connectWorker(harness, { onShutdown });

      harness.emitUpgrade({ targetVersion: '2.21.0' });
      await vi.waitFor(() => expect(harness.upgradeResults).toHaveLength(1), { timeout: 3000 });

      // 首次已接受（延迟窗口内）再次收到升级事件：拒绝且不重复停机
      harness.emitUpgrade({ targetVersion: '2.21.0' });
      await vi.waitFor(() => expect(harness.upgradeResults).toHaveLength(2), { timeout: 3000 });
      expect(harness.upgradeResults[1]).toEqual({ accepted: false, reason: 'shutting_down' });

      await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledTimes(1), { timeout: 3000 });
      expect(onShutdown).toHaveBeenCalledWith({ reason: 'agent-gear upgrade', exitCode: 0 });
    } finally {
      await harness.close();
    }
  });

  it('T-AGU3b: 已进入 shutdown 流程时升级事件回执 shutting_down', async () => {
    const harness = await startServer();
    const onShutdown = vi.fn();
    try {
      await connectWorker(harness, { onShutdown });

      harness.emitShutdown({ reason: 'SIGTERM' });
      await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledTimes(1), { timeout: 3000 });

      harness.emitUpgrade({ targetVersion: '2.21.0' });
      await vi.waitFor(() => expect(harness.upgradeResults).toHaveLength(1), { timeout: 3000 });
      expect(harness.upgradeResults[0]).toEqual({ accepted: false, reason: 'shutting_down' });
      expect(onShutdown).toHaveBeenCalledTimes(1);
    } finally {
      await harness.close();
    }
  });

  it('T-AGU4: 本地模式（无 onShutdown）监听注册零差异，既有 shutdown 语义不变', async () => {
    const harness = await startServer();
    const exitCodes = spyProcessExit();
    try {
      const socket = await connectWorker(harness);

      // 云电脑/本地同注册（无 onShutdown 时事件永不到达，仅为死路径）
      expect(socket.listeners('agent-gear:upgrade')).toHaveLength(1);
      expect(socket.listeners('shutdown')).toHaveLength(1);
      expect(socket.listeners('unregistered')).toHaveLength(1);
      expect(socket.listeners('error')).toHaveLength(1);

      // 既有本地事件族零回归：信号 shutdown → 退出 0（入口保活重启）
      harness.emitShutdown({ reason: 'SIGTERM' });
      await vi.waitFor(() => expect(exitCodes).toEqual([0]), { timeout: 3000 });
    } finally {
      await harness.close();
    }
  });

  it('T-AGU4b: 本地模式升级死路径 process.exit(0)，不依赖 onShutdown', async () => {
    const harness = await startServer();
    const exitCodes = spyProcessExit();
    try {
      await connectWorker(harness);

      harness.emitUpgrade({ targetVersion: '2.21.0' });
      await vi.waitFor(() => expect(harness.upgradeResults).toHaveLength(1), { timeout: 3000 });
      expect(harness.upgradeResults[0]).toEqual({
        accepted: true,
        currentVersion: PACKAGE_VERSION,
      });

      await vi.waitFor(() => expect(exitCodes).toEqual([0]), { timeout: 3000 });
    } finally {
      await harness.close();
    }
  });

  it('T-AGU4c: 本地模式 unregistered 既有语义仍为 42（零回归）', async () => {
    const harness = await startServer();
    const exitCodes = spyProcessExit();
    try {
      await connectWorker(harness);

      harness.emitUnregistered();
      await vi.waitFor(() => expect(exitCodes).toEqual([42]), { timeout: 3000 });
    } finally {
      await harness.close();
    }
  });
});
