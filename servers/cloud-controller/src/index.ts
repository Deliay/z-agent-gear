import './observability/register.js';
import { createServer, type Server as HttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { Server as SocketIOServer } from 'socket.io';
import type { Logger as PinoLogger } from 'pino';
import { assertRuntimeConfig, config } from './config/index.js';
import { logger as rootLogger, type ObservationLogger } from './observability/logger.js';
import { httpContext } from './observability/http-context.js';
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
import { SecretStore } from './services/secret-store.js';
import { AgentApiClient } from './services/agent-api-client.js';
import { AdminBillingClient } from './services/admin-billing-client.js';
import { wireSocketDiagnostics } from './services/socket-diagnostics.js';
import {
  BillingEventPublisher,
  RabbitMqTransport,
} from './services/billing-event-publisher.js';
import { BillingOutbox } from './models/billing-outbox.js';
import { internalAuth } from './middleware/internal-auth.js';
import { createInternalRouter } from './routes/internal-api.js';
import { runMigrations } from './migrations/runner.js';
import * as migration001CloudcontainersTenantId from './migrations/001-cloudcontainers-tenant-id-backfill.js';
import * as migration002CloudcontainersWorkspaceId from './migrations/002-cloudcontainers-workspace-id.js';

export interface CloudControllerApp {
  app: express.Express;
  httpServer: HttpServer;
  io: SocketIOServer;
  statusSync: StatusSyncService;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * 云电脑终态映射（契约 A19）：exited→stopped、failed→failed、其它→stopped。
 *
 * 必须工作负载失败走 `forceDestroy` 链路（终态固定 `exited`），仅靠 `status==='failed'`
 * 会被误映射为「已销毁」并丢弃 `exitReason`（C-1）。因此 `mustFailure===true` 时同样
 * 映射为 `failed`，让 agent-api 落 FAILED + failureReason。
 */
export function harnessTerminalStatus(status: string, mustFailure = false): 'stopped' | 'failed' {
  return status === 'failed' || mustFailure ? 'failed' : 'stopped';
}

/** harness 生命周期回调重试（agent-api/admin-api 短暂不可达时退避；最终失败由外层钩子再重试并记 error）。 */
export async function retryHarnessCallback(
  label: string,
  task: () => Promise<void>,
  logger: ObservationLogger = rootLogger,
  delays: readonly number[] = [0, 250, 1000, 3000],
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]! > 0) {
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
    try {
      await task();
      return;
    } catch (err) {
      lastError = err;
      logger.warn(
        { component: 'harness', label, attempt: attempt + 1, maxAttempts: delays.length, err },
        'harness callback failed, will retry',
      );
    }
  }
  logger.error({ component: 'harness', label, err: lastError }, 'harness callback failed after retries');
  throw lastError;
}

