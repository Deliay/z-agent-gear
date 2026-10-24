import {
  isTerminalStatus,
  type CloudContainerPurpose,
  type CloudContainerStatus,
  type WorkloadPlanEntry,
} from '../models/cloud-container.js';
import type {
  CloudContainerEntity,
  ContainerRepository,
  UpdateContainerInput,
} from '../repositories/container-repository.js';
import type { K8sJobManager } from './k8s-job-manager.js';
import { computeActiveDeadlineSeconds } from './k8s-job-manager.js';
import { KeyedMutex } from './keyed-mutex.js';
import type { TokenService } from './token-service.js';
import { SecretStore, type HarnessSecrets } from './secret-store.js';

export class ContainerNotFoundError extends Error {
  constructor(public readonly containerId: string) {
    super(`Container not found: ${containerId}`);
    this.name = 'ContainerNotFoundError';
  }
}

export class UnsupportedPurposeError extends Error {
  constructor(message = '该任务类型暂未开放') {
    super(message);
    this.name = 'UnsupportedPurposeError';
  }
}

export class JobCreationError extends Error {
  constructor(
    public readonly containerId: string,
    reason: string,
    public readonly container: CloudContainerEntity | null,
  ) {
    super(reason);
    this.name = 'JobCreationError';
  }
}

export interface ContainerServiceConfig {
  namespace: string;
  image: string;
  connectTimeoutMs: number;
  shutdownGraceMs: number;
  /** agent-api 内部地址（harness Job env `ZAG_AGENT_API_ENDPOINT`；缺失则仅告警）。 */
  agentApiUrl?: string;
}

