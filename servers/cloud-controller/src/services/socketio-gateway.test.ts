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
import { registerWorkerGateway } from './socketio-gateway.js';
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

  httpServer = createServer();
  io = new SocketIOServer(httpServer, { transports: ['websocket'] });
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
});
