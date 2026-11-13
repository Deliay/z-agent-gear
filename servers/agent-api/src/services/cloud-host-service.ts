import { GraphQLError } from 'graphql';
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { logger as rootLogger } from '../observability/logger.js';
import { withSpan } from '../observability/trace.js';
import { CloudHost, HARNESS_TYPES, type HarnessType } from '../models/cloud-host.js';
import { Controller } from '../models/controller.js';
import { ControllerKey } from '../models/controller-key.js';
import { ControllerWorkspace } from '../models/controller-workspace.js';
import { GitHubAccount } from '../models/github-account.js';
import { Session } from '../models/session.js';
import { billingClient, BillingServiceUnavailableError, InsufficientBalanceError } from './billing-client.js';
import {
  CloudControllerClient,
  CloudControllerUnavailableError,
  cloudControllerClient,
} from './cloud-controller-client.js';
import { cloudWorkloadReader, harnessSlug, type HarnessPreset } from './cloud-workload-reader.js';
import { evictKeyById } from './key-cache.js';
import { KeyedMutex } from './keyed-mutex.js';
import { modelService } from './model.js';
import { sessionService } from './session.js';
import { actorFilter, getWorkspaceContext } from './workspace-context.js';
import { controllerKeyService } from './controller-key.js';
import { controllerService } from './controller.js';
import { cloudWorkloadCatalog } from './cloud-workload-catalog.js';
import { cloudHostIssuesLinkageService } from './cloud-host-issues-linkage.js';
import { configuredWorkflowService } from './workflow/configured.js';
import {
  MAX_CREATE_WORKLOADS,
  resolveCreateWorkloadPlan,
  type CreateWorkloadPlanEntry,
} from './cloud-host-workload-plan.js';
import { cloudStorageService, type CloudStorageService } from './cloud-storage-service.js';
import { compareVersions } from './version.js';

export const CLOUD_HOST_AGENT_GEAR_MIN_VERSION = '2.17.1';

const logger = rootLogger.child({ component: 'cloud-host' });

const ACTIVE_STATUSES = ['STARTING', 'RUNNING', 'STOPPING'] as const;

const HARNESS_ACP_TYPES: Record<HarnessType, string> = {
  OPENCODE: 'opencode',
  KIMI_CODE: 'kimi_code',
  DEEPSEEK_HARNESS: 'deepseek_harness',
};

/** 逐 harness 的 agent-gear 最低版本（按 harnessTypes 取最大值，缺省 2.17.1 基线） */
export const HARNESS_MIN_AGENT_GEAR_VERSION: Record<HarnessType, string> = {
  OPENCODE: '2.6.0',
  KIMI_CODE: '2.8.0',
  // 2.11.0：`cordis.patch.yml` insert `header-masq`（dsh-header-masq 会话标识请求头注入）
  // 2.17.1：随基线提升，保证容器具备 fs:read-file（会话文件预览）等 #461 能力
  DEEPSEEK_HARNESS: '2.17.1',
};

/** 按 harnessTypes 计算 agentGearMinVersion：取各类型要求版本与基线 2.17.1 的最大值 */
export function resolveAgentGearMinVersion(types: HarnessType[]): string {
  const versions = [CLOUD_HOST_AGENT_GEAR_MIN_VERSION, ...types.map((type) => HARNESS_MIN_AGENT_GEAR_VERSION[type] ?? CLOUD_HOST_AGENT_GEAR_MIN_VERSION)];
  return versions.reduce((max, current) => (compareVersions(current, max) > 0 ? current : max), CLOUD_HOST_AGENT_GEAR_MIN_VERSION);
}

export interface CreateCloudHostInput {
  name: string;
  harnessTypes: string[];
  /** 创建时附加预装的 standard 负载（去重后 ≤5；缺省/空 = 仅 harness）。 */
  workloadIds?: string[];
  /** D1：false 时 ready 不自动建默认会话（由项目准备 session 步骤建）；缺省 true。 */
  createDefaultSession?: boolean;
  /** 可选：创建时锁定 Github 帐号（必须是当前用户已绑定帐号）。 */
  githubAccountId?: string | null;
  /** 可选：挂载当前工作区 IDLE/ARCHIVED 云存储（缺省 = 不挂载，报文与历史一致）。 */
  storageId?: string | null;
}

export interface CloudHostStopImpact {
  activeSessionCount: number;
  sessionsWillBeLost: boolean;
  sessions: Array<{
    id: string;
    title: string;
    status: string;
    acpServerType: string;
  }>;
  /** 当前挂载的云存储摘要；未挂载为 null（停止对话框据此展示归档勾选项）。 */
  storage: Doc | null;
}

export interface TerminalCallbackInput {
  status: 'stopped' | 'failed';
  reason?: string;
  /** terminal 报文新增：挂载存储与归档状态（未挂载时不携带）。 */
  storage?: {
    id?: string | null;
    archiveStatus?: string | null;
    /** cloud-controller 本次归档 id（新周期占位/旧回调判定用，可缺省）。 */
    archiveId?: string | null;
    /** 本次销毁显式跳过归档（仅 true 时携带）。 */
    archiveSkipped?: boolean | null;
  } | null;
}

type Doc = Record<string, unknown>;

interface CloudHostServiceDeps {
  controllerClient?: CloudControllerClient;
  workloadReader?: typeof cloudWorkloadReader;
  catalog?: typeof cloudWorkloadCatalog;
  ttlSeconds?: number;
  storageService?: CloudStorageService;
}

function iso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

/**
 * 归一 harness 类型：允许 0 个（harness 为可选工作负载，运行期可在设置-工作负载补装）。
 * 非数组按空处理；非字符串/白名单外仍报 `unsupported harness type: …`；去重保序。
 */