interface Logger {
  error?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

/** 允许被生命周期转移覆写的状态（非终态）。 */
const ACTIVE_STATUSES: readonly CloudContainerStatus[] = [
  'creating',
  'connecting',
  'initializing',
  'online',
];

/** 去重且保持选择顺序（契约：启动 `workloadIds` 去重、保序、≤10）。 */
export function dedupeWorkloadIds(ids: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids ?? []) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * 归一化执行计划条目：`params` 缺省 `{}`、`implicit` 缺省 false，并去掉空/非法 ID。
 * 数组顺序即执行顺序（由调用方/上游保证已展开、已排序）。
 */
export function normalizeWorkloadPlan(
  plan: readonly WorkloadPlanEntry[] | undefined | null,
): WorkloadPlanEntry[] {
  const result: WorkloadPlanEntry[] = [];
  for (const entry of plan ?? []) {
    if (!entry || typeof entry.workloadId !== 'string' || entry.workloadId.length === 0) continue;
    const params =
      entry.params && typeof entry.params === 'object' && !Array.isArray(entry.params)
        ? { ...(entry.params as Record<string, unknown>) }
        : {};
    result.push({
      workloadId: entry.workloadId,
      params,
      implicit: entry.implicit === true,
      required: entry.required === true,
    });
  }
  return result;
}

function randomSuffix(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DestroyResult {
  success: boolean;
  id: string;
  status: string;
  deletedJob: boolean;
}

export interface StartHarnessOptions {
  /**
   * 是否由 `workloadPlan` 派生容器 `workloadIds`（契约 A.2.2）。
   *
   * - `true`（默认）：请求显式下发 plan 时由 plan 派生（保序）；
   * - `false`：仅 `workloadIds` 的旧版请求，`workloadIds` 按选择顺序落库，
   *   `plan`（含兜底展开的隐式依赖）仅用于执行，避免与契约文字产生静默偏差。
   */
  deriveWorkloadIdsFromPlan?: boolean;
  /** 计费归属账户（费用中心）：非空时容器参与计费；缺省/空表示不计费。 */
  billingAccountId?: string | null;
  /** 云电脑 ID（`purpose=harness` 必填，由 internal-api 校验）。 */
  hostId?: string | null;
  /** 云电脑用户命名。 */
  hostName?: string | null;
  /** harness 类型列表（本期仅 `opencode`）。 */
  harnessTypes?: string[];
  /** 云电脑 controllerId（Job env `ZAG_CONTROLLER_ID`）。 */
  controllerId?: string | null;
  /** 标准连接使用的 ControllerKey ID。 */
  controllerKeyId?: string | null;
  /** 运行专用模型 Key ID。 */
  containerApiKeyId?: string | null;
  /** 云电脑最低 agent-gear 版本（已按 max(常量, 请求值) 收敛）。 */
  agentGearMinVersion?: string | null;
  /** 关联前台用户 ID。 */
  userId?: string | null;
  /** 容器 TTL 到期时间（harness；换算 Job activeDeadlineSeconds）。 */
  expiresAt?: Date | null;
  /** 云电脑运行期 secret（仅内存，不落库）。 */
  secrets?: HarnessSecrets | null;
}

/** 兼容既有调用方命名。 */
export type StartOptions = StartHarnessOptions;

/** 计费生命周期事件钩子（由 BillingEventPublisher 注入；不阻塞生命周期）。 */
export interface ContainerServiceHooks {
  onReady?: (container: CloudContainerEntity) => void | Promise<void>;
  onDestroyed?: (container: CloudContainerEntity) => void | Promise<void>;
}

/**
 * 容器生命周期状态机编排：
 * creating → connecting → online → destroying → exited（失败终态 failed）。
 *
 * 状态写回一律带状态前置条件（CAS），并对同一容器串行化 start/destroy/回收操作，
 * 避免多链路交错产生状态错乱或孤儿 Job。
 */
export class ContainerService {
  private readonly shutdownHandlers = new Set<
    (containerId: string, reason?: string) => Promise<void> | void
  >();
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly repo: ContainerRepository,
    private readonly tokenService: TokenService,
    private readonly jobManager: K8sJobManager,
    private readonly cfg: ContainerServiceConfig,
    private readonly logger: Logger = console,
    private readonly hooks: ContainerServiceHooks = {},
    private readonly secretStore: SecretStore = new SecretStore(),
  ) {}

  /** 在途计费钩子（O-1：停机前必须排空，避免 outbox 写入被 SIGTERM 截断）。 */
  private readonly billingHookTasks = new Set<Promise<void>>();

  /**
   * 触发计费生命周期钩子：失败只告警，绝不阻断生命周期（裁决 2）。
   *
   * O-1：不再「fire-and-forget 后丢失」——
   * - 同步调用钩子（不退化为微任务，缩小 CAS 写成功→outbox 写入之间的窗口）；
   * - 失败重试：共 **3 次尝试**（首次 + 100ms、250ms 两次退避重试），仍失败记 **error** 日志；
   * - 在途任务登记到 `billingHookTasks`，`drainBillingHooks()` 供 SIGTERM 前排空；
   * - 长期丢失由 admin-api 反向对账线（扫描 billingStartedAt≠null 且未生效的容器）补投。
   */
  private emitHook(
    name: 'onReady' | 'onDestroyed',
    container: CloudContainerEntity,
  ): void {
    const hook = this.hooks[name];
    if (!hook) return;
    const task = (async () => {
      const delays = [0, 100, 250];
      let lastError: unknown;
      for (const delay of delays) {
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        try {
          await hook(container);
          return;
        } catch (err) {
          lastError = err;
        }
      }
      this.logger.error?.(`[billing] ${name} hook failed for ${container.id}`, lastError);
    })();
    this.billingHookTasks.add(task);
    void task.finally(() => this.billingHookTasks.delete(task));
  }

  /** O-1：排空在途计费钩子（SIGTERM / 单测）。超时后放弃并告警，交给反向对账兜底。 */
  async drainBillingHooks(timeoutMs = 5000): Promise<void> {
    if (this.billingHookTasks.size === 0) return;
    const pending = [...this.billingHookTasks];
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.logger.warn?.(`[billing] drain hooks timeout with ${this.billingHookTasks.size} pending`);
        resolve();
      }, timeoutMs);
      timer.unref?.();
    });
    await Promise.race([Promise.allSettled(pending).then(() => undefined), timeout]);
  }

  /** 注册销毁通知（由 Socket.IO 网关接入，用于向在线容器 emit shutdown）。 */
  onShutdown(
    handler: (containerId: string, reason?: string) => Promise<void> | void,
  ): () => void {
    this.shutdownHandlers.add(handler);
    return () => this.shutdownHandlers.delete(handler);
  }

  /**
   * 依次执行销毁通知处理器（串行 await）：网关在 handler 内先下发并等待 post 脚本批次，
   * 再 emit shutdown（契约 §2.8）。单个 handler 失败只告警，不阻断后续删除 Job 流程。
   */
  private async notifyShutdown(containerId: string, reason?: string): Promise<void> {
    for (const handler of this.shutdownHandlers) {
      try {
        await handler(containerId, reason);
      } catch (err) {
        this.logger.warn?.(`shutdown handler failed for ${containerId}`, err);
      }
    }
  }

  /** 带状态前置条件的写入：条件不满足（已被并发转移/进入终态）时回读最新记录。 */
  private async updateGuarded(
    containerId: string,
    patch: UpdateContainerInput,
  ): Promise<CloudContainerEntity | null> {
    const updated = await this.repo.update(containerId, patch, {
      fromStatuses: [...ACTIVE_STATUSES],
    });
    if (updated) return updated;
    return this.repo.findById(containerId);
  }

  /**
   * 若 Job 仍存在则删除；区分「Job 不存在（absent）」与「删除失败（failed）」：
   * 卡死的 `destroying` 记录即便 Job 已不存在也需迁移 `exited`，故必须能区分二者。
   */
  private async deleteJobIfExistsDetailed(
    name: string,
  ): Promise<'deleted' | 'absent' | 'failed'> {
    let exists: boolean;
    try {
      exists = (await this.jobManager.getJob(name)) !== null;
    } catch (err) {
      this.logger.error?.(`Failed to check job ${name}`, err);
      return 'failed';
    }
    if (!exists) return 'absent';
    try {
      await this.jobManager.deleteJob(name);
      return 'deleted';
    } catch (err) {
      this.logger.error?.(`Failed to delete residual job ${name}`, err);
      return 'failed';
    }
  }

  /**
   * 启动容器：① 落库 creating → ② 签发 token → ③ 创建 Job → ④ 成功 connecting / 失败 failed。
   * 全程持有该容器的串行锁，且在 creating→connecting 时做状态前置校验：若记录已被并发
   * 销毁/置终态，则回收刚创建的 Job，避免孤儿资源。
   *
   * 执行计划（契约 A.2.2 / 裁决 5）：携带非空 `workloadPlan` 时优先落库该计划；当
   * `deriveWorkloadIdsFromPlan` 为 true（请求显式下发 plan）时由 plan 派生 `workloadIds`
   * （保序），否则（仅 `workloadIds` 的旧版请求）按选择顺序落库 `workloadIds`、plan 仅用于执行。
   */
  async start(
    purpose: CloudContainerPurpose,
    refId: string | null = null,
    workloadIds: readonly string[] = [],
    workloadPlan: readonly WorkloadPlanEntry[] | null = null,
    options: StartHarnessOptions = {},
  ): Promise<CloudContainerEntity> {
    if (purpose !== 'idle' && purpose !== 'harness') {
      throw new UnsupportedPurposeError();
    }

    const plan = normalizeWorkloadPlan(workloadPlan);
    const deriveFromPlan = options.deriveWorkloadIdsFromPlan ?? true;
    const effectiveWorkloadIds =
      deriveFromPlan && plan.length > 0
        ? dedupeWorkloadIds(plan.map((entry) => entry.workloadId))
        : dedupeWorkloadIds(workloadIds);

    const name = `zag-worker-${randomSuffix(6)}`;
    const created = await this.repo.create({
      name,
      namespace: this.cfg.namespace,
      purpose,
      image: this.cfg.image,
      refId: refId ?? null,
      userId: options.userId ?? null,
      hostId: options.hostId ?? null,
      hostName: options.hostName ?? null,
      harnessTypes: options.harnessTypes ?? [],
      controllerKeyId: options.controllerKeyId ?? null,
      containerApiKeyId: options.containerApiKeyId ?? null,
      agentGearMinVersion: options.agentGearMinVersion ?? null,
      expiresAt: options.expiresAt ?? null,
      status: 'creating',
      workloadIds: effectiveWorkloadIds,
      workloadPlan: plan,
      billingAccountId: options.billingAccountId ?? null,
    });

    // 云电脑 secret 仅内存持有（不落库、不打印）；Job/初始化下发需要它，失败时随终态清理。
    if (purpose === 'harness' && options.secrets) {
      this.secretStore.put(created.id, options.secrets);
    }

    try {
      return await this.mutex.runExclusive(created.id, async () => {
        const token = await this.tokenService.issue(created.id);

        try {
          await this.jobManager.createJob({
            jobName: name,
            containerId: created.id,
            token,
            ...(purpose === 'harness'
              ? {
                  activeDeadlineSeconds: computeActiveDeadlineSeconds(options.expiresAt),
                  env: this.buildHarnessJobEnv(options),
                }
              : {}),
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          // R7：统一走 markFailed（含终态钩子一致性），不再裸写 failed。
          const failed = await this.markFailed(created.id, `Job 创建失败: ${reason}`);
          throw new JobCreationError(
            created.id,
            reason,
            failed ?? (await this.repo.findById(created.id)),
          );
        }

        const connecting = await this.repo.update(
          created.id,
          { status: 'connecting' },
          { fromStatuses: ['creating'] },
        );
        if (connecting) return connecting;

        // CAS 未命中：除「记录被并发销毁/置终态」外，还可能是 worker 先注册
        // （`markOnline` 允许 creating→online）。因此回读记录，仅当已进入终态
        // （destroying/exited/failed）才回收 Job；online/connecting 的健康容器
        // 不得被误删活 Job（问题 58）。
        const current = await this.repo.findById(created.id);
        if (current && isTerminalStatus(current.status)) {
          await this.deleteResidualJob(name);
        }
        return current ?? created;
      });
    } catch (err) {
      // 启动链路异常（如 token 签发失败）：仅当容器已进入终态或记录不存在时清理内存 secret，
      // 避免与仍在运行的 worker 初始化批次竞态；非终态由后续销毁/巡检路径清理。
      const current = await this.repo.findById(created.id);
      if (!current || isTerminalStatus(current.status)) {
        this.secretStore.delete(created.id);
      }
      throw err;
    }
  }

  /**
   * harness Job env（契约 A.2.2）：`ZAG_SERVER_ENDPOINT`/`ZAG_CONTROLLER_KEY` 由 job manager
   * 固定注入；此处仅返回追加项。模型 Key/BaseURL/模型列表**不进入 Job env**（只走
   * `workload:run.env`），避免容器环境变量长期暴露模型凭据。
   */
  private buildHarnessJobEnv(options: StartHarnessOptions): Record<string, string> {
    const env: Record<string, string> = {};
    const secrets = options.secrets;
    if (secrets?.hostEndpoint) env.ZAG_HOST_ENDPOINT = secrets.hostEndpoint;
    if (secrets?.hostKey) env.ZAG_HOST_KEY = secrets.hostKey;
    if (options.hostName) env.ZAG_HOST_NAME = options.hostName;
    if (options.harnessTypes && options.harnessTypes.length > 0) {
      env.ZAG_HARNESS_TYPES = options.harnessTypes.join(',');
    }
    if (secrets?.defaultWorkspace) env.ZAG_DEFAULT_WORKSPACE = secrets.defaultWorkspace;
    env.ZAG_USER_TYPE = 'front_user';
    if (options.userId) env.ZAG_USER_ID = options.userId;
    if (options.controllerId) env.ZAG_CONTROLLER_ID = options.controllerId;
    if (this.cfg.agentApiUrl) {
      env.ZAG_AGENT_API_ENDPOINT = this.cfg.agentApiUrl.replace(/\/+$/, '');
    } else {
      this.logger.warn?.(
        '[harness] AGENT_API_URL 未配置：Github 凭据申请不可用（Git 项目设置会失败）',
      );
    }
    return env;
  }

  private async deleteResidualJob(name: string): Promise<void> {
    try {
      await this.jobManager.deleteJob(name);
    } catch (err) {
      this.logger.error?.(`Failed to reclaim orphaned job ${name}`, err);
    }
  }

  async markConnecting(containerId: string): Promise<CloudContainerEntity | null> {
    return this.updateGuarded(containerId, {
      status: 'connecting',
      currentWorkloadName: null,
    });
  }

  /**
   * 容器回连并开始执行初始化脚本：置 `initializing` 并写入当前执行的工作负载名称。
   * 注册即视为已连接，写入 `connectedAt`（销毁流程据此决定是否需要发送 shutdown）。
   */
  async markInitializing(
    containerId: string,
    currentWorkloadName: string,
  ): Promise<CloudContainerEntity | null> {
    return this.updateGuarded(containerId, {
      status: 'initializing',
      currentWorkloadName,
      connectedAt: new Date(),
      exitReason: null,
    });
  }

  async markOnline(containerId: string): Promise<CloudContainerEntity | null> {
    // 首次进入 online：原子写入 billingStartedAt，并投递 container.ready。
    // 重复 markOnline / 已计费容器重连（initializing→online）不重置计费起点、不重复投递（裁决 3）。
    const current = await this.repo.findById(containerId);
    if (!current) return null;

    const now = new Date();
    const basePatch = {
      status: 'online' as const,
      connectedAt: now,
      exitReason: null,
      currentWorkloadName: null,
      // 起始初始化已收口（工作流只初始化一次）：首次 online 落标记，后续断线重连不得重跑 init。
      ...(current.initCompletedAt ? {} : { initCompletedAt: now }),
    };
    if (current.billingStartedAt) {
      return this.updateGuarded(containerId, basePatch);
    }

    // 首次 online：原子条件写入（filter billingStartedAt=null），并发 markOnline 只有一次生效
    const firstOnline = await this.repo.update(
      containerId,
      { ...basePatch, billingStartedAt: now },
      {
        fromStatuses: [...ACTIVE_STATUSES],
        requireNullFields: ['billingStartedAt'],
      },
    );
    if (firstOnline) {
      // 计费就绪与云电脑就绪共用同一「首次 online」时机；harness 无计费账户也必须回调。
      const shouldEmit =
        (firstOnline.billingAccountId !== null && firstOnline.billingStartedAt !== null) ||
        firstOnline.purpose === 'harness';
      if (shouldEmit) this.emitHook('onReady', firstOnline);
      return firstOnline;
    }

    // CAS 未命中（并发转移）：回读，避免用陈旧值覆写。
    return this.repo.findById(containerId);
  }

  async markExited(
    containerId: string,
    exitReason: string,
    at: Date = new Date(),
  ): Promise<CloudContainerEntity | null> {
    // 阻断项 4a：仅当 CAS **真的发生转移**时才投递 destroyed。CAS 未命中（记录已被并发
    // 转移/处于 destroying）时不得回读后投递——否则会用提前的 exitedAt 顶替精确事件（少计费）。
    const updated = await this.repo.update(
      containerId,
      {
        status: 'exited',
        exitedAt: at,
        exitReason,
        tokenHash: null,
        currentWorkloadName: null,
      },
      { fromStatuses: [...ACTIVE_STATUSES] },
    );
    if (updated) {
      // 非 destroy 路径的终态（Job 自退/异常退出）同样投递 destroyed，避免尾结与冻结释放被拖延
      this.finalizeTerminal(updated);
    }
    // CAS 未命中仅回读用于返回值，绝不据此投递事件。
    return updated ?? this.repo.findById(containerId);
  }

  async markFailed(
    containerId: string,
    exitReason: string,
    at: Date = new Date(),
  ): Promise<CloudContainerEntity | null> {
    // 阻断项 4a：同 markExited，仅 CAS 命中才投递。
    const updated = await this.repo.update(
      containerId,
      {
        status: 'failed',
        exitedAt: at,
        exitReason,
        tokenHash: null,
        currentWorkloadName: null,
      },
      { fromStatuses: [...ACTIVE_STATUSES] },
    );
    if (updated) this.finalizeTerminal(updated);
    return updated ?? this.repo.findById(containerId);
  }

  async getById(containerId: string): Promise<CloudContainerEntity | null> {
    return this.repo.findById(containerId);
  }

  /**
   * 必须工作负载失败时的强制注销（工作负载三期，spi `WorkloadContainerStatePort.forceDestroy`）：
   * 复用既有 `destroy` 链路（CAS `destroying` → 清理批次 + `shutdown` → 删除 Job → `exited`），
   * `reason` 写入 `exitReason`（缺省「强制销毁」）。不新增独立删除路径。
   */
  async forceDestroy(containerId: string, reason: string): Promise<DestroyResult> {
    return this.destroy(containerId, { reason });
  }

  /**
   * 强制销毁：在线先 emit shutdown 宽限 → deleteJob → destroying → exited（清空 tokenHash）。
   * 对终态记录仍会核实 Job 是否存在并清理残留（幂等体现在响应上，`deletedJob` 反映真实动作）。
   * 全程持有该容器的串行锁，避免与 `start()` 交错产生孤儿 Job。
   */
  async destroy(containerId: string, options?: { reason?: string }): Promise<DestroyResult> {
    const container = await this.repo.findById(containerId);
    if (!container) {
      throw new ContainerNotFoundError(containerId);
    }
    return this.mutex.runExclusive(containerId, () => this.destroyLocked(containerId, options));
  }

  private async destroyLocked(
    containerId: string,
    options?: { reason?: string },
  ): Promise<DestroyResult> {
    const container = await this.repo.findById(containerId);
    if (!container) {
      throw new ContainerNotFoundError(containerId);
    }

    // 终态记录：不跳过清理，核实并删除残留 Job（幂等语义 = Job 不存在时不再重复删除）。
    if (isTerminalStatus(container.status)) {
      // 云电脑 secret 随终态清理（幂等）。
      this.secretStore.delete(containerId);
      const deletion = await this.deleteJobIfExistsDetailed(container.name);
      // 卡死的 destroying（销毁被 SIGTERM 打断）：Job 删除失败则保留待巡检重试；
      // 否则迁移 exited，兑现契约 `destroying → exited`（问题 50）。
      if (container.status === 'destroying') {
        if (deletion === 'failed') {
          return { success: true, id: containerId, status: 'destroying', deletedJob: false };
        }
        const exited = await this.repo.update(
          containerId,
          {
            status: 'exited',
            exitedAt: new Date(),
            // D2：保留调用方传入的强拆原因（如「余额不足…」），仅在为空时回退默认文案。
            exitReason:
              container.exitReason && container.exitReason.length > 0
                ? container.exitReason
                : deletion === 'deleted'
                  ? '强制销毁'
                  : '强制销毁（Job 已不存在）',
            tokenHash: null,
            currentWorkloadName: null,
          },
          { fromStatuses: ['destroying'] },
        );
        const current = exited ?? (await this.repo.findById(containerId));
        if (exited && current) {
          this.finalizeTerminal(current);
        }
        return {
          success: true,
          id: containerId,
          status: current?.status ?? 'exited',
          deletedJob: deletion === 'deleted',
        };
      }
      const deletedJob = deletion === 'deleted';
      if (deletedJob) {
        await this.repo.update(containerId, { tokenHash: null });
      }
      return { success: true, id: containerId, status: container.status, deletedJob };
    }

    const destroying = await this.repo.update(
      containerId,
      { status: 'destroying', currentWorkloadName: null },
      { fromStatuses: [...ACTIVE_STATUSES] },
    );
    if (!destroying) {
      // 并发操作已将其置为终态，按终态路径幂等清理。
      return this.destroyLocked(containerId, options);
    }

    // 用 CAS 之后的状态决定是否优雅停机：`markOnline` 可能在 destroy 的初始快照之后、
    // CAS 之前把记录置为 online（connectedAt 被写入且随 CAS 结果保留），此时不得跳过
    // shutdown，否则会丢掉一次优雅停机机会（建议 G）。
    if (destroying.connectedAt !== null) {
      // R2-20：把真实销毁原因透传给 worker（必须失败 = markMustFailure 写入的 exitReason），
      // 避免 gateway 硬编码「强制销毁」导致 worker 以 exit(0) 掩盖失败。
      await this.notifyShutdown(
        containerId,
        options?.reason ?? container.exitReason ?? '强制销毁',
      );
      if (this.cfg.shutdownGraceMs > 0) {
        await delay(this.cfg.shutdownGraceMs);
      }
    }

    let deletedJob = false;
    try {
      await this.jobManager.deleteJob(container.name);
      deletedJob = true;
    } catch (err) {
      this.logger.error?.(`Failed to delete job ${container.name}`, err);
    }

    // Job 删除失败时显式告警，便于运维发现残留 Job（不静默）
    // R7：未显式传 reason 时保留既有 exitReason（如必须失败原因），不无条件覆写。
    const baseReason = options?.reason ?? container.exitReason ?? '强制销毁';
    const exitReason = deletedJob ? baseReason : `${baseReason}（Job 删除失败，需人工清理）`;
    // 终态写回同样带 CAS（问题 50）：仅从 destroying 迁移，避免扩副本/并发下用陈旧状态覆写。
    const exited = await this.repo.update(
      containerId,
      {
        status: 'exited',
        exitedAt: new Date(),
        exitReason,
        tokenHash: null,
        currentWorkloadName: null,
      },
      { fromStatuses: ['destroying'] },
    );
    if (!exited) {
      // CAS 未命中（已被并发转移）：回读当前状态返回，绝不用陈旧值覆写。
      const current = await this.repo.findById(containerId);
      return {
        success: true,
        id: containerId,
        status: current?.status ?? 'exited',
        deletedJob,
      };
    }

    this.finalizeTerminal(exited);

    return { success: true, id: containerId, status: 'exited', deletedJob };
  }

  /**
   * 终态统一收口：先清理内存 secret，再按需投递销毁钩子。
   *
   * 销毁事件投递条件（裁决 4）：`billingAccountId` 与 `billingStartedAt` 均非空（计费），
   * 或 `purpose=harness`（云电脑 terminal 回调不依赖计费，裁决 A19/A24）。
   */
  private finalizeTerminal(container: CloudContainerEntity): void {
    this.secretStore.delete(container.id);
    const billed = container.billingAccountId !== null && container.billingStartedAt !== null;
    if (!billed && container.purpose !== 'harness') return;
    this.emitHook('onDestroyed', container);
  }

  /**
   * 终态回收兜底：对 `failed` / `exited` / `destroying` 记录，若仍存在关联 Job 则删除
   * （问题 50：`exited` 记录若 Job 删除曾失败也需重试回收，不再只扫 `failed`/`destroying`）。
   * 卡死的 `destroying` 记录（销毁流程被 SIGTERM 打断）在 Job 回收后按契约迁移 `exited`
   * （`destroying → exited`），避免永久停在 destroying。
   * 供周期性巡检与 reconcile 调用。
   */
  async reclaimResidualJob(containerId: string): Promise<boolean> {
    return this.mutex.runExclusive(containerId, async () => {
      const record = await this.repo.findById(containerId);
      if (!record) return false;
      if (
        record.status !== 'failed' &&
        record.status !== 'destroying' &&
        record.status !== 'exited'
      ) {
        return false;
      }

      const deletion = await this.deleteJobIfExistsDetailed(record.name);
      if (deletion === 'failed') {
        // Job 确实存在但删除失败：保留当前状态，等待下一次巡检重试（不谎报已回收）。
        return false;
      }

      if (record.status === 'destroying') {
        // 契约要求 destroying → exited：无论 Job 本次被删除还是已不存在，都迁移终态。
        const exited = await this.repo.update(
          containerId,
          {
            status: 'exited',
            exitedAt: new Date(),
            // D2：保留既有强拆原因，仅在为空时回退默认文案。
            exitReason:
              record.exitReason && record.exitReason.length > 0
                ? record.exitReason
                : deletion === 'deleted'
                  ? '强制销毁'
                  : '强制销毁（Job 已不存在）',
            tokenHash: null,
            currentWorkloadName: null,
          },
          { fromStatuses: ['destroying'] },
        );
        if (exited) this.finalizeTerminal(exited);
      } else if (deletion === 'deleted') {
        await this.repo.update(containerId, { tokenHash: null });
      }

      return deletion === 'deleted';
    });
  }

  /**
   * 列表：落库状态合并 K8s 实时状态（Job 消失/失败/成功时回写）。
   * `creating` 记录在 Job 尚未创建完成前不判定为「Job 已回收」，避免误置 failed。
   */
  async list(): Promise<CloudContainerEntity[]> {
    const records = await this.repo.findAll();
    const result: CloudContainerEntity[] = [];

    for (const record of records) {
      let effective = record;
      if (!isTerminalStatus(record.status)) {
        const job = await this.jobManager.getJob(record.name);
        if (!job) {
          if (record.status !== 'creating') {
            effective = (await this.markFailed(record.id, 'Job 已回收')) ?? record;
          }
        } else if (job.phase === 'failed') {
          effective = (await this.markFailed(record.id, job.message ?? '容器异常退出')) ?? record;
        } else if (job.phase === 'succeeded') {
          effective = (await this.markExited(record.id, '容器正常退出')) ?? record;
        }
      }
      result.push(effective);
    }

    return result;
  }
}
