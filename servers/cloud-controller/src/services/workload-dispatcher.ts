import type { CloudContainerEntity, ContainerRepository } from '../repositories/container-repository.js';
import type { WorkloadPlanEntry } from '../models/cloud-container.js';
import type { CloudWorkloadEntity, WorkloadRepository } from '../repositories/workload-repository.js';
import type {
  CloudWorkloadLogEntity,
  CreateWorkloadLogInput,
  WorkloadLogRepository,
} from '../repositories/workload-log-repository.js';
import {
  isTerminalWorkloadLogStatus,
  type WorkloadLogPhase,
  type WorkloadLogStatus,
} from '../models/cloud-workload-log.js';
import { KeyedMutex } from './keyed-mutex.js';
import type { HarnessSecrets, HarnessSecretStore } from './secret-store.js';

interface Logger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

export const WORKLOAD_RUN_EVENT = 'workload:run';

/** `initializing` 内部流水线的当前状态字段取值来源。 */
export interface WorkloadContainerStatePort {
  markInitializing(containerId: string, currentWorkloadName: string): Promise<unknown>;
  markOnline(containerId: string): Promise<unknown>;
  markConnecting(containerId: string): Promise<unknown>;
  /** 必须失败兜底：把容器 CAS 为终态 `failed`（含 destroyed 补投，避免计费会话悬空）。 */
  markFailed(containerId: string, reason: string): Promise<unknown>;
  /** 必须失败：锁外强制注销（复用既有 destroy 链路，`reason` 写入 `exitReason`）。 */
  forceDestroy(containerId: string, reason: string): Promise<unknown>;
}

/** 必须项失败信号（裁决 4）：仅携带可读负载名，供锁外注销文案使用。 */
export interface RequiredFailure {
  workloadName: string;
}

/** `startInit` 结果（裁决 10）：`initializing` 表示容器现在处于/进入初始化；`requiredFailure` 时不得 markOnline。 */
export interface StartInitResult {
  initializing: boolean;
  requiredFailure: RequiredFailure | null;
  /**
   * harness 运行环境无法构建（secret/model 缺失）时置位：容器已记 failed，
   * 调用方**不得** markOnline（T-CC13）。
   */
  failed?: boolean;
}

/** runtime 安装批次：容器不存在。 */
export class RuntimeContainerNotFoundError extends Error {
  constructor(message = 'container not found') {
    super(message);
    this.name = 'RuntimeContainerNotFoundError';
  }
}

/** runtime 安装批次：容器不在线。 */
export class ContainerNotOnlineError extends Error {
  constructor(message = 'container is not online') {
    super(message);
    this.name = 'ContainerNotOnlineError';
  }
}

/** runtime 批次参数非法（如空 entries）。 */
export class InvalidRuntimeBatchError extends Error {
  constructor(message = 'invalid runtime batch') {
    super(message);
    this.name = 'InvalidRuntimeBatchError';
  }
}

/** runtime 安装批次：已有 runtime 批次在执行。 */
export class ContainerBusyError extends Error {
  constructor(message = 'container is busy') {
    super(message);
    this.name = 'ContainerBusyError';
  }
}

export interface RuntimeEntry {
  workloadId: string;
  workloadName: string;
  script: string;
  params: Record<string, unknown>;
}

export interface RuntimeBatchInput {
  entries: RuntimeEntry[];
  source: 'user' | 'mcp' | 'system';
  /** 仅 Git 设置脚本批次为 true：worker 在执行前申请并写入 gh 凭据。 */
  githubAuth?: boolean;
}

export interface RuntimeBatchResult {
  batchId: string;
  items: Array<{ logId: string; workloadId: string; workloadName: string }>;
}

export interface WorkloadResultPayload {
  logId?: unknown;
  status?: unknown;
  exitCode?: unknown;
  log?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
}

export interface WorkloadDispatcherDeps {
  containerRepository: ContainerRepository;
  containerService: WorkloadContainerStatePort;
  workloadRepository: WorkloadRepository;
  workloadLogRepository: WorkloadLogRepository;
  /** 向容器所在 Socket.IO room 发射事件（回调注入，避免 gateway ↔ dispatcher 循环依赖）。 */
  emitToContainer: (containerId: string, event: string, payload: unknown) => void;
  /** 该容器当前是否有活跃 socket（决定 init 收口为 online / connecting）。 */
  isConnected: (containerId: string) => boolean;
  /** 单条 init 脚本超时（随 `workload:run` 下发，同时用作看门狗基准）。 */
  initTimeoutMs: number;
  /** post 批次共享总预算（随 shutdown 前的 post 批次下发）。 */
  postBudgetMs: number;
  /** 单条日志存储上限（写入前尾部截断）。 */
  logMaxBytes: number;
  /** 必须失败：锁外强制注销容器（注入 `containerService.destroy(id, { reason })`，裁决 7）。 */
  forceDestroy: (containerId: string, reason: string) => Promise<unknown>;
  /** 可注入的时钟（测试确定性用），默认 `Date.now`。 */
  now?: () => number;
  /** 云电脑运行期 secret（仅 harness 使用；缺失时 init 失败，见 T-CC13）。 */
  secretStore?: HarnessSecretStore;
  logger?: Logger;
}

