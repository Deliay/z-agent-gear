import mongoose from 'mongoose';
import { GraphQLError } from 'graphql';
import { config } from '../config/index.js';
import { CloudContainer } from '../models/cloud-container.js';
import { CloudHost } from '../models/cloud-host.js';
import { CloudHostSetupOperation } from '../models/cloud-host-setup-operation.js';
import { Controller } from '../models/controller.js';
import {
  CloudControllerClient,
  cloudControllerClient,
  CloudControllerRequestError,
  CloudControllerUnavailableError,
} from './cloud-controller-client.js';
import { cloudWorkloadCatalog, type CloudWorkloadCatalogItem } from './cloud-workload-catalog.js';
import { actorFilter } from './workspace-context.js';
import { cloudHostService } from './cloud-host-service.js';

type Doc = Record<string, unknown>;

export interface CloudHostWorkloadItem {
  workloadId: string;
  name: string;
  workloadKind: string;
  paramSchema: unknown[];
  dependsOnWorkloadIds: string[];
  isPreset: boolean;
  installed: boolean;
  installedAt: string | null;
  source: string | null;
}

interface Logger {
  warn?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
}

interface CloudHostWorkloadServiceDeps {
  controllerClient?: CloudControllerClient;
  catalog?: typeof cloudWorkloadCatalog;
  stepTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

const TERMINAL_LOG_STATUSES = new Set(['success', 'failed', 'timeout']);

/** 错误文案脱敏：过滤 token/Authorization/常见 token 前缀，截断 512。 */
export function sanitizeOperationError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/token=[^\s&]+/gi, 'token=***')
    .replace(/gh[pousr]_[A-Za-z0-9]+/g, '***')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '***')
    .replace(/Authorization:[^\n]*/gi, 'Authorization: ***')
    .slice(0, 512);
}