function parseHarnessTypes(raw: string[]): HarnessType[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const result: HarnessType[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') {
      throw new Error(`unsupported harness type: ${String(value)}`);
    }
    const normalized = value.trim().toUpperCase();
    if (!HARNESS_TYPES.includes(normalized as HarnessType)) {
      throw new Error(`unsupported harness type: ${value.trim()}`);
    }
    if (!result.includes(normalized as HarnessType)) {
      result.push(normalized as HarnessType);
    }
  }
  return result;
}

/** 创建期显式 workloadIds：去重保序；空/缺省 = 仅 harness（与历史行为一致）。 */
function parseWorkloadIds(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('invalid workload');
  const result: string[] = [];
  for (const value of raw) {
    if (value === undefined || value === null) continue;
    const id = String(value).trim();
    if (!id) continue;
    if (!result.includes(id)) result.push(id);
  }
  if (result.length > MAX_CREATE_WORKLOADS) {
    throw new Error(`too many workloads (max ${MAX_CREATE_WORKLOADS})`);
  }
  return result;
}

/**
 * 前台云电脑领域服务：创建编排（扣费/退款）/ 数量无限制 / 停止即销毁 / 软删除 /
 * ready+terminal 回调 / 默认会话 / 会话只读判定入口。
 */
export class CloudHostService {
  private readonly userMutex = new KeyedMutex();
  private readonly hostMutex = new KeyedMutex();
  private readonly controllerClient: CloudControllerClient;
  private readonly workloadReader: typeof cloudWorkloadReader;
  private readonly catalog: typeof cloudWorkloadCatalog;
  private readonly ttlSeconds: number;
  private readonly storageService: CloudStorageService;

  constructor(deps: CloudHostServiceDeps = {}) {
    this.controllerClient = deps.controllerClient ?? cloudControllerClient;
    this.workloadReader = deps.workloadReader ?? cloudWorkloadReader;
    this.catalog = deps.catalog ?? cloudWorkloadCatalog;
    this.ttlSeconds = deps.ttlSeconds ?? config.harnessContainerTtlSeconds;
    this.storageService = deps.storageService ?? cloudStorageService;
  }

  async getCapabilities(): Promise<{ enabled: boolean; supportedHarnesses: HarnessType[] }> {
    if (!config.harnessEnabled) {
      return { enabled: false, supportedHarnesses: [] };
    }
    try {
      // 逐个 harness 探测 preset：存在即列出，缺失跳过
      const supportedHarnesses: HarnessType[] = [];
      for (const type of HARNESS_TYPES) {
        try {
          await this.workloadReader.findHarnessPreset(type);
          supportedHarnesses.push(type);
        } catch {
          // 单个 preset 缺失不阻断其他 harness
        }
      }
      return { enabled: true, supportedHarnesses };
    } catch {
      // preset 缺失：能力列表为空，create 返回明确错误
      return { enabled: true, supportedHarnesses: [] };
    }
  }

  private assertFeature(): void {
    if (!config.harnessEnabled) {
      throw new Error('harness feature is disabled');
    }
  }

  private assertConfigured(): void {
    if (
      !config.controllerApiPublicEndpoint ||
      !config.cloudHostModelBaseUrl ||
      !config.cloudControllerUrl ||
      !config.internalApiToken
    ) {
      throw new Error('cloud host is not configured');
    }
  }

  private validateInput(input: CreateCloudHostInput): {
    name: string;
    harnessTypes: HarnessType[];
    workloadIds: string[];
    createDefaultSession: boolean;
    githubAccountId: string | null;
    storageId: string | null;
  } {
    const name = (input.name ?? '').trim();
    if (!name) throw new Error('name is required');
    if (name.length > 64) throw new Error('name is too long');
    const rawAccountId =
      input.githubAccountId === undefined || input.githubAccountId === null
        ? ''
        : String(input.githubAccountId).trim();
    if (rawAccountId && !mongoose.isValidObjectId(rawAccountId)) {
      throw new Error('Github 账号不存在或不属于当前用户');
    }
    const rawStorageId =
      input.storageId === undefined || input.storageId === null
        ? ''
        : String(input.storageId).trim();
    if (rawStorageId && !mongoose.isValidObjectId(rawStorageId)) {
      throw new Error('storage not found');
    }
    return {
      name,
      harnessTypes: parseHarnessTypes(input.harnessTypes),
      workloadIds: parseWorkloadIds(input.workloadIds),
      createDefaultSession: input.createDefaultSession !== false,
      githubAccountId: rawAccountId || null,
      storageId: rawStorageId || null,
    };
  }