/** RUNNING 记录的宽限：超过 `timeoutMs + 30s` 由看门狗标 TIMEOUT（裁决 10）。 */
const RUNNING_STUCK_GRACE_MS = 30000;
/** 无 RUNNING 但 PENDING 停留超过该值时推进（裁决 10）。 */
const PENDING_STUCK_MS = 60000;
/** initializing 卡死总兜底额外容差：`items × initTimeoutMs + 120s`（裁决 10）。 */
const INIT_WATCHDOG_EXTRA_MS = 120000;

const DELETED_WORKLOAD_NAME = '(已删除)';
const DELETED_WORKLOAD_LOG = '工作负载已删除，跳过执行';
const DELETED_WORKLOAD_POST_LOG = '工作负载已删除，未执行清理';
const DISCONNECTED_LOG = '容器未连接，未执行';
const DESTROY_INTERRUPT_LOG = '容器销毁中断';
const POST_BUDGET_EXCEEDED_LOG = '清理脚本超时';
const INIT_TIMEOUT_LOG = '初始化超时';
/** harness secret/模型配置缺失时的中断说明与失败原因（不含 secret 明文）。 */
const HARNESS_ENV_MISSING_LOG = '云电脑运行环境缺失，未执行';
const HARNESS_ENV_MISSING_REASON = '云电脑初始化环境缺失';
/** 必须项失败后，对剩余非终态 init 记录追加的中断说明（裁决 5）。 */
const REQUIRED_FAILURE_INTERRUPT_LOG = '必须工作负载初始化失败，已中断';

/** 截断保留尾部 ≤ maxBytes（UTF-8 安全：丢弃起始处的半个多字节字符）。 */
export function truncateLogTail(text: string, maxBytes: number): string {
  if (!text) return '';
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  const tail = bytes.subarray(bytes.length - maxBytes);
  let start = 0;
  while (start < tail.length && (tail[start]! & 0xc0) === 0x80) start += 1;
  return tail.subarray(start).toString('utf8');
}

function appendLog(base: string, extra: string): string {
  if (!base) return extra;
  return `${base}\n${extra}`;
}

function normalizeResultStatus(value: unknown): WorkloadLogStatus {
  if (value === 'success' || value === 'failed' || value === 'timeout') return value;
  return 'failed';
}

/**
 * 读取容器的有序执行计划：优先 `workloadPlan`；历史容器无 plan 时回退
 * `workloadIds → { workloadId, params: {}, implicit: false }`（裁决 13）。
 */
export function resolveContainerPlan(
  container: Pick<CloudContainerEntity, 'workloadIds' | 'workloadPlan'>,
): WorkloadPlanEntry[] {
  const plan = container.workloadPlan ?? [];
  if (plan.length > 0) {
    return plan.map((entry) => ({
      workloadId: entry.workloadId,
      params: entry.params ?? {},
      implicit: entry.implicit === true,
      required: entry.required === true,
    }));
  }
  return (container.workloadIds ?? []).map((id) => ({
    workloadId: id,
    params: {},
    implicit: false,
    required: false,
  }));
}

/**
 * 构建 harness 的 `workload:run.env`（契约 §2.9「云电脑初始化 env」）。
 *
 * - `ZAG_HARNESS_TYPES`/`ZAG_CONTAINER_ID` 必有；
 * - 容器缺失的关联字段（hostId/hostName/userId）跳过对应变量（历史/降级兼容）；
 * - **model 配置（Key/BaseURL/modelIds）缺失视为错误**：不给 worker 下发半套配置，
 *   由调用方把容器判失败（T-CC13）。返回值/错误文案不含任何 secret 明文。
 */
export function buildHarnessEnv(
  container: Pick<CloudContainerEntity, 'id' | 'hostId' | 'hostName' | 'harnessTypes' | 'userId'>,
  secrets: HarnessSecrets | null,
): { ok: true; env: Record<string, string> } | { ok: false; reason: string } {
  if (!secrets) return { ok: false, reason: 'secret not found' };
  if (!secrets.modelApiKey || !secrets.modelBaseUrl || !secrets.modelIds) {
    return { ok: false, reason: 'model config incomplete' };
  }

  const env: Record<string, string> = {
    ZAG_HARNESS_TYPES: (container.harnessTypes ?? []).join(','),
    ZAG_CONTAINER_ID: container.id,
  };
  if (container.hostId) env.ZAG_HOST_ID = container.hostId;
  if (container.hostName) env.ZAG_HOST_NAME = container.hostName;
  if (secrets.hostEndpoint) env.ZAG_HOST_ENDPOINT = secrets.hostEndpoint;
  if (secrets.hostKey) env.ZAG_HOST_KEY = secrets.hostKey;
  if (secrets.defaultWorkspace) env.ZAG_DEFAULT_WORKSPACE = secrets.defaultWorkspace;
  env.ZAG_USER_TYPE = 'front_user';
  if (container.userId) env.ZAG_USER_ID = container.userId;
  env.ZAG_MODEL_API_KEY = secrets.modelApiKey;
  env.ZAG_MODEL_BASE_URL = secrets.modelBaseUrl;
  env.ZAG_MODEL_IDS = secrets.modelIds;
  // 可选：模型 ID → 最长上下文（契约 §2.9）；缺失不下发，旧 worker 无感。
  if (secrets.modelContextLengths) env.ZAG_MODEL_CONTEXT_LENGTHS = secrets.modelContextLengths;

  return { ok: true, env };
}