export function mapOperation(doc: Doc): Doc {
  return {
    id: String(doc._id ?? doc.id),
    kind: doc.kind === 'githubSetup' ? 'GITHUB_SETUP' : 'INSTALL_WORKLOAD',
    status: doc.status ?? 'RUNNING',
    steps: (Array.isArray(doc.steps) ? doc.steps : []).map(
      (step: Record<string, unknown>) => ({
        key: step.key,
        status: step.status ?? 'PENDING',
        detail: step.detail ?? null,
      }),
    ),
    sessionId: doc.sessionId ? String(doc.sessionId) : null,
    error: doc.error ?? null,
    createdAt: toIso(doc.createdAt),
    updatedAt: toIso(doc.updatedAt),
  };
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(0).toISOString();
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 云主机工作负载列表/安装与 operation runner。
 *
 * 操作创建后立即返回，后台异步推进；同一 controllerId 同时只允许一个 RUNNING 的
 * `githubSetup`（github service 负责拒绝并发）。
 */
export class CloudHostWorkloadService {
  private readonly controllerClient: CloudControllerClient;
  private readonly catalog: typeof cloudWorkloadCatalog;
  private readonly stepTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Logger;

  constructor(deps: CloudHostWorkloadServiceDeps = {}) {
    this.controllerClient = deps.controllerClient ?? cloudControllerClient;
    this.catalog = deps.catalog ?? cloudWorkloadCatalog;
    this.stepTimeoutMs = deps.stepTimeoutMs ?? config.cloudHostSetupStepTimeoutMs;
    this.pollIntervalMs = deps.pollIntervalMs ?? 1000;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? sleepDefault;
    this.logger = deps.logger ?? console;
  }

  /** 校验 Controller 归属/类型并返回云主机（不存在/非本人统一「Cloud host not found」）。 */
  async requireCloudHost(userId: string, controllerId: string): Promise<Doc> {
    if (!mongoose.isValidObjectId(controllerId)) throw new Error('Cloud host not found');
    const controller = await Controller.findOne({ _id: controllerId, ...actorFilter(userId) }).lean();
    if (!controller || controller.type !== 'cloud') throw new Error('Cloud host not found');
    const host = await cloudHostService.findOwnedRawHostByController(controllerId, userId);
    if (!host) throw new Error('Cloud host not found');
    return host;
  }

  async list(userId: string, controllerId: string): Promise<CloudHostWorkloadItem[]> {
    const host = await this.requireCloudHost(userId, controllerId);
    const installed = await this.installedMap(String(host._id));
    const items = await this.catalog.listStandard();
    return items.map((item) => {
      const record = installed.get(item.id);
      return {
        workloadId: item.id,
        name: item.name,
        workloadKind: 'STANDARD',
        paramSchema: item.paramSchema,
        dependsOnWorkloadIds: item.dependsOnWorkloadIds,
        isPreset: item.isPreset,
        installed: record !== undefined,
        installedAt: record?.installedAt ?? null,
        source: record?.source ?? null,
      };
    });
  }

  /**
   * 无主机上下文的 standard 负载目录（创建云电脑时可勾选预装）。
   * 复用同一 `CloudHostWorkloadItem` 类型；无容器记录，`installed` 固定 false。
   */
  async listCatalog(): Promise<CloudHostWorkloadItem[]> {
    const items = await this.catalog.listStandard();
    return items.map((item) => ({
      workloadId: item.id,
      name: item.name,
      workloadKind: 'STANDARD',
      paramSchema: item.paramSchema,
      dependsOnWorkloadIds: item.dependsOnWorkloadIds,
      isPreset: item.isPreset,
      installed: false,
      installedAt: null,
      source: null,
    }));
  }

  private async installedMap(
    hostId: string,
  ): Promise<Map<string, { installedAt: string | null; source: string | null }>> {
    const container = await CloudContainer.findOne({ hostId }).sort({ createdAt: -1 }).lean();
    const map = new Map<string, { installedAt: string | null; source: string | null }>();
    const entries = Array.isArray(container?.installedWorkloads)
      ? (container!.installedWorkloads as Array<Record<string, unknown>>)
      : [];
    for (const entry of entries) {
      const id = String(entry.workloadId);
      map.set(id, {
        installedAt:
          entry.installedAt instanceof Date
            ? entry.installedAt.toISOString()
            : typeof entry.installedAt === 'string'
              ? entry.installedAt
              : null,
        source: typeof entry.source === 'string' ? entry.source : null,
      });
    }
    return map;
  }

  async createInstallOperation(input: {
    userId: string;
    controllerId: string;
    workloadId: string;
    params?: Record<string, unknown>;
  }): Promise<Doc> {
    const host = await this.requireCloudHost(input.userId, input.controllerId);
    if (!host.containerId) throw new Error('cloud host is not running');
    if (host.status !== 'RUNNING') throw new Error('cloud host is not running');
    if (!mongoose.isValidObjectId(input.workloadId)) throw new Error('Workload not found');
    const workload = await this.catalog.findById(input.workloadId);
    if (!workload) throw new Error('Workload not found');
    if (workload.workloadKind !== 'standard') throw new Error('Workload not found');

    const operation = await CloudHostSetupOperation.create(({
      userId: input.userId,
      controllerId: input.controllerId,
      hostId: host._id,
      kind: 'installWorkload',
      status: 'RUNNING',
      workloadId: input.workloadId,
      installParams: input.params ?? {},
      steps: [{ key: 'workload', status: 'PENDING', detail: null }],
      containerId: String(host.containerId),
    }) as any);
    const doc = operation.toObject();
    this.enqueue(String(operation._id));
    return mapOperation(doc);
  }

  /** 异步入队（不阻塞调用方）。 */
  enqueue(opId: string): void {
    void this.runInstall(opId).catch((err) => this.fail(opId, err));
  }

  /** 重试失败的单步安装操作：仅 FAILED；重置未成功步骤为 PENDING。 */
  async retryInstall(opId: string, userId: string): Promise<Doc> {
    const operation = await CloudHostSetupOperation.findOne({ _id: opId, ...actorFilter(userId) }).lean();
    if (!operation) throw new Error('Operation not found');
    // 操作单无 workspaceId：经 host 的工作区归属校验
    const hostVisible = await CloudHost.findOne({
      _id: (operation as unknown as { hostId: unknown }).hostId,
      ...actorFilter(userId),
    })
      .select('_id')
      .lean();
    if (!hostVisible) throw new Error('Operation not found');
    if (operation.status !== 'FAILED') throw new Error('仅失败的操作可以重试');
    const steps = (operation.steps as any[]).map((step: Record<string, unknown>) => ({
      ...step,
      status:
        step.status === 'SUCCEEDED' || step.status === 'SKIPPED' ? step.status : 'PENDING',
      detail:
        step.status === 'SUCCEEDED' || step.status === 'SKIPPED' ? step.detail : null,
    }));
    await CloudHostSetupOperation.updateOne(
      { _id: opId },
      { $set: { status: 'RUNNING', error: null, steps } },
    );
    this.enqueue(opId);
    const updated = await CloudHostSetupOperation.findById(opId).lean();
    return mapOperation(updated as Doc);
  }

  /** 轮询 DB 等待终态（MCP 工具用）。 */
  async waitForCompletion(opId: string, timeoutMs: number): Promise<Doc | null> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const doc = await CloudHostSetupOperation.findById(opId).lean();
      if (!doc) return null;
      if (doc.status !== 'RUNNING') return mapOperation(doc as Doc);
      if (this.now() >= deadline) return mapOperation(doc as Doc);
      await this.sleep(this.pollIntervalMs);
    }
  }

  private async runInstall(opId: string): Promise<void> {
    const operation = await CloudHostSetupOperation.findById(opId).lean();
    if (!operation || operation.status !== 'RUNNING') return;
    const params = (operation as Record<string, unknown>).installParams;
    const workloadId = String((operation as Record<string, unknown>).workloadId ?? '');
    try {
      const workload = await this.resolveInstallWorkload(operation as Doc);
      await this.updateStep(opId, 'workload', {
        status: 'RUNNING',
        detail: workload.name,
      });

      const installed = await this.isInstalled(
        String(operation.hostId),
        workload.id,
      );
      if (installed) {
        await this.updateStep(opId, 'workload', {
          status: 'SKIPPED',
          detail: `${workload.name}（已安装）`,
        });
      } else {
        const result = await this.controllerClient.startRuntimeWorkload({
          containerId: String(operation.containerId),
          workloadId: workload.id,
          params:
            params && typeof params === 'object' && !Array.isArray(params)
              ? (params as Record<string, unknown>)
              : {},
          source: 'user',
        });
        await this.pollBatch(
          opId,
          String(operation.containerId),
          result.items.map((item) => item.logId),
          'workload',
        );
        await this.updateStep(opId, 'workload', {
          status: 'SUCCEEDED',
          detail: workload.name,
        });
      }

      await CloudHostSetupOperation.updateOne(
        { _id: opId },
        { $set: { status: 'SUCCEEDED', error: null } },
      );
    } catch (err) {
      await this.fail(opId, err);
    }
  }

  private async resolveInstallWorkload(operation: Doc): Promise<CloudWorkloadCatalogItem> {
    const explicit = String((operation as Record<string, unknown>).workloadId ?? '');
    if (explicit) {
      const found = await this.catalog.findById(explicit);
      if (found) return found;
    }
    // 兼容 runner 未持久化 workloadId 的场景：从 step detail 无法反推，直接报错。
    throw new Error('Workload not found');
  }

  private async isInstalled(hostId: string, workloadId: string): Promise<boolean> {
    const map = await this.installedMap(hostId);
    return map.has(workloadId);
  }

  /** 轮询执行记录直到全部终态；任一 failed/timeout → 抛可读错误。 */
  async pollBatch(
    opId: string,
    containerId: string,
    logIds: string[],
    stepKey: string,
  ): Promise<void> {
    const wanted = new Set(logIds.filter(Boolean));
    const deadline = this.now() + this.stepTimeoutMs;
    for (;;) {
      const logs = await this.controllerClient.getWorkloadLogs(containerId);
      const relevant = logs.filter((log) => wanted.has(log.id));
      const running = relevant.find((log) => log.status === 'running');
      if (running) {
        await this.updateStep(opId, stepKey, { detail: running.workloadName });
      }
      const pending = relevant.filter((log) => !TERMINAL_LOG_STATUSES.has(log.status));
      if (pending.length === 0) {
        const failed = relevant.find((log) => log.status !== 'success');
        if (failed) {
          const suffix = failed.log ? `：${failed.log.slice(-200)}` : '';
          throw new Error(
            `工作负载执行失败（${failed.workloadName}，状态 ${failed.status}）${suffix}`,
          );
        }
        return;
      }
      if (this.now() >= deadline) {
        throw new Error('等待工作负载执行超时');
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  async updateStep(
    opId: string,
    key: string,
    patch: { status?: string; detail?: string | null },
  ): Promise<void> {
    const operation = await CloudHostSetupOperation.findById(opId).lean();
    if (!operation) return;
    const steps = (operation.steps as any[]).map((step: Record<string, unknown>) =>
      step.key === key ? { ...step, ...patch } : step,
    );
    await CloudHostSetupOperation.updateOne({ _id: opId }, { $set: { steps } });
  }

  async fail(opId: string, err: unknown, stepKey = 'workload'): Promise<void> {
    const message = sanitizeOperationError(err);
    this.logger.warn?.(`[cloud-host-setup] operation failed op=${opId}: ${message}`);
    const operation = await CloudHostSetupOperation.findById(opId).lean();
    if (!operation) return;
    const steps = (operation.steps as any[]).map((step: Record<string, unknown>) =>
      step.key === stepKey && step.status !== 'SUCCEEDED' && step.status !== 'SKIPPED'
        ? { ...step, status: 'FAILED', detail: message }
        : step,
    );
    await CloudHostSetupOperation.updateOne(
      { _id: opId },
      { $set: { status: 'FAILED', error: message, steps } },
    );
  }

  /** 将 controller 错误转成可读文案（供上层 operation error 使用）。 */
  describeControllerError(err: unknown): string {
    if (err instanceof CloudControllerRequestError) {
      if (err.code === 'CONTAINER_NOT_ONLINE') return '云电脑不在线';
      if (err.code === 'CONTAINER_BUSY') return '云电脑正在执行其他工作负载任务';
      if (err.code === 'INVALID_WORKLOAD') return err.message;
      if (err.code === 'NOT_FOUND') return '云电脑不存在';
    }
    if (err instanceof CloudControllerUnavailableError) return '控制面不可用';
    return sanitizeOperationError(err);
  }
}

export const cloudHostWorkloadService = new CloudHostWorkloadService();

/** 供 resolver 统一把 service 错误转为 GraphQLError（保留逐字文案）。 */
export function toCloudHostSetupGraphQLError(err: unknown): never {
  if (err instanceof GraphQLError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  throw new GraphQLError(message);
}