  async create(userId: string, input: CreateCloudHostInput): Promise<Doc> {
    this.assertFeature();
    this.assertConfigured();
    const { name, harnessTypes, workloadIds, createDefaultSession, githubAccountId, storageId } =
      this.validateInput(input);
    if (githubAccountId) {
      const account = await GitHubAccount.findOne({
        _id: githubAccountId,
        ...actorFilter(userId),
      }).lean();
      if (!account) throw new Error('Github 账号不存在或不属于当前用户');
    }

    // 读取 harness preset 先于任何落库（缺失时不留下半成品记录）
    const presets: HarnessPreset[] = [];
    for (const type of harnessTypes) {
      presets.push(await this.workloadReader.findHarnessPreset(type));
    }

    // 创建期负载展开同样先于落库：非法/超量/依赖环不留半成品
    const workloadPlan = await this.resolveWorkloadPlan(presets, workloadIds);

    const createWc = getWorkspaceContext();
    return withSpan(
      'cloudhost.create',
      {
        userId,
        tenantId: createWc?.tenantId ?? userId,
        workspaceId: createWc?.id ? String(createWc.id) : undefined,
      },
      () => this.userMutex.runExclusive(`user:${userId}`, async () => {
      // 多租户二期：计费 owner = 当前工作区所属租户（缺省上下文回退个人租户，与一期等价）
      const workspaceContext = getWorkspaceContext();
      const ownerTenantId = workspaceContext?.tenantId ?? userId;
      const ownerWorkspaceId = workspaceContext?.id ?? null;
      let account: { id: string };
      try {
        account = await billingClient.getAccount('tenant', ownerTenantId);
      } catch {
        throw new Error('billing service unavailable');
      }

      const cloudHostId = new mongoose.Types.ObjectId().toString();
      const controllerId = new mongoose.Types.ObjectId().toString();
      const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);
      const chargeKey = `cloud_host.create:${cloudHostId}`;

      // 存储占用先于扣费（计划期裁决 11）：校验/余额 → CAS IDLE/ARCHIVED→ATTACHING。
      // 失败不扣费、不落库；成功后的扣费失败在下方逆序释放。
      let attachment: Awaited<ReturnType<CloudStorageService['attachStorage']>> | null = null;
      if (storageId) {
        attachment = await this.storageService.attachStorage({
          storageId,
          cloudHostId,
          userId,
          controllerId,
        });
      }

      // 服务端权威扣费：先扣费再落库/拉起；余额不足直接外抛（不产生任何落库与账单）。
      try {
        await billingClient.createCharge({
          accountId: account.id,
          productId: 'cloud_host.create',
          quantity: 1,
          idempotentKey: chargeKey,
          refType: 'cloud_host',
          refId: cloudHostId,
          description: `创建云电脑 ${name}`,
        });
      } catch (err) {
        if (attachment) {
          await this.storageService
            .releaseStorage(storageId as string, cloudHostId)
            .catch(() => undefined);
        }
        if (err instanceof InsufficientBalanceError) throw new Error('insufficient balance');
        if (err instanceof BillingServiceUnavailableError) {
          throw new Error('billing service unavailable');
        }
        throw err;
      }

      let keyId: string | null = null;
      let workspaceId: string | null = null;
      let modelKeyId: string | null = null;
      let containerStarted = false;

      try {
        const createdKey = await controllerKeyService.createForCloudHost(
          userId,
          controllerId,
          name,
        );
        keyId = String(createdKey.key.id);

        await controllerService.createCloudHostController(userId, controllerId, name, keyId);

        // 创建期不再预置 /home/worker/workspace：默认工作区只在「Git 项目设置」初始化
        // Github 项目时由 setup 按 targetPath 幂等创建（ensureWorkspace），
        // 因此 workspaceId 保持 null 落库，就绪后也不会自动建默认会话。

        await CloudHost.create({
          _id: cloudHostId,
          userId,
          name,
          harnessTypes,
          status: 'STARTING',
          controllerId,
          keyId,
          workspaceId,
          resourceWorkspaceId: ownerWorkspaceId,
          createDefaultSession,
          githubAccountId,
          storageId,
          startedAt: new Date(),
        });

        const models = await modelService.findAll();
        const modelIds = Array.from(
          new Set(
            models
              .filter((model) => (model as { isEnabled?: boolean }).isEnabled !== false)
              .map((model) => String((model as { name?: string }).name ?? '').trim())
              .filter(Boolean),
          ),
        );
        // 模型 ID → 最长上下文快照（同名保留首个有效值；未设置 contextLength 的模型不出现）。
        const modelContextLengths: Record<string, number> = {};
        for (const model of models) {
          if ((model as { isEnabled?: boolean }).isEnabled === false) continue;
          const name = String((model as { name?: string }).name ?? '').trim();
          if (!name || modelContextLengths[name] !== undefined) continue;
          const contextLength = (model as { contextLength?: number | null }).contextLength;
          if (typeof contextLength === 'number' && Number.isInteger(contextLength) && contextLength > 0) {
            modelContextLengths[name] = contextLength;
          }
        }

        const modelKey = await billingClient.createCloudHostApiKey({
          accountId: account.id,
          ownerType: 'tenant',
          ownerId: ownerTenantId,
          name: `cloud-host:${name}`.slice(0, 64),
          cloudHostId,
        });
        modelKeyId = modelKey.apiKey.id;

        const container = await this.controllerClient
          .startHarness({
            hostId: cloudHostId,
            controllerId,
            controllerKeyId: keyId,
            containerApiKeyId: modelKeyId,
            userId,
            tenantId: ownerTenantId,
            workspaceId: ownerWorkspaceId,
            hostName: name,
            harnessTypes: harnessTypes.map((type) => harnessSlug(type)),
            expiresAt,
            billingAccountId: account.id,
            agentGearMinVersion: resolveAgentGearMinVersion(harnessTypes),
            workloadPlan,
            ...(attachment
              ? { storage: this.buildStoragePayload(attachment.storage, attachment.fromStatus) }
              : {}),
            secrets: {
              hostEndpoint: config.controllerApiPublicEndpoint,
              hostKey: createdKey.rawKey,
              modelApiKey: modelKey.secret,
              modelBaseUrl: config.cloudHostModelBaseUrl,
              modelIds: JSON.stringify(modelIds),
              modelContextLengths: JSON.stringify(modelContextLengths),
              defaultWorkspace: config.cloudHostDefaultWorkspace,
            },
          })
          .catch(() => {
            // 创建/网络/响应异常统一映射为控制面不可用（契约错误文案）
            throw new CloudControllerUnavailableError();
          });
        // cloud-controller 成功返回后不再回滚（后续异常由 terminal/TTL 兜底）
        containerStarted = true;

        // A-1：CAS 回写 containerId。若并发 stop 已推进状态（CAS 未命中），
        // 容器已经真实启动，必须立即回收，避免孤儿容器持续计费与 containerId 丢失。
        const updated = await CloudHost.findOneAndUpdate(
          { _id: cloudHostId, status: 'STARTING' },
          { $set: { containerId: container.id } },
          { returnDocument: 'after' },
        ).lean();
        if (!updated) {
          await this.reclaimStartedContainer(cloudHostId, container.id);
          if (attachment) {
            await this.storageService
              .releaseStorage(storageId as string, cloudHostId)
              .catch(() => undefined);
          }
          const current = await CloudHost.findById(cloudHostId).lean();
          if (!current) throw new Error('Cloud host not found');
          return this.mapCloudHost(current as Doc, 0);
        }
        if (attachment) {
          await this.storageService
            .recordContainer(storageId as string, cloudHostId, container.id)
            .catch(() => undefined);
          await this.storageService
            .markAttached(storageId as string, cloudHostId)
            .catch((err) => {
              logger.warn(
                { event: 'storage-attach-confirm-failed', cloudHostId, err },
                'confirm storage attached failed',
              );
            });
        }
        return this.mapCloudHost(updated as Doc, 0);
      } catch (err) {
        if (!containerStarted) {
          // 无机器不收费：拉起/落库失败时先退款（best-effort，幂等），再回滚半成品。
          await billingClient
            .refundCharge({
              idempotentKey: chargeKey,
              refundKey: `cloud_host.create.refund:${cloudHostId}`,
              reason: (err as Error)?.message || 'create failed',
            })
            .catch((refundErr) => {
              logger.warn(
                { event: 'refund-create-charge-failed', err: refundErr },
                'refund create charge failed',
              );
            });
          await this.rollback({
            userId,
            cloudHostId,
            controllerId,
            keyId,
            workspaceId,
          });
          if (attachment) {
            await this.storageService
              .releaseStorage(storageId as string, cloudHostId)
              .catch((releaseErr) => {
                logger.warn(
                  { event: 'storage-release-rollback-failed', cloudHostId, err: releaseErr },
                  'release storage on rollback failed',
                );
              });
          }
        }
        if (err instanceof CloudControllerUnavailableError) {
          throw new Error('control plane unavailable');
        }
        if (err instanceof BillingServiceUnavailableError) {
          throw new Error('billing service unavailable');
        }
        throw err;
      }
      }),
    );
  }

  /** 创建失败逆序回滚（best-effort；原始错误优先，回滚失败只记录日志）。 */
  private buildStoragePayload(
    storage: Doc,
    fromStatus: 'IDLE' | 'ARCHIVED',
  ): {
    id: string;
    pvcName: string;
    sizeGi: number;
    workspaceId: string;
    storageClass?: string | null;
    restore?: { archivePath: string } | null;
  } {
    const archive = storage.currentArchive as Doc | null;
    const restorePath =
      fromStatus === 'ARCHIVED' && archive?.path ? String(archive.path) : null;
    return {
      id: String(storage._id),
      pvcName: String(storage.pvcName),
      sizeGi: Number(storage.sizeGi),
      workspaceId: String(storage.resourceWorkspaceId),
      ...(storage.storageClass ? { storageClass: String(storage.storageClass) } : {}),
      ...(restorePath ? { restore: { archivePath: restorePath } } : {}),
    };
  }

  private async rollback(input: {
    userId: string;
    cloudHostId: string;
    controllerId: string;
    keyId: string | null;
    workspaceId: string | null;
  }): Promise<void> {
    const tasks: Array<Promise<unknown>> = [
      billingClient.revokeApiKeysByHost(input.cloudHostId).catch((err) => {
        logger.warn({ event: 'revoke-key-rollback-failed', err }, 'revoke model key on rollback failed');
      }),
    ];
    if (input.workspaceId) {
      tasks.push(ControllerWorkspace.deleteOne({ _id: input.workspaceId }));
    }
    tasks.push(Controller.deleteOne({ _id: input.controllerId }));
    if (input.keyId) {
      tasks.push(evictKeyById(input.keyId));
      tasks.push(ControllerKey.deleteOne({ _id: input.keyId }));
    }
    tasks.push(CloudHost.deleteOne({ _id: input.cloudHostId }));
    await Promise.allSettled(tasks);
  }

  /** 创建期负载计划：无勾选时与历史一致（仅 harness）；有勾选时展开依赖。 */
  private async resolveWorkloadPlan(
    presets: HarnessPreset[],
    workloadIds: string[],
  ): Promise<CreateWorkloadPlanEntry[]> {
    // harness 为可选工作负载：安装失败不硬失败销毁容器，可事后在设置-工作负载补装。
    const harnessPlan: CreateWorkloadPlanEntry[] = presets.map((preset) => ({
      workloadId: preset.id,
      params: {},
      implicit: false,
      required: false,
    }));
    if (workloadIds.length === 0) return harnessPlan;

    const standardCatalog = await this.catalog.listStandard();
    const standardIds = new Set(standardCatalog.map((item) => item.id));
    for (const id of workloadIds) {
      if (standardIds.has(id)) continue;
      if (!mongoose.isValidObjectId(id)) throw new Error(`invalid workload: ${id}`);
      const found = await this.catalog.findById(id);
      if (!found) throw new Error(`invalid workload: ${id}`);
      throw new Error(`workload is not installable: ${found.name}`);
    }

    return resolveCreateWorkloadPlan({
      harnessPresets: presets.map((preset) => ({ id: preset.id })),
      selectedIds: workloadIds,
      standardCatalog,
    });
  }

  async list(userId: string): Promise<Doc[]> {
    const hosts = await CloudHost.find({ ...actorFilter(userId), deletedAt: null })
      .sort({ createdAt: -1 })
      .lean();
    if (hosts.length === 0) return [];
    const counts = await Promise.all(
      hosts.map((host) =>
        Session.countDocuments({
          controllerId: host.controllerId,
          ...actorFilter(userId),
          status: { $ne: 'ended' },
        }),
      ),
    );
    return hosts.map((host, index) => this.mapCloudHost(host, counts[index] ?? 0));
  }

  async stopImpact(id: string, userId: string): Promise<CloudHostStopImpact> {
    const host = await this.findOwnedHost(id, userId);
    const sessions = await Session.find({
      controllerId: String(host.controllerId),
      ...actorFilter(userId),
      status: { $ne: 'ended' },
    })
      .sort({ createdAt: -1 })
      .lean();
    const storageId = host.storageId ? String(host.storageId) : null;
    const storage = storageId ? await this.storageService.getSummary(storageId) : null;
    return {
      activeSessionCount: sessions.length,
      sessionsWillBeLost: sessions.length > 0,
      sessions: sessions.map((session) => ({
        id: String(session._id),
        title: String(session.title ?? ''),
        status: String(session.status ?? ''),
        acpServerType: String(session.acpServerType ?? ''),
      })),
      storage,
    };
  }

  /** A-1：创建侧 CAS 未命中（已被并发 stop）时回收已启动容器与模型 Key（幂等、best-effort）。 */
  private async reclaimStartedContainer(cloudHostId: string, containerId: string): Promise<void> {
    await Promise.allSettled([
      Promise.resolve(this.controllerClient.destroyContainer(containerId)).catch((err) => {
        logger.warn({ event: 'destroy-orphan-failed', err }, 'destroy orphan container failed');
      }),
      Promise.resolve(billingClient.revokeApiKeysByHost(cloudHostId)).catch((err) => {
        logger.warn({ event: 'revoke-key-orphan-failed', err }, 'revoke model key on orphan reclaim failed');
      }),
    ]);
  }

  async stop(
    id: string,
    userId: string,
    force?: boolean,
    archiveStorage?: boolean | null,
  ): Promise<Doc> {
    return withSpan('cloudhost.destroy', { cloudHostId: id, userId }, () =>
      this.hostMutex.runExclusive(`host:${id}`, async () => {
      const host = await this.findOwnedHost(id, userId);
      if (host.status === 'STOPPED' || host.status === 'FAILED') {
        return this.mapCloudHost(host as unknown as Doc, await this.countActive(host));
      }

      // A-9：先 CAS STOPPING 再统计活动会话，关闭 stopImpact→stop 之间的 TOCTOU 窗口。
      const previousStatus = host.status;
      const stopping = await CloudHost.findOneAndUpdate(
        { _id: id, ...actorFilter(userId), status: { $in: ACTIVE_STATUSES } },
        { $set: { status: 'STOPPING' } },
        { returnDocument: 'after' },
      ).lean();
      if (!stopping) {
        const current = await this.findOwnedHost(id, userId);
        if (current.status === 'STOPPED' || current.status === 'FAILED') {
          return this.mapCloudHost(current, 0);
        }
        throw new Error('control plane unavailable');
      }

      const activeCount = await this.countActive(stopping as Doc);
      if (activeCount > 0 && force !== true) {
        // 未确认强制停止：回滚到停止前状态，保持可继续使用。
        await CloudHost.updateOne(
          { _id: id, ...actorFilter(userId), status: 'STOPPING' },
          { $set: { status: previousStatus } },
        );
        throw new Error(
          'stopping this cloud host will permanently lose all active sessions',
        );
      }

      await sessionService.endByController(String(host.controllerId), userId);

      // A-1：使用 CAS 后的最新快照决定是否销毁；创建侧并发回写已由 CAS 串行化。
      const containerId = (stopping as Doc).containerId;
      if (containerId) {
        try {
          // D4：仅「挂载云存储 + 显式不归档」时下发 `storageArchive:false`；
          // true/缺省/未挂载保持旧报文形状（逐字段等价，含调用参数形态）。
          const storageId = (stopping as Doc).storageId;
          if (storageId && archiveStorage === false) {
            await this.controllerClient.destroyContainer(String(containerId), {
              storageArchive: false,
            });
          } else {
            await this.controllerClient.destroyContainer(String(containerId));
          }
        } catch {
          // 停止失败保持 STOPPING 可重试；会话已 ENDED 不回滚
          throw new Error('control plane unavailable');
        }
      }

      await billingClient.revokeApiKeysByHost(id).catch((err) => {
        logger.warn({ event: 'revoke-key-stop-failed', err }, 'revoke model key on stop failed');
      });

      const stopped = await CloudHost.findOneAndUpdate(
        { _id: id, ...actorFilter(userId), status: 'STOPPING' },
        {
          $set: {
            status: 'STOPPED',
            stoppedAt: new Date(),
            containerId: null,
          },
        },
        { returnDocument: 'after' },
      ).lean();
      const latest = stopped ?? (await this.findOwnedHost(id, userId));
      // A-3：终态 CAS 后再兜一次，回收 CAS 与 Session.create 之间漏网的晚到会话。
      await sessionService.endByController(String(host.controllerId), userId);
      return this.mapCloudHost(latest, 0);
      }),
    );
  }

  async delete(id: string, userId: string): Promise<boolean> {
    return withSpan('cloudhost.destroy', { cloudHostId: id, userId }, () =>
      this.hostMutex.runExclusive(`host:${id}`, async () => {
      if (!mongoose.isValidObjectId(id)) {
        throw new Error('Cloud host not found');
      }
      const host = await CloudHost.findOne({ _id: id, ...actorFilter(userId) }).lean();
      if (!host) throw new Error('Cloud host not found');
      if (host.deletedAt) return true;
      if (host.status !== 'STOPPED' && host.status !== 'FAILED') {
        throw new Error('stop the cloud host before deleting');
      }

      await billingClient.revokeApiKeysByHost(id).catch((err) => {
        logger.warn({ event: 'revoke-key-delete-failed', err }, 'revoke model key on delete failed');
      });

      const keyId = String(host.keyId);
      try {
        await evictKeyById(keyId);
      } catch (err) {
        logger.warn({ event: 'evict-controller-key-failed', err }, 'evict controller key failed');
      }
      await ControllerKey.deleteOne({ _id: keyId });
      await controllerService.markCloudHostOffline(String(host.controllerId), userId);
      await CloudHost.updateOne({ _id: id }, { $set: { deletedAt: new Date() } });
      // Issues 联动配置随云电脑销毁失效（标签是否清理由前端销毁确认流程调用 cleanup）
      await cloudHostIssuesLinkageService.deleteByController(String(host.controllerId)).catch((err) => {
        logger.warn({ event: 'cascade-delete-linkages-failed', err }, 'cascade delete issues linkages failed');
      });
      // 项目来源（REPO）已配置工作流随云电脑销毁失效（best-effort；PLATFORM 来源零影响）
      await configuredWorkflowService.deleteRepoScopedByController(String(host.controllerId)).catch((err) => {
        logger.warn({ event: 'cascade-delete-repo-workflows-failed', err }, 'cascade delete repo workflows failed');
      });
      return true;
      }),
    );
  }

  /** 内部 ready 回调：STARTING→RUNNING；单 harness 自动创建默认会话（幂等，per-host 串行）。 */
  async handleReady(id: string): Promise<Doc | null> {
    return withSpan('cloudhost.start', { cloudHostId: id }, () =>
      this.hostMutex.runExclusive(`host:${id}`, () => this.handleReadyLocked(id)),
    );
  }

  private async handleReadyLocked(id: string): Promise<Doc | null> {
    const host = await this.findRawHost(id);
    if (!host) return null;
    if (host.status === 'STOPPED' || host.status === 'FAILED' || host.status === 'STOPPING') {
      return this.mapCloudHost(host, await this.countActive(host));
    }

    // R2-5：单 harness 默认会话在 STARTING 窗口内创建（内部允许 STARTING），随后与
    // RUNNING/readyAt 合并为一次 CAS 落库；前端永远不会观测到「RUNNING + defaultSessionId=null」
    // 的中间态，消除自动进入丢失与误报失败提示的竞态。
    if (host.status === 'STARTING') {
      const harnessTypes = (host.harnessTypes ?? []) as HarnessType[];
      const wantsDefaultSession = host.createDefaultSession !== false;
      let defaultSessionId: string | null = null;
      // 自动建会话需同时满足：单 Harness + 允许默认会话 + 已有工作区（会话必须绑定工作区）
      if (harnessTypes.length === 1 && wantsDefaultSession && host.workspaceId) {
        try {
          const session = await sessionService.create(String(host.userId), {
            controllerId: String(host.controllerId),
            workspaceId: String(host.workspaceId),
            resourceWorkspaceId: host.resourceWorkspaceId
              ? String(host.resourceWorkspaceId)
              : undefined,
            acpServerType: HARNESS_ACP_TYPES[harnessTypes[0]] ?? 'opencode',
            allowStartingCloudHost: true,
          });
          defaultSessionId = session.id as string;
        } catch (err) {
          // 默认会话失败不影响云电脑可用；前端提示可手动创建
          logger.warn(
            { event: 'create-default-session-failed', cloudHostId: id, err },
            'create default session failed',
          );
        }
      } else if (harnessTypes.length === 1) {
        logger.info(
          {
            event: 'skip-default-session',
            cloudHostId: id,
            reason: host.workspaceId ? 'createDefaultSession=false' : 'no default workspace',
          },
          'skip default session',
        );
      }

      const updated = await CloudHost.findOneAndUpdate(
        { _id: id, deletedAt: null, status: 'STARTING' },
        {
          $set: {
            status: 'RUNNING',
            readyAt: new Date(),
            ...(defaultSessionId ? { defaultSessionId } : {}),
          },
        },
        { returnDocument: 'after' },
      ).lean();
      const fetched = updated ?? (await this.findRawHost(id));
      if (!fetched) return null;
      await this.confirmStorageAttached(fetched as Doc);
      return this.mapCloudHost(fetched as Doc, await this.countActive(fetched as Doc));
    }

    // 已 RUNNING 的重复 ready（历史遗留/回调重试）：仅在缺默认会话时补建，不改变状态。
    let current = host;
    const harnessTypes = (current.harnessTypes ?? []) as HarnessType[];
    if (
      harnessTypes.length === 1 &&
      current.createDefaultSession !== false &&
      current.workspaceId &&
      !current.defaultSessionId
    ) {
      try {
        const session = await sessionService.create(String(current.userId), {
          controllerId: String(current.controllerId),
          workspaceId: String(current.workspaceId),
          resourceWorkspaceId: current.resourceWorkspaceId
            ? String(current.resourceWorkspaceId)
            : undefined,
          acpServerType: HARNESS_ACP_TYPES[harnessTypes[0]] ?? 'opencode',
        });
        await CloudHost.updateOne(
          { _id: id, defaultSessionId: null },
          { $set: { defaultSessionId: session.id } },
        );
        current.defaultSessionId = session.id;
      } catch (err) {
        logger.warn(
          { event: 'create-default-session-failed', cloudHostId: id, err },
          'create default session failed',
        );
      }
    } else if (harnessTypes.length === 1 && !current.defaultSessionId) {
      logger.info(
        {
          event: 'skip-default-session',
          cloudHostId: id,
          reason: current.workspaceId ? 'createDefaultSession=false' : 'no default workspace',
        },
        'skip default session',
      );
    }
    const refreshed = (await this.findRawHost(id)) ?? current;
    await this.confirmStorageAttached(refreshed);
    return this.mapCloudHost(refreshed, await this.countActive(refreshed));
  }

  /** 内部 terminal 回调：驱动 STOPPED/FAILED + 会话 ENDED + 撤销模型 Key（幂等，per-host 串行）。 */
  async handleTerminal(id: string, input: TerminalCallbackInput): Promise<Doc | null> {
    return withSpan('cloudhost.destroy', { cloudHostId: id }, () =>
      this.hostMutex.runExclusive(`host:${id}`, () => this.handleTerminalLocked(id, input)),
    );
  }

  private async handleTerminalLocked(
    id: string,
    input: TerminalCallbackInput,
  ): Promise<Doc | null> {
    const host = await this.findRawHost(id);
    if (!host) return null;
    if (host.status === 'STOPPED' || host.status === 'FAILED') {
      // A-4：早退分支仍需幂等补做副作用收尾（回调重试可能命中早退）。
      await this.refundUnreadyHost(host, id, 'cloud host terminal before ready (retry)');
      await this.syncStorageOnTerminal(host, id, input);
      await sessionService.endByController(String(host.controllerId), String(host.userId));
      await billingClient.revokeApiKeysByHost(id).catch((err) => {
        logger.warn({ event: 'revoke-key-terminal-retry-failed', err }, 'revoke model key on terminal retry failed');
      });
      return this.mapCloudHost(host, 0);
    }

    const target = input.status === 'failed' ? 'FAILED' : 'STOPPED';
    const updated = await CloudHost.findOneAndUpdate(
      { _id: id, status: { $in: ACTIVE_STATUSES } },
      {
        $set: {
          status: target,
          stoppedAt: new Date(),
          containerId: null,
          failureReason: target === 'FAILED' ? input.reason ?? 'cloud host failed' : null,
        },
      },
      { returnDocument: 'after' },
    ).lean();
    const current = updated ?? (await this.findRawHost(id));
    if (!current) return null;

    await this.refundUnreadyHost(current, id, input.reason ?? 'cloud host terminal before ready');
    await this.syncStorageOnTerminal(current, id, input);
    await sessionService.endByController(String(current.controllerId), String(current.userId));
    await billingClient.revokeApiKeysByHost(id).catch((err) => {
      logger.warn({ event: 'revoke-key-terminal-failed', err }, 'revoke model key on terminal failed');
    });
    // A-3：终态 CAS 后再兜一次，确保晚到创建的会话也被结束。
    await sessionService.endByController(String(current.controllerId), String(current.userId));
    return this.mapCloudHost(current, 0);
  }

  /** 未就绪即终态：退回一次性创建费（best-effort 幂等；已 ready 的销毁不退款）。 */
  private async refundUnreadyHost(host: Doc, id: string, reason: string): Promise<void> {
    if (host.readyAt) return;
    await billingClient
      .refundCharge({
        idempotentKey: `cloud_host.create:${id}`,
        refundKey: `cloud_host.create.refund:${id}`,
        reason,
      })
      .catch((err) => {
        logger.warn({ event: 'refund-terminal-failed', err }, 'refund create charge on terminal failed');
      });
  }

  /** ready 幂等兜底：`ATTACHING → ATTACHED`（已 ATTACHED 时不重复推进）。 */
  private async confirmStorageAttached(host: Doc): Promise<void> {
    const storageId = host.storageId ? String(host.storageId) : null;
    if (!storageId) return;
    await this.storageService.markAttached(storageId, String(host._id ?? '')).catch((err) => {
      logger.warn(
        { event: 'storage-attach-confirm-failed', cloudHostId: String(host._id ?? ''), err },
        'confirm storage attached failed',
      );
    });
  }

  /**
   * terminal 回调的存储联动：
   * - 未 ready 即终态：释放存储回 `attachFromStatus`（不留「已挂载」）；
   * - 已 ready 且归档已开始（pending/running）：`ATTACHED → ARCHIVING`。
   */
  private async syncStorageOnTerminal(
    host: Doc,
    id: string,
    input: TerminalCallbackInput,
  ): Promise<void> {
    const storageId = input.storage?.id
      ? String(input.storage.id)
      : host.storageId
        ? String(host.storageId)
        : null;
    if (!storageId) return;
    try {
      if (!host.readyAt) {
        await this.storageService.releaseStorage(storageId, id);
        return;
      }
      // D3：显式跳过归档（destroy storageArchive:false）→ 恒回 IDLE（保留数据与全价），
      // 不回滚到 attachFromStatus（避免把未归档的新数据错误表达为「内容=归档」）。
      if (input.storage?.archiveSkipped === true) {
        await this.storageService.detachToIdle(storageId, id);
        return;
      }
      const archiveStatus = input.storage?.archiveStatus;
      if (archiveStatus === 'pending' || archiveStatus === 'running') {
        await this.storageService.markArchiving(
          storageId,
          id,
          input.storage?.archiveId ? String(input.storage.archiveId) : null,
        );
        return;
      }
      // succeeded/failed/null：回调可能丢失，按最近容器查询归档终态补齐；
      // 无归档可收口时释放存储，避免永久卡在「已挂载」（不可销毁/不可再挂载）。
      const reconciled = await this.storageService.reconcileFromTerminal(
        storageId,
        host.containerId ? String(host.containerId) : null,
      );
      if (!reconciled) {
        await this.storageService.releaseStorage(storageId, id);
      }
    } catch (err) {
      logger.warn(
        { event: 'storage-terminal-sync-failed', cloudHostId: id, storageId, err },
        'sync storage on terminal failed',
      );
    }
  }

  /** 内部路由用于区分「不存在」「非云电脑」。 */
  async findRawHost(id: string): Promise<Doc | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    return (await CloudHost.findOne({ _id: id, deletedAt: null }).lean()) as Doc | null;
  }

  /** 按 controllerId 查找云主机（凭据接口 / MCP 会话解析）。 */
  async findRawHostByController(controllerId: string): Promise<Doc | null> {
    if (!mongoose.isValidObjectId(controllerId)) return null;
    return (await CloudHost.findOne({
      controllerId,
      deletedAt: null,
    }).lean()) as Doc | null;
  }

  /** 用户拥有的云主机（按 controllerId），不存在/非本人返回 null。 */
  async findOwnedRawHostByController(
    controllerId: string,
    userId: string,
  ): Promise<Doc | null> {
    if (!mongoose.isValidObjectId(controllerId)) return null;
    return (await CloudHost.findOne({
      controllerId,
      ...actorFilter(userId),
      deletedAt: null,
    }).lean()) as Doc | null;
  }

  /** 默认工作区路径（workspaceId → ControllerWorkspace.path；缺失回退配置默认值）。 */
  async defaultWorkspace(host: Doc): Promise<string> {
    const workspaceId = host.workspaceId ? String(host.workspaceId) : '';
    if (!workspaceId) return config.cloudHostDefaultWorkspace;
    const filter = getWorkspaceContext()
      ? { _id: workspaceId, controllerId: host.controllerId }
      : { _id: workspaceId, userId: host.userId };
    const workspace = await ControllerWorkspace.findOne(filter as any).lean();
    return workspace?.path ? String(workspace.path) : config.cloudHostDefaultWorkspace;
  }

  private async findOwnedHost(id: string, userId: string): Promise<Doc> {
    if (!mongoose.isValidObjectId(id)) {
      throw new Error('Cloud host not found');
    }
    const host = await CloudHost.findOne({ _id: id, ...actorFilter(userId), deletedAt: null }).lean();
    if (!host) throw new Error('Cloud host not found');
    return host as Doc;
  }

  private async countActive(host: Doc): Promise<number> {
    return Session.countDocuments({
      controllerId: String(host.controllerId),
      ...actorFilter(String(host.userId)),
      status: { $ne: 'ended' },
    });
  }

  mapCloudHost(host: Doc, activeSessionCount = 0): Doc {
    return {
      id: String(host._id ?? host.id),
      name: host.name,
      controllerId: String(host.controllerId),
      status: host.status,
      harnessTypes: (host.harnessTypes ?? []) as string[],
      defaultSessionId: host.defaultSessionId ? String(host.defaultSessionId) : null,
      activeSessionCount,
      containerId: host.containerId ?? null,
      createdAt: iso(host.createdAt) ?? new Date(0).toISOString(),
      readyAt: iso(host.readyAt),
      stoppedAt: iso(host.stoppedAt),
      failureReason: host.failureReason ?? null,
      deletedAt: iso(host.deletedAt),
      githubAccountId: host.githubAccountId ? String(host.githubAccountId) : null,
      // 契约 CloudHost.workspaceId = 租户工作区（模型字段 resourceWorkspaceId，计划期裁决对齐 F1）
      workspaceId: host.resourceWorkspaceId ? String(host.resourceWorkspaceId) : null,
      hasDefaultWorkspace: Boolean(host.workspaceId),
      // CloudHost.storage / storageRestoring 的字段级 resolver 数据源
      storageId: host.storageId ? String(host.storageId) : null,
    };
  }
}

