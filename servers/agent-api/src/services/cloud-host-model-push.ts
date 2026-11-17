import { logger as rootLogger } from '../observability/logger.js';
import { CloudHost } from '../models/cloud-host.js';
import { cloudControllerClient } from './cloud-controller-client.js';
import { invalidateAllAcpOptions } from './acp-options-cache.js';
import { modelService } from './model.js';
import { providerService } from './provider.js';
import { buildModelProvision, type ModelProvision } from './model-provision.js';
import { workspaceService } from './workspace-service.js';
import { runWithWorkspace } from './workspace-context.js';

const logger = rootLogger.child({ component: 'cloud-host-model-push' });

/** 单轮扇出的并发上限（D3：防 ack 超时拖慢整体）。 */
export const MODEL_PUSH_CONCURRENCY = 5;

interface PushTargetHost {
  _id?: unknown;
  containerId?: unknown;
  resourceWorkspaceId?: unknown;
}

/**
 * 候选主机查询。**必须在无 ALS 工作区上下文的调用点执行**（显式清空）：
 * `applyWorkspaceScope` 在请求上下文内会把云电脑收敛到当前工作区，与「按租户 / 全量扇出」冲突（D2）。
 */
async function listRunningHosts(extraFilter: Record<string, unknown>): Promise<PushTargetHost[]> {
  const filter: Record<string, unknown> = {
    status: 'RUNNING',
    deletedAt: null,
    containerId: { $nin: [null, ''] },
    resourceWorkspaceId: { $ne: null },
    ...extraFilter,
  };
  return runWithWorkspace(undefined, async () => {
    const hosts = await CloudHost.find(filter)
      .select('_id containerId resourceWorkspaceId')
      .lean();
    return hosts as unknown as PushTargetHost[];
  });
}

/**
 * 逐台重算载荷（D2）：
 * `resourceWorkspaceId` → `systemWorkspaceContext` → `runWithWorkspace` 内 findAll。
 * 上下文缺失/非法 → null（调用方跳过并告警），绝不裸跑 `findAll`。
 */
async function resolveProvisionForHost(host: PushTargetHost): Promise<ModelProvision | null> {
  const cloudHostId = host._id ? String(host._id) : '';
  const workspaceId = host.resourceWorkspaceId ? String(host.resourceWorkspaceId) : '';
  if (!workspaceId) {
    logger.warn({ cloudHostId }, 'skip model provision push: missing resource workspace');
    return null;
  }
  const context = await workspaceService.systemWorkspaceContext(workspaceId);
  if (!context) {
    logger.warn(
      { cloudHostId, workspaceId },
      'skip model provision push: workspace context not resolved',
    );
    return null;
  }
  return runWithWorkspace(context, async () => {
    const [models, providers] = await Promise.all([
      modelService.findAll(),
      providerService.findAll(),
    ]);
    return buildModelProvision(models, providers);
  });
}

async function pushToHost(host: PushTargetHost): Promise<void> {
  const cloudHostId = host._id ? String(host._id) : '';
  const containerId = host.containerId ? String(host.containerId) : '';
  if (!containerId) {
    logger.warn({ cloudHostId }, 'skip model provision push: missing containerId');
    return;
  }
  try {
    const provision = await resolveProvisionForHost(host);
    if (!provision) return;
    const result = await cloudControllerClient.pushHarnessModels(containerId, provision);
    if (!result.delivered) {
      logger.warn(
        { cloudHostId, containerId, delivered: result.delivered, reason: result.reason },
        'model provision not delivered',
      );
    }
  } catch (err) {
    // 单台失败只告警：不影响保存与其他云电脑（D11）
    logger.warn({ cloudHostId, containerId, err }, 'push model provision failed');
  }
}

/** 简单并发闸门（保持原顺序，逐台隔离失败）。 */
async function runWithLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

/** 用户侧模型/供应商变更：按租户扇出全部 RUNNING 云电脑（D2）。 */
export async function pushModelProvisionForTenant(tenantId: string): Promise<void> {
  if (!tenantId) return;
  const hosts = await listRunningHosts({ tenantId });
  await runWithLimit(hosts, MODEL_PUSH_CONCURRENCY, pushToHost);
}

/** 全局（后台）模型变更：全量扇出全部 RUNNING 云电脑。 */
export async function pushModelProvisionForAllRunning(): Promise<void> {
  const hosts = await listRunningHosts({});
  await runWithLimit(hosts, MODEL_PUSH_CONCURRENCY, pushToHost);
}

async function runGlobalRefreshOnce(): Promise<void> {
  await pushModelProvisionForAllRunning();
  await invalidateAllAcpOptions();
}

/** 进程内 single-flight：进行中合并；结束后若期间有新触发则补跑一轮（D3）。 */
let globalRefreshRunning = false;
let globalRefreshPending = false;
/** 当前轮是否已真正开始执行（同一 tick 内到达的并发触发只合并，不额外补跑）。 */
let globalRefreshStarted = false;

/**
 * 全局模型变更入口（admin-api → `POST /internal/model-config/refresh`）：
 * 全量 RUNNING 推送 + 全量 ACP 选项缓存失效，single-flight 防 batch/import 风暴。
 */
export async function applyGlobalModelRefresh(): Promise<void> {
  if (globalRefreshRunning) {
    // 同一 tick 内的并发触发视为一次；轮次已开始后再到达的触发需在结束后补跑一轮。
    if (globalRefreshStarted) globalRefreshPending = true;
    return;
  }
  globalRefreshRunning = true;
  globalRefreshStarted = false;
  try {
    let again = true;
    while (again) {
      globalRefreshPending = false;
      globalRefreshStarted = false;
      // 让出一次微任务：把同一 tick 内的并发触发合并进本轮，避免批量变更产生额外轮次。
      await Promise.resolve();
      globalRefreshStarted = true;
      try {
        await runGlobalRefreshOnce();
      } catch (err) {
        logger.warn({ err }, 'global model refresh failed');
      }
      again = globalRefreshPending;
    }
  } finally {
    globalRefreshRunning = false;
    globalRefreshStarted = false;
    // 临界区兜底：循环退出与新触发之间的窗口也必须补跑一轮。
    const pending = globalRefreshPending;
    globalRefreshPending = false;
    if (pending) {
      void applyGlobalModelRefresh().catch((err) => {
        logger.warn({ err }, 'global model refresh failed');
      });
    }
  }
}
