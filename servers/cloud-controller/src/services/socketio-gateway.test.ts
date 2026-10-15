import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { ContainerService } from './container-service.js';
import { HeartbeatTracker } from './heartbeat-tracker.js';
import { InMemoryK8sClient } from './k8s-client.js';
import { K8sJobManager } from './k8s-job-manager.js';
import { StatusSyncService } from './status-sync.js';
import { TokenService } from './token-service.js';
import { ENGINE_PATH, registerWorkerGateway } from './socketio-gateway.js';
import { InMemoryContainerRepository } from '../repositories/container-repository.js';

let httpServer: HttpServer;
let io: SocketIOServer;
let baseUrl: string;
let repo: InMemoryContainerRepository;
let client: InMemoryK8sClient;
let tokenService: TokenService;
let service: ContainerService;
let heartbeatTracker: HeartbeatTracker;
let statusSync: StatusSyncService;

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

async function newContainer() {
  const container = await repo.create({
    name: `zag-worker-${Math.random().toString(36).slice(2, 8)}`,
    namespace: 'zag-workers',
    purpose: 'idle',
    image: 'zero-tools/zag-worker:latest',
    status: 'connecting',
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
  registerWorkerGateway(io, { tokenService, containerService: service, heartbeatTracker });
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
    socket.emit('register', { hostname: 'worker-legacy', version: '2.0.0' });
    await waitFor(socket, 'registered');
    expect((await repo.findById(container.id))?.status).toBe('online');
    socket.close();
  });

  it('T-G2: valid handshake + register → registered, online with connectedAt', async () => {
    const { container, token } = await newContainer();
    const socket = await connectWith(token);

    socket.emit('register', { hostname: 'worker-1', version: '2.1.0', platform: 'linux' });
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
      version: '2.0.5',
      platform: 'linux',
    });
    await waitFor(socket, 'registered');

    expect((await repo.findById(container.id))?.status).toBe('online');
    socket.close();
  });

  it('T-G4: destroy emits shutdown to the connected worker', async () => {
    const { container, token } = await newContainer();
    const socket = await connectWith(token);
    socket.emit('register', { hostname: 'worker-3', version: '2.0.0' });
    await waitFor(socket, 'registered');

    const shutdown = waitFor<{ reason: string }>(socket, 'shutdown');
    await service.destroy(container.id);
    expect((await shutdown).reason).toBe('强制销毁');

    socket.close();
  });

  it('T-G5: three missed heartbeats mark the worker offline (connecting)', async () => {
    const { container, token } = await newContainer();
    const socket = await connectWith(token);
    socket.emit('register', { hostname: 'worker-4', version: '2.0.0' });
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
    socket.emit('register', { version: '2.0.0' });
    const error = await errorPromise;

    expect(error.code).toBe('INVALID_PAYLOAD');
    expect((await repo.findById(container.id))?.status).toBe('connecting');
    socket.close();
  });

  it('T-G7: same container with two sockets stays online until the last disconnects', async () => {
    const { container, token } = await newContainer();
    const first = await connectWith(token);
    first.emit('register', { hostname: 'worker-a', version: '2.0.0' });
    await waitFor(first, 'registered');

    const second = await connectWith(token);
    second.emit('register', { hostname: 'worker-b', version: '2.0.0' });
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
});
