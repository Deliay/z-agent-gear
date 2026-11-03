/**
 * C5 span 锚定：`status.sync.tick` / `workload.dispatch` / `socket.handshake` 三处 span
 * 的唯一性（每轮 / 每批次恰 1 个，不逐容器/逐条脚本开 span）、属性与 parent 关联。
 *
 * 自建 TracerProvider + SimpleSpanProcessor + RecordingExporter（`span.end()` 后微任务内
 * 落入导出器；RecordingExporter shutdown 不清空，断言前轮询到齐）。不走 `startTelemetry`：
 * 其 `started` 一次性位不允许同文件内多轮启停。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import { RecordingExporter } from '../observability/recording-exporter.js';
import { createTestLogger } from '../observability/testing.js';
import { InMemoryContainerRepository } from '../repositories/container-repository.js';
import { InMemoryWorkloadLogRepository } from '../repositories/workload-log-repository.js';
import {
  InMemoryWorkloadRepository,
  type CloudWorkloadEntity,
} from '../repositories/workload-repository.js';
import { ContainerService } from './container-service.js';
import { HeartbeatTracker } from './heartbeat-tracker.js';
import { InMemoryK8sClient } from './k8s-client.js';
import { K8sJobManager } from './k8s-job-manager.js';
import { ENGINE_PATH, registerWorkerGateway } from './socketio-gateway.js';
import { StatusSyncService } from './status-sync.js';
import { TokenService } from './token-service.js';
import { WorkloadDispatcher } from './workload-dispatcher.js';

const exporter = new RecordingExporter();
let provider: TracerProvider;

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
});

/** SimpleSpanProcessor 异步入导出器：断言前轮询到齐（避免微任务时序抖动）。 */
async function waitForSpans(name: string, count: number, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (exporter.spans.filter((s) => s.name === name).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${count} '${name}' span(s)`);
}

function mkWorkload(id: string, name: string, initScript: string): CloudWorkloadEntity {
  return { id, name, initScript, postScript: null, createdAt: new Date(0), updatedAt: new Date(0) };
}

function mkJobManager(client: InMemoryK8sClient): K8sJobManager {
  return new K8sJobManager(client, {
    namespace: 'zag-workers',
    image: 'zero-tools/zag-worker:latest',
    publicWsEndpoint: 'cloud.example.com:4003',
  });
}

function mkContainerService(
  repo: InMemoryContainerRepository,
  client: InMemoryK8sClient,
  logger: ReturnType<typeof createTestLogger>['logger'],
): ContainerService {
  const tokenService = new TokenService(repo);
  return new ContainerService(
    repo,
    tokenService,
    mkJobManager(client),
    {
      namespace: 'zag-workers',
      image: 'zero-tools/zag-worker:latest',
      connectTimeoutMs: 300000,
      shutdownGraceMs: 0,
    },
    logger,
  );
}

async function createContainer(repo: InMemoryContainerRepository, workloadIds: string[] = []) {
  return repo.create({
    name: `zag-worker-${Math.random().toString(36).slice(2, 8)}`,
    namespace: 'zag-workers',
    purpose: 'idle',
    image: 'zero-tools/zag-worker:latest',
    status: 'connecting',
    workloadIds,
  });
}

describe('C5 span 锚定', () => {
  it('status.sync.tick：每轮恰 1 个 span（多容器不逐容器开 span），属性含 checked/changed', async () => {
    const log = createTestLogger('status-sync');
    const repo = new InMemoryContainerRepository();
    const client = new InMemoryK8sClient();
    const statusSync = new StatusSyncService({
      repo,
      k8sClient: client,
      containerService: mkContainerService(repo, client, log.logger),
      heartbeatTracker: new HeartbeatTracker(),
      connectTimeoutMs: 300000,
      image: 'zero-tools/zag-worker:latest',
      reconnectDelayMs: 0,
      logger: log.logger,
    });
    // 巡检定时器 15s 一轮：单测直接驱动私有 tick（span 只在 tick 内开）。
    const tick = async (): Promise<void> =>
      (statusSync as unknown as { runInspectionTick(): Promise<void> }).runInspectionTick();

    const now = Date.now();
    // 多容器、多状态：各步骤只检查状态落入本步骤范围的记录
    await repo.create({
      name: 'zag-online',
      namespace: 'zag-workers',
      purpose: 'idle',
      image: 'zero-tools/zag-worker:latest',
      status: 'online',
      // 10 分钟无心跳 → 本轮判定离线（changed=1）
      connectedAt: new Date(now - 10 * 60_000),
    });
    await repo.create({
      name: 'zag-connecting',
      namespace: 'zag-workers',
      purpose: 'idle',
      image: 'zero-tools/zag-worker:latest',
      status: 'connecting',
    });
    await repo.create({
      name: 'zag-creating',
      namespace: 'zag-workers',
      purpose: 'idle',
      image: 'zero-tools/zag-worker:latest',
      status: 'creating',
    });
    await repo.create({
      name: 'zag-exited',
      namespace: 'zag-workers',
      purpose: 'idle',
      image: 'zero-tools/zag-worker:latest',
      status: 'exited',
    });

    await tick();
    await tick();
    await waitForSpans('status.sync.tick', 2);

    const spans = exporter.spans.filter((s) => s.name === 'status.sync.tick');
    // 两轮 × 4 容器仍恰 2 个 span（整轮一个，不逐容器开 span）
    expect(spans).toHaveLength(2);
    // checked = 实际检查状态数（去重后容器数 4），非三步 records.length 全量累加（12）
    expect(spans[0]!.attributes.checked).toBe(4);
    expect(spans[0]!.attributes.changed).toBe(1);
    // 轮 2：online 已退回 connecting，4 个容器仍各被检查一次，无新变更
    expect(spans[1]!.attributes.checked).toBe(4);
    expect(spans[1]!.attributes.changed).toBe(0);
  });

  it('workload.dispatch：每个 workload:run 批次恰 1 个 span（属性 workload.count），不逐条脚本开 span', async () => {
    const log = createTestLogger('workload-dispatcher');
    const repo = new InMemoryContainerRepository();
    const client = new InMemoryK8sClient();
    const containerService = mkContainerService(repo, client, log.logger);
    const workloadRepository = new InMemoryWorkloadRepository();
    const dispatcher = new WorkloadDispatcher({
      containerRepository: repo,
      containerService,
      workloadRepository,
      workloadLogRepository: new InMemoryWorkloadLogRepository(),
      emitToContainer: () => {},
      isConnected: () => true,
      initTimeoutMs: 1000,
      postBudgetMs: 5000,
      logMaxBytes: 262144,
      forceDestroy: async () => {},
      logger: log.logger,
    });

    workloadRepository.add(mkWorkload('w1', 'init-a', 'echo a'));
    workloadRepository.add(mkWorkload('w2', 'init-b', 'echo b'));
    workloadRepository.add(mkWorkload('w3', 'init-c', 'echo c'));

    // 批次 A：2 条脚本 → 1 个 workload:run → 1 个 span；批次 B：1 条脚本 → 1 个 span
    const batchA = await createContainer(repo, ['w1', 'w2']);
    const batchB = await createContainer(repo, ['w3']);
    await dispatcher.startInit(batchA.id);
    await dispatcher.startInit(batchB.id);
    await waitForSpans('workload.dispatch', 2);

    const spans = exporter.spans.filter((s) => s.name === 'workload.dispatch');
    // 3 条脚本共 2 个批次 → 恰 2 个 span（不逐条脚本开 span）
    expect(spans).toHaveLength(2);
    expect(spans[0]!.attributes['workload.count']).toBe(2);
    expect(spans[0]!.attributes['messaging.batch.message_count']).toBe(2);
    expect(spans[0]!.attributes.phase).toBe('init');
    expect(spans[1]!.attributes['workload.count']).toBe(1);
    expect(spans[1]!.attributes['messaging.batch.message_count']).toBe(1);
    expect(spans[1]!.attributes.phase).toBe('init');
  });

  it('socket.handshake：握手 span 存在且与 auth.traceparent 提取的 parent 关联', async () => {
    const log = createTestLogger('socketio-gateway');
    const repo = new InMemoryContainerRepository();
    const client = new InMemoryK8sClient();
    const containerService = mkContainerService(repo, client, log.logger);
    const tokenService = new TokenService(repo);

    const httpServer: HttpServer = createServer((_req, res) => {
      res.statusCode = 404;
      res.end('Not Found');
    });
    const io = new SocketIOServer(httpServer, { path: ENGINE_PATH, transports: ['websocket'] });
    registerWorkerGateway(io, {
      tokenService,
      containerService,
      heartbeatTracker: new HeartbeatTracker(),
      logger: log.logger,
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const address = httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const container = await createContainer(repo);
    const token = await tokenService.issue(container.id);

    // W3C traceparent：parent 关联断言的期望值（flags=01 已采样，parentbased 采样放行）
    const traceId = '1'.repeat(32);
    const parentSpanId = '2'.repeat(16);
    const traceparent = `00-${traceId}-${parentSpanId}-01`;

    const socket = ioClient(`${baseUrl}/worker`, {
      auth: { token, traceparent },
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
    await waitForSpans('socket.handshake', 1);
    socket.close();

    const span = exporter.spans.find((s) => s.name === 'socket.handshake');
    expect(span).toBeDefined();
    // parent 关联：握手 span 挂在 auth.traceparent 提取的远端 span 之下（同 traceId）
    expect(span!.spanContext().traceId).toBe(traceId);
    expect(span!.parentSpanContext?.spanId).toBe(parentSpanId);

    await new Promise<void>((resolve) => {
      io.close();
      httpServer.close(() => resolve());
    });
  });
});