export function createCloudControllerApp(options: { logger?: PinoLogger } = {}): CloudControllerApp {
  assertRuntimeConfig(config);
  const logger = (options.logger ?? rootLogger).child({ component: 'cloud-controller' });

  const app = express();
  app.use(cors());
  app.use(httpContext());
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
  wireSocketDiagnostics({
    httpServer,
    io,
    logger: logger.child({ component: 'socket-diagnostics' }),
    enginePath: ENGINE_PATH,
  });

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
    ephemeralStorage: config.jobEphemeralStorage,
  });
  // 云电脑运行期 secret（仅内存）与内部回调客户端；地址为空时对应回调为 no-op。
  const secretStore = new SecretStore();
  const agentApiClient = new AgentApiClient({
    baseUrl: config.agentApiUrl,
    token: config.internalApiToken,
    timeoutMs: config.agentApiTimeoutMs,
  });
  const adminBillingClient = new AdminBillingClient({
    baseUrl: config.adminApiUrl,
    token: config.internalApiToken,
    timeoutMs: config.agentApiTimeoutMs,
  });
  if (!agentApiClient.configured) {
    logger.warn(
      { component: 'harness' },
      'AGENT_API_URL 未配置：云电脑 ready/terminal 回调将不会发送（云电脑可能停在 STARTING/RUNNING）',
    );
  }
  if (!adminBillingClient.configured) {
    logger.warn(
      { component: 'harness' },
      'ADMIN_API_URL 未配置：容器终态撤销运行专用模型 Key 将不会发送（依赖 Key 过期/对账兜底）',
    );
  }

  /**
   * harness 生命周期回调重试：agent-api 短暂不可达时自动退避重试。
   * 最终仍失败由外层 ContainerService 钩子（3 次）再重试并记录 error 日志（降级：
   * agent-api 侧仍可用过期/对账与容器状态兜底，不阻断容器回收）。
   */
  const containerService = new ContainerService(
    repo,
    tokenService,
    jobManager,
    {
      namespace: config.k8sNamespace,
      image: config.workerImage,
      connectTimeoutMs: config.connectTimeoutMs,
      shutdownGraceMs: 10000,
      agentApiUrl: config.agentApiUrl,
    },
    logger.child({ component: 'container-service' }),
    {
      // 生命周期钩子：先计费（只写本地 outbox，relay 异步发布），再云电脑回调；
      // 二者互不影响，各自失败独立告警（计费失败保留既有 3 次重试语义）。
      onReady: async (container) => {
        let billingError: unknown;
        try {
          if (container.billingAccountId && container.billingStartedAt) {
            const startedAt = container.billingStartedAt.toISOString();
            await billingPublisher.enqueue({
              eventId: `container.ready:${container.id}`,
              eventType: 'container.ready',
              occurredAt: startedAt,
              accountId: container.billingAccountId,
              resourceId: container.id,
              payload: { billingStartedAt: startedAt },
            });
          }
        } catch (err) {
          billingError = err;
        }
        let callbackError: unknown;
        if (container.purpose === 'harness' && container.hostId) {
          try {
            await retryHarnessCallback(
              `ready callback hostId=${container.hostId}`,
              () => agentApiClient.notifyReady(container.hostId!),
              logger,
            );
          } catch (err) {
            callbackError = err;
          }
        }
        if (billingError) throw billingError;
        if (callbackError) throw callbackError;
      },
      onDestroyed: async (container) => {
        let billingError: unknown;
        try {
          if (container.billingAccountId && container.billingStartedAt) {
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
          }
        } catch (err) {
          billingError = err;
        }
        let callbackError: unknown;
        if (container.purpose === 'harness' && container.hostId) {
          // 终态映射（契约 A19）：exited→stopped、failed→failed、其它（destroyed）→stopped；
          // 必须工作负载失败（destroy 链路终态 exited + mustFailure）按 failed 上报并保留原因（C-1）。
          const status = harnessTerminalStatus(container.status, container.mustFailure);
          try {
            await retryHarnessCallback(
              `terminal callback hostId=${container.hostId}`,
              () =>
                agentApiClient.notifyTerminal(
                  container.hostId!,
                  status,
                  container.exitReason ?? undefined,
                ),
              logger,
            );
          } catch (err) {
            callbackError = err;
          }
          try {
            await retryHarnessCallback(
              `revoke-by-host hostId=${container.hostId}`,
              () => adminBillingClient.revokeByHost(container.hostId!),
              logger,
            );
          } catch (err) {
            callbackError = callbackError ?? err;
          }
        }
        if (billingError) throw billingError;
        if (callbackError) throw callbackError;
      },
    },
    secretStore,
  );
  const billingPublisher = new BillingEventPublisher({
    intervalMs: config.outboxRelayIntervalMs,
    transport: new RabbitMqTransport(config.rabbitmqUrl, logger.child({ component: 'billing-mq' })),
    logger: logger.child({ component: 'billing-events' }),
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
    secretStore,
    logger: logger.child({ component: 'workload-dispatcher' }),
  });

  const statusSync = new StatusSyncService({
    repo,
    k8sClient,
    containerService,
    heartbeatTracker,
    connectTimeoutMs: config.connectTimeoutMs,
    image: config.workerImage,
    dispatcher,
    logger: logger.child({ component: 'status-sync' }),
  });

  const gateway = registerWorkerGateway(io, {
    tokenService,
    containerService,
    heartbeatTracker,
    workloadDispatcher: dispatcher,
    logger: logger.child({ component: 'worker-gateway' }),
  });
  gatewayBridge.emitToContainer = gateway.emitToContainer;
  gatewayBridge.isConnected = gateway.isConnected;

  app.use(
    '/internal',
    internalAuth(config.internalApiToken),
    createInternalRouter(containerService, { workloadRepository, workloadLogRepository, workloadDispatcher: dispatcher }),
  );

  let started = false;

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    await mongoose.connect(config.mongodbUri);
    // 数据库迁移（独立账本 cloud_controller_migrations）：在 listen 之前完成。
    // 失败只记录日志、不阻断启动（runner 逐迁移吞错，下次启动按未完成重试）——
    // 与 agent-api / admin-api 既有启动口径一致。
    try {
      await runMigrations([
        migration001CloudcontainersTenantId,
        migration002CloudcontainersWorkspaceId,
      ]);
    } catch (err) {
      logger.warn({ err }, 'runMigrations failed (non-fatal)');
    }
    // 计费集合索引（eventId 唯一 / {producer,published,createdAt}）随启动建立。
    // D3：enqueue 去重完全依赖 eventId 唯一索引，索引缺失会导致重复事件——必须 fail-fast。
    try {
      await BillingOutbox.syncIndexes();
    } catch (err) {
      logger.warn({ component: 'billing', err }, 'billing outbox syncIndexes failed (fatal)');
      throw err;
    }
    billingPublisher.start();
    await statusSync.start();
    await new Promise<void>((resolve) => {
      httpServer.listen(config.port, resolve);
    });
    logger.info(
      {
        port: config.port,
        enginePath: ENGINE_PATH,
        logLevel: config.logLevel,
        publicWsEndpoint: config.publicWsEndpoint || '-',
      },
      'cloud-controller listening；worker 回连地址为 wss://<PUBLIC_WS_ENDPOINT>/worker，握手实际打到 engine path，Ingress 必须放行该路径',
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
    rootLogger.info({ component: 'cloud-controller' }, 'shutting down cloud-controller');
    try {
      await application.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  application.start().catch((err) => {
    rootLogger.error({ component: 'cloud-controller', err }, 'cloud-controller failed to start');
    process.exit(1);
  });
}
