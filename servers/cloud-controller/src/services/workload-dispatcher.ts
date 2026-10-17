import type { ContainerRepository } from '../repositories/container-repository.js';
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
  /** 可注入的时钟（测试确定性用），默认 `Date.now`。 */
  now?: () => number;
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
   * 返回 `true` 表示容器现在处于/进入 `initializing`（调用方不要再 markOnline）；
   * 返回 `false` 表示无初始化脚本（或纯占位记录）→ 调用方按现状 markOnline。
   * 重连（已是 `initializing`）不重发批次（裁决 6）。
   */
  async startInit(containerId: string): Promise<boolean> {
    return this.mutex.runExclusive(containerId, () => this.startInitLocked(containerId));
  }

  private async startInitLocked(containerId: string): Promise<boolean> {
    const container = await this.deps.containerRepository.findById(containerId);
    if (!container) return false;
    if (container.status === 'initializing') return true;
    // 仅 creating/connecting（回连注册路径）触发初始化；online 重连不重跑。
    if (container.status !== 'connecting' && container.status !== 'creating') return false;

    const workloadIds = container.workloadIds ?? [];
    if (workloadIds.length === 0) return false;

    const workloads = await this.deps.workloadRepository.findByIds(workloadIds);
    const byId = new Map(workloads.map((workload) => [workload.id, workload]));

    interface Entry {
      workloadId: string;
      workloadName: string;
      script: string;
      deleted: boolean;
    }

    const entries: Entry[] = [];
    for (const id of workloadIds) {
      const workload = byId.get(id);
      if (!workload) {
        // 裁决 3：执行前被删除 → 生成 FAILED 占位记录，不阻断上线。
        entries.push({
          workloadId: id,
          workloadName: DELETED_WORKLOAD_NAME,
          script: '',
          deleted: true,
        });
        continue;
      }
      const script = workload.initScript ?? '';
      if (script.trim().length === 0) continue;
      entries.push({ workloadId: id, workloadName: workload.name, script, deleted: false });
    }

    if (entries.length === 0) return false;

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
        log: '',
        exitCode: null,
        startedAt: isFirst ? now : null,
        finishedAt: null,
      };
    });

    const logs = await this.deps.workloadLogRepository.createMany(inputs);
    const runLogs = logs.filter((log) => !isTerminalWorkloadLogStatus(log.status));
    if (runLogs.length === 0) {
      // 全部为已删除占位记录：不进入 initializing。
      return false;
    }

    await this.deps.containerService.markInitializing(containerId, runLogs[0]!.workloadName);
    this.emitRun(containerId, 'init', runLogs);
    return true;
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
    if (container.status !== 'connecting' && container.status !== 'creating') return false;
    const workloadIds = container.workloadIds ?? [];
    if (workloadIds.length === 0) return false;
    const workloads = await this.deps.workloadRepository.findByIds(workloadIds);
    // 有已删除项：仍需走初始化流程以生成 FAILED 留档记录（裁决 3）。
    if (workloads.length < workloadIds.length) return true;
    return workloads.some((workload) => (workload.initScript ?? '').trim().length > 0);
  }

  /** 处理单条 `workload:result`（校验归属、终态幂等、推进下一条/收口）。 */
  async handleResult(containerId: string, payload: WorkloadResultPayload): Promise<void> {
    await this.mutex.runExclusive(containerId, () => this.handleResultLocked(containerId, payload));
  }

  private async handleResultLocked(
    containerId: string,
    payload: WorkloadResultPayload,
  ): Promise<void> {
    const logId = typeof payload?.logId === 'string' ? payload.logId : '';
    if (!logId) {
      this.deps.logger?.warn?.(`[workload] result missing logId containerId=${containerId}`);
      return;
    }
    const record = await this.deps.workloadLogRepository.findById(logId);
    if (!record) {
      this.deps.logger?.warn?.(
        `[workload] result for unknown logId=${logId} containerId=${containerId}`,
      );
      return;
    }
    if (record.containerId !== containerId) {
      this.deps.logger?.warn?.(
        `[workload] result logId=${logId} does not belong to containerId=${containerId} ` +
          `(actual=${record.containerId})`,
      );
      return;
    }
    if (isTerminalWorkloadLogStatus(record.status)) return; // 幂等：终态忽略迟到/重放结果

    const status = normalizeResultStatus(payload.status);
    const exitCode =
      typeof payload.exitCode === 'number' && Number.isFinite(payload.exitCode)
        ? payload.exitCode
        : null;
    const log = truncateLogTail(
      typeof payload.log === 'string' ? payload.log : '',
      this.deps.logMaxBytes,
    );
    await this.deps.workloadLogRepository.updateById(logId, {
      status,
      exitCode,
      log,
      finishedAt: new Date(this.now()),
    });
    await this.advance(containerId, record.phase);
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

  /** init 全部终态：有活跃 socket → online，否则 connecting（裁决 5）。 */
  private async finishInit(containerId: string): Promise<void> {
    const container = await this.deps.containerRepository.findById(containerId);
    if (!container || container.status !== 'initializing') return;
    if (this.deps.isConnected(containerId)) {
      await this.deps.containerService.markOnline(containerId);
    } else {
      await this.deps.containerService.markConnecting(containerId);
    }
  }

  /** 是否存在带 `postScript` 的挂载工作负载（容器尚存时）。 */
  async hasPostScripts(containerId: string): Promise<boolean> {
    const container = await this.deps.containerRepository.findById(containerId);
    if (!container || (container.workloadIds ?? []).length === 0) return false;
    const workloads = await this.deps.workloadRepository.findByIds(container.workloadIds);
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

    const workloadIds = container.workloadIds ?? [];
    if (workloadIds.length === 0) return null;

    const workloads = await this.deps.workloadRepository.findByIds(workloadIds);
    const byId = new Map(workloads.map((workload) => [workload.id, workload]));

    // 建议 7：已删除工作负载也留一条 FAILED 占位（清理阶段未执行），与 init 阶段
    // （裁决 3）口径一致，避免静默丢失留档。
    const deletedIds = workloadIds.filter((id) => !byId.has(id));
    const runEntries = workloadIds
      .map((id) => byId.get(id))
      .filter((workload): workload is CloudWorkloadEntity => {
        return workload !== undefined && (workload.postScript ?? '').trim().length > 0;
      });

    if (deletedIds.length === 0 && runEntries.length === 0) return null;

    const placeholders: CreateWorkloadLogInput[] = deletedIds.map((id) => ({
      containerId,
      workloadId: id,
      workloadName: DELETED_WORKLOAD_NAME,
      phase: 'post',
      status: 'failed',
      script: '',
      log: DELETED_WORKLOAD_POST_LOG,
      exitCode: null,
      startedAt: null,
      finishedAt: now,
    }));

    // 裁决 8：无活跃连接不等待预算，直接如实记录「未执行」。
    if (!this.deps.isConnected(containerId)) {
      await this.deps.workloadLogRepository.createMany(placeholders);
      if (runEntries.length > 0) {
        const inputs: CreateWorkloadLogInput[] = runEntries.map((workload) => ({
          containerId,
          workloadId: workload.id,
          workloadName: workload.name,
          phase: 'post',
          status: 'timeout',
          script: workload.postScript ?? '',
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

    const inputs: CreateWorkloadLogInput[] = runEntries.map((workload, index) => ({
      containerId,
      workloadId: workload.id,
      workloadName: workload.name,
      phase: 'post',
      status: index === 0 ? 'running' : 'pending',
      script: workload.postScript ?? '',
      log: '',
      exitCode: null,
      startedAt: index === 0 ? now : null,
      finishedAt: null,
    }));
    const logs = await this.deps.workloadLogRepository.createMany(inputs);
    // 仍持有容器互斥锁：先注册 waiter 再 emit，杜绝「结果先到、waiter 未注册」的窗口。
    const wait = this.createWaiter(containerId, this.deps.postBudgetMs);
    this.emitRun(containerId, 'post', logs);
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
      await this.mutex.runExclusive(record.id, () => this.watchdogInitializing(record.id, now));
    }
  }

  private async watchdogInitializing(containerId: string, now: number): Promise<void> {
    const container = await this.deps.containerRepository.findById(containerId);
    if (!container || container.status !== 'initializing') return;

    const initLogs = (await this.deps.workloadLogRepository.findByContainer(containerId)).filter(
      (log) => log.phase === 'init',
    );
    const activeInit = initLogs.filter((log) => !isTerminalWorkloadLogStatus(log.status));
    if (activeInit.length === 0) {
      await this.finishInit(containerId);
      return;
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
        await this.advance(containerId, 'init');
        return;
      }
    } else {
      const pending = activeInit.find((log) => log.status === 'pending');
      if (pending && now - pending.createdAt.getTime() > PENDING_STUCK_MS) {
        await this.deps.workloadLogRepository.updateById(pending.id, {
          status: 'running',
          startedAt: new Date(now),
        });
        await this.deps.containerService.markInitializing(containerId, pending.workloadName);
        return;
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
      await this.finishInit(containerId);
    }
  }

  private emitRun(
    containerId: string,
    phase: WorkloadLogPhase,
    logs: CloudWorkloadLogEntity[],
  ): void {
    const payload: Record<string, unknown> = {
      phase,
      items: logs.map((log) => ({
        logId: log.id,
        workloadName: log.workloadName,
        script: log.script,
        timeoutMs: phase === 'init' ? this.deps.initTimeoutMs : this.deps.postBudgetMs,
      })),
    };
    if (phase === 'post') payload.budgetMs = this.deps.postBudgetMs;
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
