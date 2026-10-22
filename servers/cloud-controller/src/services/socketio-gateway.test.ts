import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { ContainerService } from './container-service.js';
import { HeartbeatTracker } from './heartbeat-tracker.js';
import { InMemoryK8sClient } from './k8s-client.js';
import { K8sJobManager } from './k8s-job-manager.js';
import { StatusSyncService } from './status-sync.js';
import { TokenService } from './token-service.js';
import { ENGINE_PATH, registerWorkerGateway, SlidingWindowRateLimiter, containerIdFromToken } from './socketio-gateway.js';
import { WorkloadDispatcher } from './workload-dispatcher.js';
import { SecretStore } from './secret-store.js';
import { InMemoryContainerRepository } from '../repositories/container-repository.js';
import { InMemoryWorkloadRepository, type CloudWorkloadEntity } from '../repositories/workload-repository.js';
import { InMemoryWorkloadLogRepository } from '../repositories/workload-log-repository.js';

/** 兼容版本基线：版本门禁上线后，存量注册用例统一使用该版本。 */
const OK_VERSION = '2.2.0';

let httpServer: HttpServer;
let io: SocketIOServer;
let baseUrl: string;
let repo: InMemoryContainerRepository;
let client: InMemoryK8sClient;
let tokenService: TokenService;
let service: ContainerService;
let heartbeatTracker: HeartbeatTracker;
let statusSync: StatusSyncService;
let workloadRepository: InMemoryWorkloadRepository;
let workloadLogRepository: InMemoryWorkloadLogRepository;
let dispatcher: WorkloadDispatcher;
let secretStore: SecretStore;

function mkWorkload(
  id: string,
  name: string,
  opts: { initScript?: string | null; postScript?: string | null } = {},
): CloudWorkloadEntity {
  return {
    id,
    name,
    initScript: opts.initScript ?? null,
    postScript: opts.postScript ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function waitFor<T = unknown>(socket: ClientSocket, event: string, timeout = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function connectWith(token?: string): Promise<ClientSocket> {
  const socket = ioClient(`${baseUrl}/worker`, {
    auth: token ? { token } : {},
    transports: ['websocket'],
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timeout')), 3000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return socket;
}

async function connectError(token?: string): Promise<string> {
  const socket = ioClient(`${baseUrl}/worker`, {
    auth: token ? { token } : {},
    transports: ['websocket'],
    reconnection: false,
  });
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect_error timeout')), 3000);
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      const message = err.message;
      socket.close();
      resolve(message);
    });
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.close();
      reject(new Error('unexpected connect'));
    });
  });
}

async function newContainer(
  workloadIds: string[] = [],
  overrides: {
    purpose?: 'idle' | 'harness';
    status?: 'creating' | 'connecting';
    workloadPlan?: Array<{
      workloadId: string;
      params: Record<string, unknown>;
      implicit: boolean;
      required: boolean;
    }>;
    hostId?: string;
    userId?: string;
    harnessTypes?: string[];
    agentGearMinVersion?: string;
  } = {},
) {
  const purpose = overrides.purpose ?? 'idle';
  const container = await repo.create({
    name: `zag-worker-${Math.random().toString(36).slice(2, 8)}`,
    namespace: 'zag-workers',
    purpose,
    image: 'zero-tools/zag-worker:latest',
    status: overrides.status ?? 'connecting',
    workloadIds,
    workloadPlan: overrides.workloadPlan ?? [],
    hostId: overrides.hostId ?? null,
    userId: overrides.userId ?? null,
    harnessTypes: overrides.harnessTypes ?? (purpose === 'harness' ? ['opencode'] : []),
    agentGearMinVersion: overrides.agentGearMinVersion ?? null,
  });
  const token = await tokenService.issue(container.id);
  return { container, token };
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeout = 2000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition not met in time');
}