/**
 * 工作负载编排器：脚本下发、结果落库、当前脚本跟踪、看门狗与销毁清理批次。
 *
 * - init：容器 register 后读取挂载工作负载的 `initScript`，批量创建执行日志（首条
 *   `running`、其余 `pending`，创建时写入脚本快照），CAS 置 `initializing`，emit
 *   `workload:run { phase: "init" }`；逐条结果回报推进，全部终态后收口 online/connecting。
 * - post：销毁流程中由 gateway 的 shutdown handler 调用 `runPostBatch`，等待最后一条结果
 *   或预算耗尽后再 emit `shutdown`。
 *
 * 所有推进/收口按 containerId 用 `KeyedMutex` 串行化。等待 post 结果时**不持有互斥锁**
 * （否则结果回调将被自己阻塞），仅创建/推进/收口这些短临界区持锁。
 */
export class WorkloadDispatcher {
  private readonly mutex = new KeyedMutex();
  private readonly postWaiters = new Map<string, Set<() => void>>();
  private readonly now: () => number;

  constructor(private readonly deps: WorkloadDispatcherDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * 容器 register 后的初始化入口。
   *
   * 返回 `initializing=true` 表示容器现在处于/进入 `initializing`（调用方不要再 markOnline）；
   * `requiredFailure` 非空表示「必须项失败」，**已在锁外完成强制注销**，调用方不得 markOnline。
   * 重连（已是 `initializing`）不重发批次（裁决 6）。
   */
  async startInit(containerId: string): Promise<StartInitResult> {
    const result = await this.mutex.runExclusive(containerId, () =>
      this.startInitLocked(containerId),
    );
    if (result.requiredFailure) {
      await this.forceDestroy(
        containerId,
        this.requiredFailureReason(result.requiredFailure.workloadName),
      );
    }
    return result;
  }

  private async startInitLocked(containerId: string): Promise<StartInitResult> {
    const noInit: StartInitResult = { initializing: false, requiredFailure: null };
    const container = await this.deps.containerRepository.findById(containerId);
    if (!container) return noInit;
    if (container.status === 'initializing') return { initializing: true, requiredFailure: null };
    // runtime 批次中断线后重连：只收口，不重放创建时的启动计划。
    if (container.status === 'connecting' && container.initTrigger === 'runtime') {
      await this.deps.containerRepository.update(containerId, { initTrigger: null });
      return noInit;
    }
    // 已完成的初始化不重跑（工作流只初始化一次）：agent-gear 重启 → 断线把 online 退回
    // connecting → 再次 register，不得重新执行一遍 init 批次。
    if (this.hasSettledInit(container)) return noInit;
    // 仅 creating/connecting（回连注册路径）触发初始化；online 重连不重跑。
    if (container.status !== 'connecting' && container.status !== 'creating') return noInit;

    const plan = resolveContainerPlan(container);
    if (plan.length === 0) return noInit;

    const workloads = await this.deps.workloadRepository.findByIds(
      plan.map((entry) => entry.workloadId),
    );
    const byId = new Map(workloads.map((workload) => [workload.id, workload]));

    interface Entry {
      workloadId: string;
      workloadName: string;
      script: string;
      params: Record<string, unknown>;
      deleted: boolean;
      required: boolean;
    }

    const entries: Entry[] = [];
    for (const item of plan) {
      const required = item.required === true;
      const workload = byId.get(item.workloadId);
      if (!workload) {
        // 裁决 3：执行前被删除 → 生成 FAILED 占位记录（留档）；若为必须项则触发必须失败（裁决 9）。
        entries.push({
          workloadId: item.workloadId,
          workloadName: DELETED_WORKLOAD_NAME,
          script: '',
          params: {},
          deleted: true,
          required,
        });
        continue;
      }
      const script = workload.initScript ?? '';
      if (script.trim().length === 0) continue;
      entries.push({
        workloadId: item.workloadId,
        workloadName: workload.name,
        script,
        params: item.params ?? {},
        deleted: false,
        required,
      });
    }

    if (entries.length === 0) return noInit;

    const requiredDeleted = entries.find((entry) => entry.deleted && entry.required);
    const firstRunIndex = entries.findIndex((entry) => !entry.deleted);
    const now = new Date(this.now());
    const inputs: CreateWorkloadLogInput[] = entries.map((entry, index) => {
      if (entry.deleted) {
        return {
          containerId,
          workloadId: entry.workloadId,
          workloadName: entry.workloadName,
          phase: 'init',
          status: 'failed',
          script: '',
          params: {},
          required: entry.required,
          log: DELETED_WORKLOAD_LOG,
          exitCode: null,
          startedAt: now,
          finishedAt: now,
        };
      }
      const isFirst = index === firstRunIndex;
      return {
        containerId,
        workloadId: entry.workloadId,
        workloadName: entry.workloadName,
        phase: 'init',
        status: isFirst ? 'running' : 'pending',
        script: entry.script,
        params: entry.params,
        required: entry.required,
        log: '',
        exitCode: null,
        startedAt: isFirst ? now : null,
        finishedAt: null,
      };
    });

    const logs = await this.deps.workloadLogRepository.createMany(inputs);

    // 裁决 9：计划中存在「必须且执行前被删除」的条目 → 留档后中断剩余非终态 init，
    // 不下发批次、不进入 initializing，返回信号由调用方锁外注销。
    if (requiredDeleted) {
      await this.markRemainingInitTimeout(containerId, now, REQUIRED_FAILURE_INTERRUPT_LOG);
      await this.markMustFailure(
        containerId,
        this.requiredFailureReason(requiredDeleted.workloadName),
      );
      return {
        initializing: false,
        requiredFailure: { workloadName: requiredDeleted.workloadName },
      };
    }

    const runLogs = logs.filter((log) => !isTerminalWorkloadLogStatus(log.status));
    if (runLogs.length === 0) {
      // 全部为已删除占位记录：不进入 initializing。
      return noInit;
    }

    // 云电脑：secret/模型配置缺失时不向 worker 下发半套环境，直接判失败（不 online，T-CC13）。
    const runEnv = this.resolveRunEnv(container);
    if (!runEnv.ok) {
      this.deps.logger?.warn?.(
        `[workload] harness env unavailable containerId=${containerId} (init aborted)`,
      );
      await this.markRemainingInitTimeout(containerId, now, HARNESS_ENV_MISSING_LOG);
      await this.deps.containerService.markFailed(containerId, HARNESS_ENV_MISSING_REASON);
      return { initializing: false, requiredFailure: null, failed: true };
    }

    await this.deps.containerService.markInitializing(containerId, runLogs[0]!.workloadName);
    await this.deps.containerRepository.update(containerId, { initTrigger: 'start' });
    this.emitRun(containerId, 'init', runLogs, runEnv.env);
    return { initializing: true, requiredFailure: null };
  }

  /**
   * 起始初始化是否已收口（工作流只初始化一次）。
   *
   * - `initCompletedAt` 非空：首次进入 online 时由 `ContainerService.markOnline` 写入；
   * - 历史容器兜底：升级前落库的记录没有标记，但 `connectedAt` 非空证明容器曾上线过；
   *   此时若处于断线重连的 `connecting`，初始化必然已经结束（init 进行中掉线保持
   *   `initializing`，不会退回 `connecting`）。
   */
  private hasSettledInit(container: CloudContainerEntity): boolean {
    if (container.initCompletedAt) return true;
    return container.status === 'connecting' && container.connectedAt !== null;
  }

  /**
   * 在线容器 runtime 批次（安装工作负载 / 系统 Git 设置脚本）。
   *
   * 入口要求 `online`；CAS 到 `initializing` 并写入 `initTrigger='runtime'`。批次结束后
   * 由 `finishInit` 直接 `markOnline`（不回 `connecting`）。同一容器同时只允许一个 runtime 批次。
   */
  async startRuntimeBatch(
    containerId: string,
    input: RuntimeBatchInput,
  ): Promise<RuntimeBatchResult> {
    return this.mutex.runExclusive(containerId, async () => {
      const container = await this.deps.containerRepository.findById(containerId);
      if (!container) throw new RuntimeContainerNotFoundError();
      if (container.status === 'initializing') {
        throw new ContainerBusyError('another runtime batch is running');
      }
      if (container.status !== 'online') {
        throw new ContainerNotOnlineError();
      }
      if (input.entries.length === 0) {
        throw new InvalidRuntimeBatchError('runtime batch requires at least one entry');
      }

      const now = new Date(this.now());
      const inputs: CreateWorkloadLogInput[] = input.entries.map((entry, index) => ({
        containerId,
        workloadId: entry.workloadId,
        workloadName: entry.workloadName,
        phase: 'init',
        status: index === 0 ? 'running' : 'pending',
        script: entry.script,
        params: entry.params,
        required: false,
        trigger: 'runtime',
        source: input.source,
        log: '',
        exitCode: null,
        startedAt: index === 0 ? now : null,
        finishedAt: null,
      }));
      const logs = await this.deps.workloadLogRepository.createMany(inputs);

      await this.deps.containerService.markInitializing(
        containerId,
        logs[0]!.workloadName,
      );
      await this.deps.containerRepository.update(containerId, { initTrigger: 'runtime' });
      this.emitRun(
        containerId,
        'init',
        logs,
        undefined,
        input.githubAuth === true,
      );

      const batchId = `runtime-${Date.now()}-${logs[0]!.id}`;
      return {
        batchId,
        items: logs.map((log) => ({
          logId: log.id,
          workloadId: log.workloadId,
          workloadName: log.workloadName,
        })),
      };
    });
  }

  /** 解析本轮下发所需 env：非 harness 返回无 env；harness 读取 secretStore（失败不打印内容）。 */
  private resolveRunEnv(
    container: CloudContainerEntity,
  ): { ok: true; env?: Record<string, string> } | { ok: false } {
    if (container.purpose !== 'harness') return { ok: true };
    const secrets = this.deps.secretStore?.get(container.id) ?? null;
    const result = buildHarnessEnv(container, secrets);
    return result.ok ? { ok: true, env: result.env } : { ok: false };
  }

  /** 把该容器剩余非终态 init 记录标 `timeout` 并追加中断说明（裁决 5）。 */
  private async markRemainingInitTimeout(
    containerId: string,
    now: Date,
    extraLog: string,
  ): Promise<void> {
    const active = await this.deps.workloadLogRepository.findActiveByContainer(containerId, 'init');
    for (const log of active) {
      await this.deps.workloadLogRepository.updateById(log.id, {
        status: 'timeout',
        log: appendLog(log.log, extraLog),
        finishedAt: now,
      });
    }
  }

  /** 必须失败的 `exitReason` 文案（裁决 6）：包含可读负载名。 */
  private requiredFailureReason(workloadName: string): string {
    return `必须工作负载「${workloadName}」初始化失败`;
  }

  /**
   * 在容器互斥锁内持久化「必须失败」标记（裁决 4/5，缺陷修复）：
   * - `mustFailure=true` 使 `finishInit` 拒绝收口为 online/connecting（关闭锁外销毁前的收口竞态）；
   * - 同步写入 `exitReason`（必须失败原因），供注销失败时看门狗重试与终态兜底使用。
   */
  private async markMustFailure(containerId: string, reason: string): Promise<void> {
    await this.deps.containerRepository.update(containerId, {
      mustFailure: true,
      exitReason: reason,
    });
  }

  /**
   * 锁外强制注销（裁决 4/7）：`exitReason` 含必须负载名，不重试、不退避。
   *
   * 失败兜底（缺陷修复）：`deps.forceDestroy` 抛出（如瞬时 Mongo/网络故障）时，容器不能停留在
   * `initializing`（否则看门狗会把它收口为 online）。此时把容器 CAS 为终态 `failed` 并保留必须失败
   * `exitReason`；`mustFailure` 标记已置位，看门狗亦不会将其收口为 online，残留 Job 交由既有巡检回收。
   * 注销失败重试的是「销毁」而非「初始化」，不违背「不 backoff」。
   */
  private async forceDestroy(containerId: string, reason: string): Promise<void> {
    try {
      await this.deps.forceDestroy(containerId, reason);
    } catch (err) {
      this.deps.logger?.error?.(
        `[workload] forceDestroy failed containerId=${containerId} reason=${reason}`,
        err,
      );
      try {
        // 阻断项 4b：兜底改走 `markFailed`（统一终态钩子，CAS 命中时补投 destroyed），
        // 不再用裸 `repo.update` 写终态，避免 `billingStartedAt` 非空却漏投 destroyed 导致计费悬空。
        await this.deps.containerService.markFailed(containerId, reason);
      } catch (fallbackErr) {
        this.deps.logger?.error?.(
          `[workload] mustFailure fallback mark failed failed containerId=${containerId}`,
          fallbackErr,
        );
      }
    }
  }

  /**
   * 判断 register 是否应走初始化流程（供 gateway 决定是否 markOnline）。
   * 容器不存在 / 已是 initializing（重连）/ 非回连状态 / 无挂载 → false；
   * 存在带 `initScript` 的工作负载，或存在已删除项（需为留档生成 FAILED 占位记录）→ true。
   */
  async hasInitScripts(containerId: string): Promise<boolean> {
    const container = await this.deps.containerRepository.findById(containerId);
    if (!container) return false;
    if (container.status === 'initializing') return true;
    // 已完成的初始化不重跑；否则会把 `registered.initializing=true` 发给 worker，
    // 让它空等一个永远不会下发的 init 批次（工作流只初始化一次）。
    if (this.hasSettledInit(container)) return false;
    if (container.status !== 'connecting' && container.status !== 'creating') return false;
    const plan = resolveContainerPlan(container);
    if (plan.length === 0) return false;
    const workloads = await this.deps.workloadRepository.findByIds(
      plan.map((entry) => entry.workloadId),
    );
    // 有已删除项：仍需走初始化流程以生成 FAILED 留档记录（裁决 3）。
    if (workloads.length < plan.length) return true;
    return workloads.some((workload) => (workload.initScript ?? '').trim().length > 0);
  }

  /** 处理单条 `workload:result`（校验归属、终态幂等、推进下一条/收口）。必须失败时锁外注销。 */
  async handleResult(containerId: string, payload: WorkloadResultPayload): Promise<void> {
    const failure = await this.mutex.runExclusive(containerId, () =>
      this.handleResultLocked(containerId, payload),
    );
    if (failure) {
      await this.forceDestroy(containerId, this.requiredFailureReason(failure.workloadName));
    }
  }

  private async handleResultLocked(
    containerId: string,
    payload: WorkloadResultPayload,
  ): Promise<RequiredFailure | null> {
    const logId = typeof payload?.logId === 'string' ? payload.logId : '';
    if (!logId) {
      this.deps.logger?.warn?.(`[workload] result missing logId containerId=${containerId}`);
      return null;
    }
    const record = await this.deps.workloadLogRepository.findById(logId);
    if (!record) {
      this.deps.logger?.warn?.(
        `[workload] result for unknown logId=${logId} containerId=${containerId}`,
      );
      return null;
    }
    if (record.containerId !== containerId) {
      this.deps.logger?.warn?.(
        `[workload] result logId=${logId} does not belong to containerId=${containerId} ` +
          `(actual=${record.containerId})`,
      );
      return null;
    }
    if (isTerminalWorkloadLogStatus(record.status)) return null; // 幂等：终态忽略迟到/重放结果

    const status = normalizeResultStatus(payload.status);
    const exitCode =
      typeof payload.exitCode === 'number' && Number.isFinite(payload.exitCode)
        ? payload.exitCode
        : null;
    const log = truncateLogTail(
      typeof payload.log === 'string' ? payload.log : '',
      this.deps.logMaxBytes,
    );
    const now = new Date(this.now());
    await this.deps.workloadLogRepository.updateById(logId, {
      status,
      exitCode,
      log,
      finishedAt: now,
    });

    // 必须失败裁决（裁决 4/5）：init 阶段的必须项 failed/timeout → 不推进，中断剩余 init，返回信号。
    if (record.phase === 'init' && record.required && (status === 'failed' || status === 'timeout')) {
      await this.markRemainingInitTimeout(containerId, now, REQUIRED_FAILURE_INTERRUPT_LOG);
      // 锁内先落 must-failure 标记（缺陷修复：关闭锁外销毁前的收口竞态）。
      await this.markMustFailure(
        containerId,
        this.requiredFailureReason(record.workloadName),
      );
      return { workloadName: record.workloadName };
    }

    // 已安装集合回填：仅成功结果，runtime 系统脚本不写入。
    if (status === 'success' && record.phase === 'init' && record.source !== 'system') {
      const source =
        record.trigger === 'runtime'
          ? record.source === 'mcp'
            ? 'mcp'
            : 'user'
          : 'start';
      await this.appendInstalledWorkload(
        containerId,
        record.workloadId,
        record.workloadName,
        source,
      );
    }

    await this.advance(containerId, record.phase);
    return null;
  }

  /** 回填已安装工作负载（按 workloadId 去重，保留首次记录）。 */
  private async appendInstalledWorkload(
    containerId: string,
    workloadId: string,
    name: string,
    source: 'start' | 'user' | 'mcp',
  ): Promise<void> {
    const container = await this.deps.containerRepository.findById(containerId);
    if (!container) return;
    if ((container.installedWorkloads ?? []).some((item) => item.workloadId === workloadId)) {
      return;
    }
    await this.deps.containerRepository.update(containerId, {
      installedWorkloads: [
        ...(container.installedWorkloads ?? []),
        { workloadId, name, installedAt: new Date(this.now()), source },
      ],
    });
  }

  /** 推到下一条 pending（RUNNING）或收口本阶段。 */
  private async advance(containerId: string, phase: WorkloadLogPhase): Promise<void> {
    const active = await this.deps.workloadLogRepository.findActiveByContainer(containerId, phase);
    const next = active[0];
    if (next) {
      await this.deps.workloadLogRepository.updateById(next.id, {
        status: 'running',
        startedAt: new Date(this.now()),
      });
      if (phase === 'init') {
        await this.deps.containerService.markInitializing(containerId, next.workloadName);
      }
      return;
    }

    if (phase === 'init') {
      await this.finishInit(containerId);
    } else {
      this.resolvePostWaiters(containerId);
    }
  }

  /** init 全部终态：runtime 批次直接 online；起始批次按连接状态 online/connecting（裁决 5）。 */
  private async finishInit(containerId: string): Promise<void> {
    const container = await this.deps.containerRepository.findById(containerId);
    if (!container || container.status !== 'initializing') return;
    // 必须失败：绝不收口为 online/connecting（缺陷修复）——由 forceDestroy/看门狗负责注销。
    if (container.mustFailure) return;
    if (container.initTrigger === 'runtime') {
      await this.deps.containerService.markOnline(containerId);
    } else if (this.deps.isConnected(containerId)) {
      await this.deps.containerService.markOnline(containerId);
    } else {
      await this.deps.containerService.markConnecting(containerId);
    }
    await this.deps.containerRepository.update(containerId, { initTrigger: null });
  }

  /** 是否存在带 `postScript` 的挂载工作负载（容器尚存时）。 */
  async hasPostScripts(containerId: string): Promise<boolean> {
    const container = await this.deps.containerRepository.findById(containerId);
    if (!container) return false;
    const plan = resolveContainerPlan(container);
    if (plan.length === 0) return false;
    const workloads = await this.deps.workloadRepository.findByIds(
      plan.map((entry) => entry.workloadId),
    );
    return workloads.some((workload) => (workload.postScript ?? '').trim().length > 0);
  }

  /**
   * 销毁流程的 post 批次：打断未完成的 init → 创建 post 日志 → emit → 等待完成/预算耗尽。
   * 无 post 脚本或无活跃连接时立即返回（调用方随后 emit shutdown）。
   *
   * waiter 在持有容器互斥锁期间注册（建议 11），避免 `preparePostBatch` 释锁后、注册前
   * 全部结果先收口，导致销毁白等一个预算周期。
   */
  async runPostBatch(containerId: string): Promise<void> {
    // 注意：`preparePostBatch` 返回的 waiter promise 必须包在对象里——`KeyedMutex.runExclusive`
    // 会 await 回调的返回值，直接返回 promise 会在持锁期间等待它（而结果回调需要同一把锁）造成死锁。
    const prep = await this.mutex.runExclusive(containerId, () =>
      this.preparePostBatch(containerId),
    );
    if (prep?.wait) await prep.wait;
  }

  /** 返回需等待的 waiter（已完成/无需等待时为 `null`）。全程在调用方的互斥锁内执行。 */
  private async preparePostBatch(
    containerId: string,
  ): Promise<{ wait: Promise<void> } | null> {
    const container = await this.deps.containerRepository.findById(containerId);
    if (!container) return null;

    const existing = await this.deps.workloadLogRepository.findByContainer(containerId);
    if (existing.some((log) => log.phase === 'post')) return null;

    const now = new Date(this.now());
    // 裁决 7：销毁时 init 尚未结束 → 先把非终态 init 记录标 TIMEOUT，再进入 post。
    const activeInit = await this.deps.workloadLogRepository.findActiveByContainer(containerId, 'init');
    for (const log of activeInit) {
      await this.deps.workloadLogRepository.updateById(log.id, {
        status: 'timeout',
        log: appendLog(log.log, DESTROY_INTERRUPT_LOG),
        finishedAt: now,
      });
    }

    const plan = resolveContainerPlan(container);
    if (plan.length === 0) return null;

    const workloads = await this.deps.workloadRepository.findByIds(
      plan.map((entry) => entry.workloadId),
    );
    const byId = new Map(workloads.map((workload) => [workload.id, workload]));

    // 建议 7：已删除工作负载也留一条 FAILED 占位（清理阶段未执行），与 init 阶段
    // （裁决 3）口径一致，避免静默丢失留档。占位记录 params 为 `{}`（无参数快照）。
    const deletedIds = plan
      .filter((entry) => !byId.has(entry.workloadId))
      .map((entry) => entry.workloadId);
    const runEntries = plan
      .map((entry) => ({ entry, workload: byId.get(entry.workloadId) }))
      .filter(
        (item): item is { entry: WorkloadPlanEntry; workload: CloudWorkloadEntity } =>
          item.workload !== undefined && (item.workload.postScript ?? '').trim().length > 0,
      );

    if (deletedIds.length === 0 && runEntries.length === 0) return null;

    const placeholders: CreateWorkloadLogInput[] = deletedIds.map((id) => ({
      containerId,
      workloadId: id,
      workloadName: DELETED_WORKLOAD_NAME,
      phase: 'post',
      status: 'failed',
      script: '',
      params: {},
      required: false,
      log: DELETED_WORKLOAD_POST_LOG,
      exitCode: null,
      startedAt: null,
      finishedAt: now,
    }));

    // 裁决 8：无活跃连接不等待预算，直接如实记录「未执行」。
    if (!this.deps.isConnected(containerId)) {
      await this.deps.workloadLogRepository.createMany(placeholders);
      if (runEntries.length > 0) {
        const inputs: CreateWorkloadLogInput[] = runEntries.map((item) => ({
          containerId,
          workloadId: item.workload.id,
          workloadName: item.workload.name,
          phase: 'post',
          status: 'timeout',
          script: item.workload.postScript ?? '',
          params: item.entry.params ?? {},
          required: false,
          log: DISCONNECTED_LOG,
          exitCode: null,
          startedAt: null,
          finishedAt: now,
        }));
        await this.deps.workloadLogRepository.createMany(inputs);
      }
      return null;
    }

    await this.deps.workloadLogRepository.createMany(placeholders);

    if (runEntries.length === 0) return null;

    const inputs: CreateWorkloadLogInput[] = runEntries.map((item, index) => ({
      containerId,
      workloadId: item.workload.id,
      workloadName: item.workload.name,
      phase: 'post',
      status: index === 0 ? 'running' : 'pending',
      script: item.workload.postScript ?? '',
      params: item.entry.params ?? {},
      required: false,
      log: '',
      exitCode: null,
      startedAt: index === 0 ? now : null,
      finishedAt: null,
    }));
    const logs = await this.deps.workloadLogRepository.createMany(inputs);
    const runEnv = this.resolveRunEnv(container);
    if (!runEnv.ok) {
      // post 批次不阻断销毁：仅跳过 env 并告警（不含 secret 内容）。
      this.deps.logger?.warn?.(
        `[workload] harness env unavailable containerId=${containerId} (post batch without env)`,
      );
    }
    // 仍持有容器互斥锁：先注册 waiter 再 emit，杜绝「结果先到、waiter 未注册」的窗口。
    const wait = this.createWaiter(containerId, this.deps.postBudgetMs);
    this.emitRun(containerId, 'post', logs, runEnv.ok ? runEnv.env : undefined);
    return { wait };
  }

  /** 创建并注册 post 等待者（注册与预算定时器均在本方法内同步建立）。 */
  private createWaiter(containerId: string, budgetMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = (): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.removeWaiter(containerId, waiter);
        resolve();
      };
      this.addWaiter(containerId, waiter);
      timer = setTimeout(() => {
        void this.expirePostBatch(containerId).finally(waiter);
      }, Math.max(budgetMs, 0));
      timer.unref?.();
    });
  }

  /** 预算耗尽：剩余 post 记录标 TIMEOUT（契约 §2.9/§2.10）。 */
  private async expirePostBatch(containerId: string): Promise<void> {
    await this.mutex.runExclusive(containerId, async () => {
      const active = await this.deps.workloadLogRepository.findActiveByContainer(containerId, 'post');
      const now = new Date(this.now());
      for (const log of active) {
        await this.deps.workloadLogRepository.updateById(log.id, {
          status: 'timeout',
          log: appendLog(log.log, POST_BUDGET_EXCEEDED_LOG),
          finishedAt: now,
        });
      }
    });
  }

  /**
   * 看门狗（并入 StatusSyncService 15s 巡检，裁决 10）：
   * RUNNING 停留 > timeoutMs + 30s → TIMEOUT 并推进；无 RUNNING 但 PENDING > 60s → 推进；
   * initializing 停留 > items × initTimeoutMs + 120s → 剩余记录全部 TIMEOUT 并收口。
   */
  async onWatchdog(now: number = this.now()): Promise<void> {
    const records = await this.deps.containerRepository.findAll();
    for (const record of records) {
      if (record.status !== 'initializing') continue;
      const reason = await this.mutex.runExclusive(record.id, () =>
        this.watchdogInitializing(record.id, now),
      );
      if (reason) {
        await this.forceDestroy(record.id, reason);
      }
    }
  }

  /** 返回必须失败的 `exitReason`（需锁外 `forceDestroy`）；无必须失败返回 `null`。 */
  private async watchdogInitializing(
    containerId: string,
    now: number,
  ): Promise<string | null> {
    const container = await this.deps.containerRepository.findById(containerId);
    if (!container || container.status !== 'initializing') return null;

    // 缺陷修复：上一轮必须失败的注销尚未完成（forceDestroy 失败/在途）→ 重试销毁，绝不收口为 online。
    if (container.mustFailure) {
      return container.exitReason ?? this.requiredFailureReason('(未知)');
    }

    const initLogs = (await this.deps.workloadLogRepository.findByContainer(containerId)).filter(
      (log) => log.phase === 'init',
    );
    const activeInit = initLogs.filter((log) => !isTerminalWorkloadLogStatus(log.status));
    if (activeInit.length === 0) {
      await this.finishInit(containerId);
      return null;
    }

    const running = activeInit.find((log) => log.status === 'running');
    if (running) {
      const startedAt = (running.startedAt ?? running.createdAt).getTime();
      if (now - startedAt > this.deps.initTimeoutMs + RUNNING_STUCK_GRACE_MS) {
        await this.deps.workloadLogRepository.updateById(running.id, {
          status: 'timeout',
          log: appendLog(running.log, INIT_TIMEOUT_LOG),
          finishedAt: new Date(now),
        });
        // 裁决 8：单条 RUNNING 必须项超时 → 标 timeout 并返回信号（不 advance）。
        if (running.required) {
          const reason = this.requiredFailureReason(running.workloadName);
          await this.markMustFailure(containerId, reason);
          return reason;
        }
        await this.advance(containerId, 'init');
        return null;
      }
    } else {
      const pending = activeInit.find((log) => log.status === 'pending');
      if (pending && now - pending.createdAt.getTime() > PENDING_STUCK_MS) {
        await this.deps.workloadLogRepository.updateById(pending.id, {
          status: 'running',
          startedAt: new Date(now),
        });
        await this.deps.containerService.markInitializing(containerId, pending.workloadName);
        return null;
      }
    }

    const batchStart = Math.min(
      ...initLogs.map((log) => (log.startedAt ?? log.createdAt).getTime()),
    );
    const budget = initLogs.length * this.deps.initTimeoutMs + INIT_WATCHDOG_EXTRA_MS;
    if (now - batchStart > budget) {
      for (const log of activeInit) {
        await this.deps.workloadLogRepository.updateById(log.id, {
          status: 'timeout',
          log: appendLog(log.log, INIT_TIMEOUT_LOG),
          finishedAt: new Date(now),
        });
      }
      // 裁决 8：批次超时且剩余 activeInit 含必须项 → 返回信号（不 finishInit）。
      const requiredActive = activeInit.find((log) => log.required);
      if (requiredActive) {
        const reason = this.requiredFailureReason(requiredActive.workloadName);
        await this.markMustFailure(containerId, reason);
        return reason;
      }
      await this.finishInit(containerId);
    }
    return null;
  }

  private emitRun(
    containerId: string,
    phase: WorkloadLogPhase,
    logs: CloudWorkloadLogEntity[],
    env?: Record<string, string>,
    githubAuth?: boolean,
  ): void {
    const payload: Record<string, unknown> = {
      phase,
      items: logs.map((log) => ({
        logId: log.id,
        workloadId: log.workloadId,
        workloadName: log.workloadName,
        script: log.script,
        params: log.params ?? {},
        // post 阶段不参与必须判定，固定 false（裁决 1）；init 沿用计划快照。
        required: phase === 'init' ? log.required === true : false,
        timeoutMs: phase === 'init' ? this.deps.initTimeoutMs : this.deps.postBudgetMs,
      })),
    };
    if (phase === 'post') payload.budgetMs = this.deps.postBudgetMs;
    // 仅 Git 设置批次携带 githubAuth，普通批次保持报文形状零变化。
    if (githubAuth === true) payload.githubAuth = true;
    // 仅 harness 携带 env；普通容器保持报文形状不变（无 env 键）。
    if (env) payload.env = env;
    this.deps.emitToContainer(containerId, WORKLOAD_RUN_EVENT, payload);
  }

  private addWaiter(containerId: string, waiter: () => void): void {
    const set = this.postWaiters.get(containerId) ?? new Set<() => void>();
    set.add(waiter);
    this.postWaiters.set(containerId, set);
  }

  private removeWaiter(containerId: string, waiter: () => void): void {
    const set = this.postWaiters.get(containerId);
    if (!set) return;
    set.delete(waiter);
    if (set.size === 0) this.postWaiters.delete(containerId);
  }

  private resolvePostWaiters(containerId: string): void {
    const set = this.postWaiters.get(containerId);
    if (!set) return;
    this.postWaiters.delete(containerId);
    for (const waiter of [...set]) waiter();
  }
}