/** 契约允许透传的错误文案（B19：未知异常统一 internal error，避免泄露 Mongo/驱动信息）。 */
const CLOUD_HOST_PUBLIC_ERRORS = new Set([
  'name is required',
  'name is too long',
  'insufficient balance',
  'harness feature is disabled',
  'cloud host is not configured',
  'control plane unavailable',
  'billing service unavailable',
  'Github 账号不存在或不属于当前用户',
  'github account is locked',
  'Cloud host not found',
  'cloud host is not running',
  'stop the cloud host before deleting',
  'stopping this cloud host will permanently lose all active sessions',
  'session is ended',
  // 云存储（创建云电脑挂载）
  'storage feature is disabled',
  'storage not found',
  'storage is not attachable',
  'storage size must be between 1 and 30 Gi',
  'global workspace is read-only',
  // Issues 联动配置
  'cloud host not found',
  'workflow must contain a human node',
  'invalid label name',
  'at least one repo is required',
  'too many repos',
  'linkage not found',
]);

/** 供 resolver 统一把 service 错误转为 GraphQLError（白名单透传契约文案）。 */
const CLOUD_HOST_PUBLIC_ERROR_PREFIXES = [
  'unsupported harness type:',
  'invalid workload:',
  'workload is not installable:',
  'invalid workload parameter:',
  'dependency workload not found:',
  'dependency cycle detected',
  'too many workloads (max',
  'workloads exceed',
  '前缀地址',
  'label name already exists:',
  'repo not authorized:',
  'label sync failed:',
] as const;

export function toCloudHostGraphQLError(err: unknown): never {
  if (err instanceof GraphQLError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  if (
    CLOUD_HOST_PUBLIC_ERRORS.has(message) ||
    CLOUD_HOST_PUBLIC_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix))
  ) {
    throw new GraphQLError(message);
  }
  throw new GraphQLError('internal error');
}

export const cloudHostService = new CloudHostService();
