import { createServer, type Server as HttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { Server as SocketIOServer } from 'socket.io';
import { assertRuntimeConfig, config } from './config/index.js';
import { createLogger } from './logger.js';
import { MongoContainerRepository } from './repositories/container-repository.js';
import { MongoWorkloadRepository } from './repositories/workload-repository.js';
import { MongoWorkloadLogRepository } from './repositories/workload-log-repository.js';
import { TokenService } from './services/token-service.js';
import { createK8sClient } from './services/k8s-client.js';
import { K8sJobManager } from './services/k8s-job-manager.js';
import { ContainerService } from './services/container-service.js';
import { StatusSyncService } from './services/status-sync.js';
import { HeartbeatTracker } from './services/heartbeat-tracker.js';
import { ENGINE_PATH, registerWorkerGateway } from './services/socketio-gateway.js';
import { WorkloadDispatcher } from './services/workload-dispatcher.js';
import { wireSocketDiagnostics } from './services/socket-diagnostics.js';
import {
  BillingEventPublisher,
  RabbitMqTransport,
} from './services/billing-event-publisher.js';
import { BillingOutbox } from './models/billing-outbox.js';
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
  const logger = createLogger(config.logLevel);

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

  // 传输层诊断：记录每个 WS upgrade / engine 错误 / 误配路径（worker 经 Ingress 回连排查用）。
  wireSocketDiagnostics({ httpServer, io, logger, enginePath: ENGINE_PATH });

  const repo = new MongoContainerRepository();
  const workloadRepository = new MongoWorkloadRepository();
  const workloadLogRepository = new MongoWorkloadLogRepository();
  const tokenService = new TokenService(repo);
  const k8sClient = createK8sClient(config);
  const jobManager = new K8sJobManager(k8sClient, {
    namespace: config.k8sNamespace,
    image: config.workerImage,
    runtimeClassName: config.runtimeClassName,
    publicWsEndpoint: config.publicWsEndpoint,
  });
  const containerService = new ContainerService(
    repo,
    tokenService,
    jobManager,
    {
      namespace: config.k8sNamespace,
      image: config.workerImage,
      connectTimeoutMs: config.connectTimeoutMs,
      shutdownGraceMs: 10000,
    },
    logger,
    {
      // 计费生命周期事件：只写本地 outbox，relay 异步发布；失败仅告警、不阻断生命周期。
      onReady: async (container) => {
        if (!container.billingAccountId || !container.billingStartedAt) return;
        const startedAt = container.billingStartedAt.toISOString();
        await billingPublisher.enqueue({
          eventId: `container.ready:${container.id}`,
          eventType: 'container.ready',
          occurredAt: startedAt,
          accountId: container.billingAccountId,
          resourceId: container.id,
          payload: { billingStartedAt: startedAt },
        });
      },
      onDestroyed: async (container) => {
        if (!container.billingAccountId || !container.billingStartedAt) return;
        const startedAt = container.billingStartedAt.toISOString();
        const exitedAt = (container.exitedAt ?? new Date()).toISOString();
        await billingPublisher.enqueue({
          eventId: `container.destroyed:${container.id}`,
          eventType: 'container.destroyed',
          occurredAt: exitedAt,
          accountId: container.billingAccountId,
          resourceId: container.id,
          payload: { billingStartedAt: startedAt, exitedAt },
        });
      },
    },
  );
  const billingPublisher = new BillingEventPublisher({
    intervalMs: config.outboxRelayIntervalMs,
    transport: new RabbitMqTransport(config.rabbitmqUrl, logger),
    logger,
  });
  const heartbeatTracker = new HeartbeatTracker();

  // gateway ↔ dispatcher 的桥接：dispatcher 先构造并注入回调，gateway 注册后再回填句柄
  // （避免二者构造期循环依赖）。
  const gatewayBridge: {
    emitToContainer: (containerId: string, event: string, payload: unknown) => void;
    isConnected: (containerId: string) => boolean;
  } = {
    emitToContainer: () => {},
    isConnected: () => false,
  };
  const dispatcher = new WorkloadDispatcher({
    containerRepository: repo,
    containerService,
    workloadRepository,
    workloadLogRepository,
    emitToContainer: (containerId, event, payload) =>
      gatewayBridge.emitToContainer(containerId, event, payload),
    isConnected: (containerId) => gatewayBridge.isConnected(containerId),
    initTimeoutMs: config.workloadInitTimeoutMs,
    postBudgetMs: config.workloadPostBudgetMs,
    logMaxBytes: config.workloadLogMaxBytes,
    // 必须失败通知：锁外强制注销（复用既有 destroy，reason 写入 exitReason；裁决 7）。
    forceDestroy: (containerId, reason) => containerService.destroy(containerId, { reason }),
    logger,
  });

  const statusSync = new StatusSyncService({
    repo,
    k8sClient,
    containerService,
    heartbeatTracker,
    connectTimeoutMs: config.connectTimeoutMs,
    image: config.workerImage,
    dispatcher,
    logger,
  });

  const gateway = registerWorkerGateway(io, {
    tokenService,
    containerService,
    heartbeatTracker,
    workloadDispatcher: dispatcher,
    logger,
  });
  gatewayBridge.emitToContainer = gateway.emitToContainer;
  gatewayBridge.isConnected = gateway.isConnected;

  app.use(
    '/internal',
    internalAuth(config.internalApiToken),
    createInternalRouter(containerService, { workloadRepository, workloadLogRepository }),
  );

  let started = false;

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    await mongoose.connect(config.mongodbUri);
    // 计费集合索引（eventId 唯一 / {producer,published,createdAt}）随启动建立。
    // D3：enqueue 去重完全依赖 eventId 唯一索引，索引缺失会导致重复事件——必须 fail-fast。
    try {
      await BillingOutbox.syncIndexes();
    } catch (err) {
      logger.warn?.(`[billing] syncIndexes failed (fatal): ${(err as Error).message}`);
      throw err;
    }
    billingPublisher.start();
    await statusSync.start();
    await new Promise<void>((resolve) => {
      httpServer.listen(config.port, resolve);
    });
    logger.info(
      `cloud-controller listening on :${config.port} ` +
        `(engine path ${ENGINE_PATH}, log level ${config.logLevel})`,
    );
    logger.info(
      `[ws] worker 回连地址为 wss://<PUBLIC_WS_ENDPOINT>/worker；握手实际打到 ${ENGINE_PATH}，` +
        `Ingress 必须放行该路径（PUBLIC_WS_ENDPOINT=${config.publicWsEndpoint || '-'}）。`,
    );
  }

  async function stop(): Promise<void> {
    statusSync.stop();
    // O-1：先排空在途计费钩子（outbox enqueue），再停 publisher，避免 SIGTERM 截断事件写入。
    await containerService.drainBillingHooks();
    await billingPublisher.stop();
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
