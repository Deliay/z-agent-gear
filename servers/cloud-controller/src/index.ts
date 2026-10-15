import { createServer, type Server as HttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { Server as SocketIOServer } from 'socket.io';
import { assertRuntimeConfig, config } from './config/index.js';
import { MongoContainerRepository } from './repositories/container-repository.js';
import { TokenService } from './services/token-service.js';
import { createK8sClient } from './services/k8s-client.js';
import { K8sJobManager } from './services/k8s-job-manager.js';
import { ContainerService } from './services/container-service.js';
import { StatusSyncService } from './services/status-sync.js';
import { HeartbeatTracker } from './services/heartbeat-tracker.js';
import { ENGINE_PATH, registerWorkerGateway } from './services/socketio-gateway.js';
import { internalAuth } from './middleware/internal-auth.js';
import { createInternalRouter } from './routes/internal-api.js';

export interface CloudControllerApp {
  app: express.Express;
  httpServer: HttpServer;
  io: SocketIOServer;
  statusSync: StatusSyncService;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export function createCloudControllerApp(): CloudControllerApp {
  assertRuntimeConfig(config);

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer, {
    // 显式声明 engine path：`/worker` 是 namespace 而非 URL 路径，握手实际落在 `/socket.io/`。
    // Ingress/反向代理必须放行 `ENGINE_PATH`（问题 46）。
    path: ENGINE_PATH,
    cors: { origin: '*' },
    transports: ['websocket'],
  });

  const repo = new MongoContainerRepository();
  const tokenService = new TokenService(repo);
  const k8sClient = createK8sClient(config);
  const jobManager = new K8sJobManager(k8sClient, {
    namespace: config.k8sNamespace,
    image: config.workerImage,
    runtimeClassName: config.runtimeClassName,
    publicWsEndpoint: config.publicWsEndpoint,
  });
  const containerService = new ContainerService(repo, tokenService, jobManager, {
    namespace: config.k8sNamespace,
    image: config.workerImage,
    connectTimeoutMs: config.connectTimeoutMs,
    shutdownGraceMs: 10000,
  });
  const heartbeatTracker = new HeartbeatTracker();
  const statusSync = new StatusSyncService({
    repo,
    k8sClient,
    containerService,
    heartbeatTracker,
    connectTimeoutMs: config.connectTimeoutMs,
    image: config.workerImage,
  });

  registerWorkerGateway(io, { tokenService, containerService, heartbeatTracker });

  app.use(
    '/internal',
    internalAuth(config.internalApiToken),
    createInternalRouter(containerService),
  );

  let started = false;

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    await mongoose.connect(config.mongodbUri);
    await statusSync.start();
    await new Promise<void>((resolve) => {
      httpServer.listen(config.port, resolve);
    });
    console.log(`cloud-controller listening on :${config.port}`);
  }

  async function stop(): Promise<void> {
    statusSync.stop();
    io.close();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    await mongoose.disconnect();
  }

  return { app, httpServer, io, statusSync, start, stop };
}

const isMain =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const application = createCloudControllerApp();

  const shutdown = async (): Promise<void> => {
    console.log('Shutting down cloud-controller...');
    try {
      await application.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  application.start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