beforeAll(async () => {
  repo = new InMemoryContainerRepository();
  client = new InMemoryK8sClient();
  tokenService = new TokenService(repo);
  const jobManager = new K8sJobManager(client, {
    namespace: 'zag-workers',
    image: 'zero-tools/zag-worker:latest',
    runtimeClassName: 'sysbox-runc',
    publicWsEndpoint: 'cloud.example.com:4003',
  });
  service = new ContainerService(repo, tokenService, jobManager, {
    namespace: 'zag-workers',
    image: 'zero-tools/zag-worker:latest',
    connectTimeoutMs: 300000,
    shutdownGraceMs: 0,
  });
  heartbeatTracker = new HeartbeatTracker();
  statusSync = new StatusSyncService({
    repo,
    k8sClient: client,
    containerService: service,
    heartbeatTracker,
    connectTimeoutMs: 300000,
    image: 'zero-tools/zag-worker:latest',
    reconnectDelayMs: 0,
  });

  // 非 Socket.IO 路径返回 404，模拟 index.ts 中 express 的兜底行为（用于锚定 engine path）。
  httpServer = createServer((_req, res) => {
    res.statusCode = 404;
    res.end('Not Found');
  });
  // 与 index.ts 保持一致：显式 ENGINE_PATH + 强制 websocket 传输（建议 H）。
  // T-G10 通过「engine path 上 polling 被拒(400) vs /worker 路径不存在(404)」锚定路径。
  io = new SocketIOServer(httpServer, { path: ENGINE_PATH, transports: ['websocket'] });

  workloadRepository = new InMemoryWorkloadRepository();
  workloadLogRepository = new InMemoryWorkloadLogRepository();
  secretStore = new SecretStore();
  const gatewayBridge: {
    emitToContainer: (containerId: string, event: string, payload: unknown) => void;
    isConnected: (containerId: string) => boolean;
  } = { emitToContainer: () => {}, isConnected: () => false };
  dispatcher = new WorkloadDispatcher({
    containerRepository: repo,
    containerService: service,
    workloadRepository,
    workloadLogRepository,
    emitToContainer: (containerId, event, payload) =>
      gatewayBridge.emitToContainer(containerId, event, payload),
    isConnected: (containerId) => gatewayBridge.isConnected(containerId),
    initTimeoutMs: 1000,
    postBudgetMs: 5000,
    logMaxBytes: 262144,
    forceDestroy: async () => {},
    secretStore,
  });

  const gateway = registerWorkerGateway(io, {
    tokenService,
    containerService: service,
    heartbeatTracker,
    workloadDispatcher: dispatcher,
  });
  gatewayBridge.emitToContainer = gateway.emitToContainer;
  gatewayBridge.isConnected = gateway.isConnected;

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe('worker Socket.IO gateway', () => {
  it('T-G1: missing / forged / destroyed token handshakes are rejected with INVALID_TOKEN', async () => {
    expect(await connectError()).toBe('INVALID_TOKEN');
    expect(await connectError('not-a-real-token')).toBe('INVALID_TOKEN');

    const { container, token } = await newContainer();
    await service.destroy(container.id); // 终态 → token 作废
    expect(await connectError(token)).toBe('INVALID_TOKEN');
  });

  it('T-G9: legacy query token is still accepted (handshake auth preferred)', async () => {
    const { container, token } = await newContainer();
    const socket = ioClient(`${baseUrl}/worker`, {
      query: { token },
      transports: ['websocket'],
      reconnection: false,
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connect timeout')), 3000);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    socket.emit('register', { hostname: 'worker-legacy', version: OK_VERSION });
    await waitFor(socket, 'registered');
    expect((await repo.findById(container.id))?.status).toBe('online');
    socket.close();
  });

  it('T-G2: valid handshake + register → registered, online with connectedAt', async () => {
    const { container, token } = await newContainer();
    const socket = await connectWith(token);

    socket.emit('register', { hostname: 'worker-1', version: OK_VERSION, platform: 'linux' });
    const registered = await waitFor<{ controllerId: string }>(socket, 'registered');
    expect(registered.controllerId).toBe(container.id);

    const stored = await repo.findById(container.id);
    expect(stored?.status).toBe('online');
    expect(stored?.connectedAt).toBeInstanceOf(Date);

    socket.close();
  });

  it('T-G3: register payload carrying key is ignored (protocol compatibility)', async () => {
    const { container, token } = await newContainer();
    const socket = await connectWith(token);

    socket.emit('register', {
      key: 'legacy-controller-key',
      hostname: 'worker-2',
      version: OK_VERSION,
      platform: 'linux',
    });
    await waitFor(socket, 'registered');

    expect((await repo.findById(container.id))?.status).toBe('online');
    socket.close();
  });

  it('T-G4: destroy emits shutdown to the connected worker', async () => {
    const { container, token } = await newContainer();
    const socket = await connectWith(token);
    socket.emit('register', { hostname: 'worker-3', version: OK_VERSION });
    await waitFor(socket, 'registered');

    const shutdown = waitFor<{ reason: string }>(socket, 'shutdown');
    await service.destroy(container.id);
    expect((await shutdown).reason).toBe('强制销毁');

    socket.close();
  });

  it('R2-20: destroy(reason) forwards the real reason in the shutdown event', async () => {
    const { container, token } = await newContainer();
    const socket = await connectWith(token);
    socket.emit('register', { hostname: 'worker-r2-20', version: OK_VERSION });
    await waitFor(socket, 'registered');

    const shutdown = waitFor<{ reason: string }>(socket, 'shutdown');
    await service.destroy(container.id, { reason: '必须工作负载「opencode」初始化失败' });
    expect((await shutdown).reason).toBe('必须工作负载「opencode」初始化失败');

    socket.close();
  });

  it('T-G5: three missed heartbeats mark the worker offline (connecting)', async () => {
    const { container, token } = await newContainer();
    const socket = await connectWith(token);
    socket.emit('register', { hostname: 'worker-4', version: OK_VERSION });
    await waitFor(socket, 'registered');

    const now = Date.now();
    expect(await statusSync.scanHeartbeats(now)).toEqual([]);
    expect(await statusSync.scanHeartbeats(now + 3 * heartbeatTracker.interval + 1)).toEqual([
      container.id,
    ]);
    expect((await repo.findById(container.id))?.status).toBe('connecting');

    socket.close();
  });

  it('T-G6: register without hostname is rejected with INVALID_PAYLOAD', async () => {
    const { container, token } = await newContainer();
    const socket = await connectWith(token);

    const errorPromise = waitFor<{ code: string }>(socket, 'error');
    socket.emit('register', { version: OK_VERSION });
    const error = await errorPromise;

    expect(error.code).toBe('INVALID_PAYLOAD');
    expect((await repo.findById(container.id))?.status).toBe('connecting');
    socket.close();
  });

  it('T-GV1: register 2.1.0 → VERSION_MISMATCH（当前/最低/major）并断开', async () => {
    const { container, token } = await newContainer();
    const socket = await connectWith(token);
    const disconnected = new Promise<void>((resolve) => {
      socket.once('disconnect', () => resolve());
    });

    const errorPromise = waitFor<Record<string, unknown>>(socket, 'error');
    socket.emit('register', { hostname: 'worker-old', version: '2.1.0' });
    const error = await errorPromise;

    expect(error.code).toBe('VERSION_MISMATCH');
    expect(error.currentVersion).toBe('2.1.0');
    expect(error.minimumVersion).toBe('2.2.0');
    expect(error.supportedMajor).toBe(2);
    expect(String(error.message)).toContain('2.1.0');
    expect(String(error.message)).toContain('2.2.0');

    await disconnected;
    const stored = await repo.findById(container.id);
    expect(stored?.status).toBe('connecting');
    expect(stored?.connectedAt).toBeNull();
  });

  it('T-GV2: 版本拒绝零副作用（心跳/在线/初始化/注册标记均不生效）', async () => {
    const markOnline = vi.spyOn(service, 'markOnline');
    const markInitializing = vi.spyOn(service, 'markInitializing');
    const hasInitScripts = vi.spyOn(dispatcher, 'hasInitScripts');
    const startInit = vi.spyOn(dispatcher, 'startInit');
    const record = vi.spyOn(heartbeatTracker, 'record');
    const serverSockets: Socket[] = [];
    const onConnection = (serverSocket: Socket): void => {
      serverSockets.push(serverSocket);
    };
    io.of('/worker').on('connection', onConnection);

    try {
      const { container, token } = await newContainer();
      const socket = await connectWith(token);
      const disconnected = new Promise<void>((resolve) => {
        socket.once('disconnect', () => resolve());
      });
      const errorPromise = waitFor<Record<string, unknown>>(socket, 'error');
      socket.emit('register', { hostname: 'worker-old', version: '2.1.0' });
      await errorPromise;
      await disconnected;

      expect(markOnline).not.toHaveBeenCalled();
      expect(markInitializing).not.toHaveBeenCalled();
      expect(hasInitScripts).not.toHaveBeenCalled();
      expect(startInit).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(serverSockets).toHaveLength(1);
      expect(serverSockets[0]!.data.registered).not.toBe(true);

      const stored = await repo.findById(container.id);
      expect(stored?.status).toBe('connecting');
      expect(stored?.connectedAt).toBeNull();
    } finally {
      io.of('/worker').off('connection', onConnection);
      vi.restoreAllMocks();
    }
  });

  it('T-GV3: 2.2.0 / 2.10.0 直接注册成功（回归）', async () => {
    for (const version of ['2.2.0', '2.10.0']) {
      const { container, token } = await newContainer();
      const socket = await connectWith(token);
      socket.emit('register', { hostname: `worker-${version}`, version });
      const registered = await waitFor<{ controllerId: string }>(socket, 'registered');
      expect(registered.controllerId).toBe(container.id);
      expect((await repo.findById(container.id))?.status).toBe('online');
      socket.close();
    }
  });

  it('T-GV4: 版本缺失 / 非法 / 错误 major 均拒绝，currentVersion 为原始值或 unknown', async () => {
    const cases: Array<{ payload: Record<string, unknown>; currentVersion: string }> = [
      { payload: { hostname: 'worker-missing' }, currentVersion: 'unknown' },
      { payload: { hostname: 'worker-bad', version: 'x.y.z' }, currentVersion: 'x.y.z' },
      { payload: { hostname: 'worker-future', version: '3.0.0' }, currentVersion: '3.0.0' },
      { payload: { hostname: 'worker-number', version: 220 }, currentVersion: 'unknown' },
    ];

    for (const { payload, currentVersion } of cases) {
      const { container, token } = await newContainer();
      const socket = await connectWith(token);
      const disconnected = new Promise<void>((resolve) => {
        socket.once('disconnect', () => resolve());
      });
      const errorPromise = waitFor<Record<string, unknown>>(socket, 'error');
      socket.emit('register', payload);
      const error = await errorPromise;

      expect(error.code).toBe('VERSION_MISMATCH');
      expect(error.currentVersion).toBe(currentVersion);
      expect(error.minimumVersion).toBe('2.2.0');
      expect(error.supportedMajor).toBe(2);
      await disconnected;
      expect((await repo.findById(container.id))?.connectedAt).toBeNull();
    }
  });

  it('T-GV5: 拒绝后的断开不改变容器状态（不 markConnecting）', async () => {
    const markConnecting = vi.spyOn(service, 'markConnecting');
    try {
      const { container, token } = await newContainer();
      const socket = await connectWith(token);
      const disconnected = new Promise<void>((resolve) => {
        socket.once('disconnect', () => resolve());
      });
      const errorPromise = waitFor<Record<string, unknown>>(socket, 'error');
      socket.emit('register', { hostname: 'worker-old', version: '2.1.0' });
      await errorPromise;
      await disconnected;
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(markConnecting).not.toHaveBeenCalled();
      expect((await repo.findById(container.id))?.status).toBe('connecting');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('T-G7: same container with two sockets stays online until the last disconnects', async () => {
    const { container, token } = await newContainer();
    const first = await connectWith(token);
    first.emit('register', { hostname: 'worker-a', version: OK_VERSION });
    await waitFor(first, 'registered');

    const second = await connectWith(token);
    second.emit('register', { hostname: 'worker-b', version: OK_VERSION });
    await waitFor(second, 'registered');

    first.close();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await repo.findById(container.id))?.status).toBe('online');
    expect(heartbeatTracker.has(container.id)).toBe(true);

    second.close();
    await waitForCondition(async () => (await repo.findById(container.id))?.status === 'connecting');
    expect(heartbeatTracker.has(container.id)).toBe(false);
  });

  it('T-G8: handshake attempts from one source IP are rate limited', async () => {
    const rateRepo = new InMemoryContainerRepository();
    const rateToken = new TokenService(rateRepo);
    const rateClient = new InMemoryK8sClient();
    const rateJobManager = new K8sJobManager(rateClient, {
      namespace: 'zag-workers',
      image: 'zero-tools/zag-worker:latest',
      publicWsEndpoint: 'cloud.example.com:4003',
    });
    const rateService = new ContainerService(rateRepo, rateToken, rateJobManager, {
      namespace: 'zag-workers',
      image: 'zero-tools/zag-worker:latest',
      connectTimeoutMs: 300000,
      shutdownGraceMs: 0,
    });

    const rateServer = createServer();
    const rateIo = new SocketIOServer(rateServer, { transports: ['websocket'] });
    registerWorkerGateway(rateIo, {
      tokenService: rateToken,
      containerService: rateService,
      heartbeatTracker: new HeartbeatTracker(),
      handshakeRateLimit: { windowMs: 60000, max: 2 },
    });
    await new Promise<void>((resolve) => rateServer.listen(0, resolve));
    const port = (rateServer.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}`;

    const attempt = (token?: string): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        const socket = ioClient(`${url}/worker`, {
          auth: token ? { token } : {},
          transports: ['websocket'],
          reconnection: false,
          forceNew: true,
        });
        const timer = setTimeout(() => reject(new Error('connect timeout')), 3000);
        socket.once('connect_error', (err) => {
          clearTimeout(timer);
          const message = err.message;
          socket.close();
          resolve(message);
        });
        socket.once('connect', () => {
          clearTimeout(timer);
          socket.close();
          resolve('CONNECTED');
        });
      });

    try {
      expect(await attempt()).toBe('INVALID_TOKEN');
      expect(await attempt()).toBe('INVALID_TOKEN');
      expect(await attempt()).toBe('RATE_LIMITED');
    } finally {
      rateIo.close();
      await new Promise<void>((resolve) => rateServer.close(() => resolve()));
    }
  });

  it('T-G10: engine handshake lives at /socket.io/ — /worker is a namespace, not a URL path (问题 46)', async () => {
    // engine path 必须是 Socket.IO 默认 `/socket.io/`（与 index.ts 传入的 ENGINE_PATH 一致）。
    expect(ENGINE_PATH).toBe('/socket.io/');

    // 生产配置强制 websocket 传输：engine path 上发起 polling 握手会被引擎接管但拒绝（400），
    // 证明该 URL 路径确实由 Socket.IO 引擎处理（而非落到 express 的 404 兜底）。
    const wrongTransport = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling`);
    expect(wrongTransport.status).toBe(400);

    // `/worker` 只是命名空间，作为 URL 路径不存在 → 404（回归问题 46 的 Ingress 误配置即命中此处）。
    const wrongPath = await fetch(`${baseUrl}/worker?EIO=4&transport=polling`);
    expect(wrongPath.status).toBe(404);
  });

  it('T-G11: per-container rate limiting lets distinct containers reconnect from one shared Ingress IP (问题 59)', async () => {
    const rateRepo = new InMemoryContainerRepository();
    const rateToken = new TokenService(rateRepo);
    const rateClient = new InMemoryK8sClient();
    const rateJobManager = new K8sJobManager(rateClient, {
      namespace: 'zag-workers',
      image: 'zero-tools/zag-worker:latest',
      publicWsEndpoint: 'cloud.example.com:4003',
    });
    const rateService = new ContainerService(rateRepo, rateToken, rateJobManager, {
      namespace: 'zag-workers',
      image: 'zero-tools/zag-worker:latest',
      connectTimeoutMs: 300000,
      shutdownGraceMs: 0,
    });

    const rateServer = createServer();
    const rateIo = new SocketIOServer(rateServer, { transports: ['websocket'] });
    registerWorkerGateway(rateIo, {
      tokenService: rateToken,
      containerService: rateService,
      heartbeatTracker: new HeartbeatTracker(),
      // per-container 上限 2；per-IP 上限放宽（模拟共享 Ingress IP 下多容器重连）。
      handshakeRateLimit: { windowMs: 60000, max: 2, ipMax: 50 },
    });
    await new Promise<void>((resolve) => rateServer.listen(0, resolve));
    const port = (rateServer.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}`;

    const mintToken = async (): Promise<string> => {
      const container = await rateRepo.create({
        name: `zag-worker-${Math.random().toString(36).slice(2, 8)}`,
        namespace: 'zag-workers',
        purpose: 'idle',
        image: 'zero-tools/zag-worker:latest',
        status: 'connecting',
      });
      return rateToken.issue(container.id);
    };

    const attempt = (token: string): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        const socket = ioClient(`${url}/worker`, {
          auth: { token },
          transports: ['websocket'],
          reconnection: false,
          forceNew: true,
        });
        const timer = setTimeout(() => reject(new Error('connect timeout')), 3000);
        socket.once('connect_error', (err) => {
          clearTimeout(timer);
          const message = err.message;
          socket.close();
          resolve(message);
        });
        socket.once('connect', () => {
          clearTimeout(timer);
          socket.close();
          resolve('CONNECTED');
        });
      });

    try {
      // 同一 peer IP（Ingress 控制器）下的多个不同容器：各自独立计数，不应被限流。
      for (let i = 0; i < 5; i += 1) {
        expect(await attempt(await mintToken())).toBe('CONNECTED');
      }

      // 同一个容器重复握手超过 per-container 上限：被限流。
      const sameToken = await mintToken();
      expect(await attempt(sameToken)).toBe('CONNECTED');
      expect(await attempt(sameToken)).toBe('CONNECTED');
      expect(await attempt(sameToken)).toBe('RATE_LIMITED');
    } finally {
      rateIo.close();
      await new Promise<void>((resolve) => rateServer.close(() => resolve()));
    }
  });

  it('T-G12: SlidingWindowRateLimiter 在随机 key 洪水下 Map 有界（问题 60）', () => {
    const limiter = new SlidingWindowRateLimiter(60_000, 60, 100);
    const now = 1_700_000_000_000;

    // 1000 个唯一 key（模拟未认证对端用随机 token 前缀铸造限速键）
    for (let i = 0; i < 1000; i += 1) {
      limiter.allow(`container:flood-${i}`, now);
    }

    expect(limiter.size).toBeLessThanOrEqual(100);
  });

  it('T-G13: containerIdFromToken 仅接受合法形状前缀，否则回退（问题 60）', () => {
    expect(containerIdFromToken('507f1f77bcf86cd799439011.secret')).toBe('507f1f77bcf86cd799439011');
    expect(containerIdFromToken('c-1.a.b')).toBe('c-1');
    // 无分隔符 / 空前缀 / 非法字符 / 超长 → undefined（回退 IP 键）
    expect(containerIdFromToken('no-dot')).toBeUndefined();
    expect(containerIdFromToken('.secret')).toBeUndefined();
    expect(containerIdFromToken('bad prefix.secret')).toBeUndefined();
    expect(containerIdFromToken('bad/prefix.secret')).toBeUndefined();
    expect(containerIdFromToken(`${'a'.repeat(65)}.secret`)).toBeUndefined();
    expect(containerIdFromToken(undefined)).toBeUndefined();
  });

  it('T-WG1: register 挂载 init 脚本 → 下发 workload:run、置 initializing，结果回报后 online', async () => {
    workloadRepository.add(mkWorkload('gw-init', 'gw-init-script', { initScript: 'echo hi' }));
    const { container, token } = await newContainer(['gw-init']);
    const socket = await connectWith(token);

    const registered = waitFor(socket, 'registered');
    const runPromise = waitFor<{ phase: string; items: Array<{ logId: string; workloadName: string }> }>(
      socket,
      'workload:run',
    );
    socket.emit('register', { hostname: 'worker-init', version: OK_VERSION });
    await registered;

    const run = await runPromise;
    expect(run.phase).toBe('init');
    expect(run.items.map((item) => item.workloadName)).toEqual(['gw-init-script']);

    await waitForCondition(async () => (await repo.findById(container.id))?.status === 'initializing');
    expect((await repo.findById(container.id))?.currentWorkloadName).toBe('gw-init-script');

    socket.emit('workload:result', {
      logId: run.items[0]!.logId,
      status: 'success',
      exitCode: 0,
      log: 'hi',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    await waitForCondition(async () => (await repo.findById(container.id))?.status === 'online');
    expect((await repo.findById(container.id))?.currentWorkloadName).toBeNull();
    socket.close();
  });

  it('T-WG1b: 无 init 脚本容器 register → 直接 online 且不下发 workload:run（存量回归）', async () => {
    const { container, token } = await newContainer();
    const socket = await connectWith(token);
    let runReceived = false;
    socket.on('workload:run', () => {
      runReceived = true;
    });

    socket.emit('register', { hostname: 'worker-plain', version: OK_VERSION });
    await waitFor(socket, 'registered');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(runReceived).toBe(false);
    expect((await repo.findById(container.id))?.status).toBe('online');
    socket.close();
  });

  it('T-WG1c: 挂载项全部已删除 → 留档 FAILED 且容器仍 online', async () => {
    const { container, token } = await newContainer(['gw-missing']);
    const socket = await connectWith(token);

    socket.emit('register', { hostname: 'worker-deleted', version: OK_VERSION });
    await waitFor(socket, 'registered');
    await waitForCondition(async () => (await repo.findById(container.id))?.status === 'online');

    const logs = await workloadLogRepository.findByContainer(container.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.status).toBe('failed');
    expect(logs[0]!.log).toContain('已删除');
    socket.close();
  });

  it('T-WG2: 有 post 脚本的 destroy → 先 post 批次、收到结果后再 shutdown', async () => {
    workloadRepository.add(mkWorkload('gw-post', 'gw-post-script', { postScript: 'echo bye' }));
    const { container, token } = await newContainer(['gw-post']);
    const socket = await connectWith(token);

    const registered = waitFor(socket, 'registered');
    socket.emit('register', { hostname: 'worker-post', version: OK_VERSION });
    await registered;
    await waitForCondition(async () => (await repo.findById(container.id))?.status === 'online');

    const runPromise = waitFor<{ phase: string; items: Array<{ logId: string }> }>(
      socket,
      'workload:run',
    );
    const shutdownPromise = waitFor<{ reason: string }>(socket, 'shutdown');
    const destroyPromise = service.destroy(container.id);

    const run = await runPromise;
    expect(run.phase).toBe('post');

    let shutdownReceived = false;
    void shutdownPromise.then(() => {
      shutdownReceived = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(shutdownReceived).toBe(false);

    socket.emit('workload:result', {
      logId: run.items[0]!.logId,
      status: 'success',
      exitCode: 0,
      log: 'bye',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });

    const shutdown = await shutdownPromise;
    expect(shutdown.reason).toBe('强制销毁');
    await destroyPromise;
    expect((await repo.findById(container.id))?.status).toBe('exited');
    const postLog = (await workloadLogRepository.findByContainer(container.id)).find(
      (log) => log.phase === 'post',
    );
    expect(postLog?.status).toBe('success');
    socket.close();
  });

  it('T-G-REQ: 必须项执行前被删除 → register 不下发批次且不 markOnline（不进入 online）', async () => {
    const container = await repo.create({
      name: `zag-worker-${Math.random().toString(36).slice(2, 8)}`,
      namespace: 'zag-workers',
      purpose: 'idle',
      image: 'zero-tools/zag-worker:latest',
      status: 'connecting',
      workloadIds: ['gw-missing'],
      workloadPlan: [
        { workloadId: 'gw-missing', params: {}, implicit: false, required: true },
      ],
    });
    const token = await tokenService.issue(container.id);
    const socket = await connectWith(token);
    const runs: Array<{ phase: string }> = [];
    socket.on('workload:run', (payload: { phase: string }) => runs.push(payload));

    const registered = waitFor(socket, 'registered');
    socket.emit('register', { hostname: 'worker-req', version: OK_VERSION });
    await registered;

    // 等占位记录落库（说明 startInit 已执行完）
    await waitForCondition(
      async () => (await workloadLogRepository.findByContainer(container.id)).length > 0,
    );
    // 必须失败 → 不下发 workload:run，且未被 markOnline
    expect(runs).toHaveLength(0);
    expect((await repo.findById(container.id))?.status).toBe('connecting');
    socket.close();
  });

  it('T-CC9/T-CC10: harness 2.4.0 被拒（VERSION_MISMATCH 2.5.0）且无注册副作用', async () => {
    const { container, token } = await newContainer([], {
      purpose: 'harness',
      hostId: 'host-gate-1',
    });
    const socket = await connectWith(token);
    const errorPromise = waitFor<Record<string, unknown>>(socket, 'error');
    socket.emit('register', { hostname: 'harness-old', version: '2.4.0' });
    const error = await errorPromise;

    expect(error).toMatchObject({
      code: 'VERSION_MISMATCH',
      currentVersion: '2.4.0',
      minimumVersion: '2.5.0',
      supportedMajor: 2,
    });
    const stored = await repo.findById(container.id);
    expect(stored?.status).toBe('connecting');
    expect(stored?.connectedAt).toBeNull();
    expect(await workloadLogRepository.findByContainer(container.id)).toEqual([]);
    socket.close();
  });

  it('C-4: harness 注册门禁使用落库的 agentGearMinVersion（高于常量时生效）', async () => {
    const { container, token } = await newContainer([], {
      purpose: 'harness',
      hostId: 'host-gate-minver',
      agentGearMinVersion: '2.10.0',
    });
    const socket = await connectWith(token);
    const errorPromise = waitFor<Record<string, unknown>>(socket, 'error');
    socket.emit('register', { hostname: 'harness-minver', version: '2.9.0' });
    const error = await errorPromise;

    expect(error).toMatchObject({
      code: 'VERSION_MISMATCH',
      currentVersion: '2.9.0',
      minimumVersion: '2.10.0',
    });
    expect((await repo.findById(container.id))?.status).toBe('connecting');
    socket.close();
  });

  it('T-CC9/T-CC11: harness 2.5.0 通过，无 init 时 registered.initializing=false 且 online', async () => {
    const { container, token } = await newContainer([], {
      purpose: 'harness',
      hostId: 'host-gate-2',
    });
    const socket = await connectWith(token);
    const registered = waitFor<{ controllerId: string; initializing: boolean }>(
      socket,
      'registered',
    );
    socket.emit('register', { hostname: 'harness-new', version: '2.5.0' });
    const payload = await registered;

    expect(payload.controllerId).toBe(container.id);
    expect(payload.initializing).toBe(false);
    const stored = await repo.findById(container.id);
    expect(stored?.status).toBe('online');
    expect(stored?.connectedAt).toBeInstanceOf(Date);
    socket.close();
  });

  it('T-CC11/T-CC12: harness 有 init 时 registered.initializing=true，workload:run 携带 env', async () => {
    workloadRepository.add(mkWorkload('gw-harness', 'opencode', { initScript: 'echo init' }));
    const { container, token } = await newContainer(['gw-harness'], {
      purpose: 'harness',
      hostId: 'host-gate-3',
      userId: 'user-gate-1',
      workloadPlan: [
        { workloadId: 'gw-harness', params: {}, implicit: false, required: true },
      ],
    });
    secretStore.put(container.id, {
      hostEndpoint: 'wss://controller.example.com',
      hostKey: 'zag_k_1_gateway-secret',
      modelApiKey: 'zag_sk_gateway-secret',
      modelBaseUrl: 'http://admin-api:8002/v1',
      modelIds: '["model-a"]',
      defaultWorkspace: '/root/workspace',
    });
    const socket = await connectWith(token);
    const runPromise = waitFor<{ phase: string; env?: Record<string, string> }>(
      socket,
      'workload:run',
    );
    const registered = waitFor<{ initializing: boolean }>(socket, 'registered');
    socket.emit('register', { hostname: 'harness-init', version: '2.5.0' });

    expect((await registered).initializing).toBe(true);
    const run = await runPromise;
    expect(run.phase).toBe('init');
    expect(run.env).toMatchObject({
      ZAG_HARNESS_TYPES: 'opencode',
      ZAG_CONTAINER_ID: container.id,
      ZAG_HOST_ID: 'host-gate-3',
      ZAG_USER_ID: 'user-gate-1',
      ZAG_HOST_KEY: 'zag_k_1_gateway-secret',
      ZAG_MODEL_API_KEY: 'zag_sk_gateway-secret',
    });
    expect((await repo.findById(container.id))?.status).toBe('initializing');
    socket.close();
  });

  it('T-CC18: idle 仍接受 2.2.0（普通容器门禁未上调）', async () => {
    const { container, token } = await newContainer([], { purpose: 'idle' });
    const socket = await connectWith(token);
    const registered = waitFor<{ initializing: boolean }>(socket, 'registered');
    socket.emit('register', { hostname: 'idle-old', version: OK_VERSION });
    expect((await registered).initializing).toBe(false);
    expect((await repo.findById(container.id))?.status).toBe('online');
    socket.close();
  });
});
