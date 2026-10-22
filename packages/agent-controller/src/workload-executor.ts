import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';

/**
 * 单条脚本的尾部输出上限（256 KiB），与 cloud-controller 的 `WORKLOAD_LOG_MAX_BYTES` 对齐。
 */
export const MAX_OUTPUT_BYTES = 256 * 1024;

/** 未确认执行结果在内存中的保留上限（重连重放用）。 */
export const MAX_PENDING_RESULTS = 50;

/** 空 script（含纯空白）的失败文案。 */
export const EMPTY_SCRIPT_MESSAGE = '工作负载脚本为空，跳过执行';

export interface WorkloadItem {
  /** 服务端预创建的执行记录 ID，回报时原样回填（防串号）。 */
  logId: string;
  /** 工作负载 ID，仅用于日志/排查，不影响执行顺序与结果结构。 */
  workloadId?: string;
  /** 工作负载名称，仅用于日志/展示。 */
  workloadName: string;
  /** 待执行脚本内容；空字符串表示该条为已删除工作负载的占位记录。 */
  script: string;
  /** 本次执行参数，键为参数标识；缺省 `{}`（等价旧行为）。 */
  params?: Record<string, unknown>;
  /**
   * 本次启动该条是否为「必须」项（仅 `phase=init` 有意义，缺省/非 true 按非必须）。
   * 服务端为唯一裁决；worker 仅在该项失败/超时后省去后续无谓执行。
   */
  required?: boolean;
  /** 单条脚本超时（毫秒）。 */
  timeoutMs: number;
}

export interface WorkloadRunPayload {
  /** `init`：回连注册后的初始化批次；`post`：销毁流程中的清理批次。 */
  phase: 'init' | 'post';
  /** 按执行顺序排列的脚本条目。 */
  items: WorkloadItem[];
  /** `post` 批次共享总预算（毫秒）；`init` 不携带。 */
  budgetMs?: number;
  /**
   * 容器级环境变量（仅 `purpose=harness` 下发，如 `ZAG_MODEL_*` / `ZAG_HOST_*`）。
   * 对批次内所有 item 生效；`item.params` 派生的 `WORKLOAD_PARAM_*` 同名时优先。
   */
  env?: Record<string, string>;
  /**
   * `true` 时必须在执行本批第一条脚本前完成 gh 凭据申请与写入（由 `beforeGithubAuth` 承担）；
   * 缺省/false 行为与旧版完全一致。
   */
  githubAuth?: boolean;
}

/** `runBatch` 的可选行为注入（默认空实现，保证旧调用方零变化）。 */
export interface WorkloadRunOptions {
  /**
   * `payload.githubAuth === true` 时、执行首条脚本前调用一次。
   * 抛错时本批所有 item 直接回报 `failed`，且不启动任何脚本。
   */
  beforeGithubAuth?: (payload: WorkloadRunPayload) => Promise<void>;
}

/** 需要在日志/错误/脚本输出中脱敏的环境变量名（契约 §2.9「云电脑初始化 env」）。 */
export const SECRET_ENV_KEYS = ['ZAG_MODEL_API_KEY', 'ZAG_HOST_KEY', 'ZAG_CONTROLLER_KEY'] as const;

/** 脱敏占位符。 */
export const REDACTED = '***';

/**
 * 收集需要脱敏的 secret 值（仅非空值；调用方可叠加批次 `env` 与 `process.env`）。
 */
export function collectSecretValues(...sources: Array<Record<string, string | undefined> | undefined>): string[] {
  const values = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    for (const key of SECRET_ENV_KEYS) {
      const value = source[key];
      if (typeof value === 'string' && value.length > 0) values.add(value);
    }
  }
  // 长值优先替换，避免短 secret 是长 secret 的子串时留下残片。
  return [...values].sort((a, b) => b.length - a.length);
}

/** 将文本中出现的 secret 值替换为 `***`（日志、错误与脚本输出统一口径）。 */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let result = text;
  for (const secret of secrets) {
    if (!secret) continue;
    result = result.split(secret).join(REDACTED);
  }
  return result;
}

export interface WorkloadBatchOutcome {
  /** 批次是否被新批次/销毁流程打断（打断时不得视为初始化完成）。 */
  cancelled: boolean;
  /** 已上报的失败/超时条目数（含 required 短路前的当前条）。 */
  failedCount: number;
  /** 本批条目总数。 */
  total: number;
}

export type WorkloadStatus = 'success' | 'failed' | 'timeout';

export interface WorkloadResult {
  logId: string;
  status: WorkloadStatus;
  /** 进程退出码；`timeout` 时为 `null`。 */
  exitCode: number | null;
  /** 合并捕获的 stdout+stderr（尾部 ≤ 256 KiB）。 */
  log: string;
  /** 客户端记录的开始时间（ISO；服务端时间戳为准）。 */
  startedAt: string;
  /** 客户端记录的结束时间（ISO）。 */
  finishedAt: string;
}

export type WorkloadResultSink = (result: WorkloadResult) => void;

interface ActiveRun {
  cancelled: boolean;
  child: ChildProcess | null;
}

interface ItemOutcome {
  cancelled: boolean;
  result?: WorkloadResult;
}

/**
 * 单条脚本输出的尾部环形截断缓冲：始终保留最近 `limit` 字节。
 *
 * 大输出脚本（如构建日志、循环 echo）若不截断会打爆内存与 Mongo，
 * 契约要求保留尾部 ≤ 256 KiB（尾部通常包含真正的错误信息）。
 */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit && this.chunks.length > 0) {
      const first = this.chunks[0];
      const excess = this.size - this.limit;
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
    }
  }

  toString(): string {
    const buffer = Buffer.concat(this.chunks);
    // 截断保留尾部时，起始处可能落在多字节 UTF-8 字符的续字节上（0b10xxxxxx），
    // 直接解码会在日志首字符产生乱码（U+FFFD）；跳过续字节到字符边界再解码
    // （与服务端 `truncateLogTail` 同一口径）。
    let start = 0;
    while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
    return buffer.subarray(start).toString('utf8');
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 归一容器级 `env`：只接受字符串键值（服务端报文里 `ZAG_*` 均为字符串），
 * 非对象/数组一律视为未下发（普通容器行为不变）。
 */
function normalizeContainerEnv(env: Record<string, string> | undefined): Record<string, string> {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key || typeof value !== 'string') continue;
    normalized[key] = value;
  }
  return normalized;
}

/** 单个参数值 → 环境变量字符串（契约 §2.9「参数注入约定」）。 */
function encodeParamValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value === null || value === undefined) return '';
  // MULTI_SELECT 等复合值：JSON 数组字符串（脚本自行解析）
  return JSON.stringify(value);
}

/**
 * 由 `process.env` + 容器级 `env` 派生单条 item 的执行环境：
 * - 容器级 `env`（harness 下发的 `ZAG_*`）先合并，对批次所有 item 生效；
 * - `WORKLOAD_PARAMS`：完整参数 JSON 字符串（缺省 `{}`）；
 * - `WORKLOAD_PARAM_<KEY_UPPER>`：单值编码（字符串原样、布尔 `"true"`/`"false"`、多选 JSON 数组字符串），
 *   同名时**覆盖**容器 `env`（item 参数优先）。
 *
 * 每次 spawn 都重新派生，参数 env 仅对当前 item 生效、不污染后续脚本；
 * 不修改脚本文本、不做字符串替换（避免注入）。
 */
function buildWorkloadEnv(
  params: Record<string, unknown> | undefined,
  containerEnv: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const normalized = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...normalizeContainerEnv(containerEnv),
    WORKLOAD_PARAMS: JSON.stringify(normalized),
  };
  for (const [key, value] of Object.entries(normalized)) {
    if (!key || value === null || value === undefined) continue;
    env[`WORKLOAD_PARAM_${key.toUpperCase()}`] = encodeParamValue(value);
  }
  return env;
}

/**
 * 工作负载脚本执行器（agent-gear 侧）。
 *
 * - 按 `items` 顺序**串行**执行 `bash -c <script>`（`cwd=os.homedir()`，继承进程环境并按 item 注入
 *   `WORKLOAD_PARAMS` / `WORKLOAD_PARAM_*`，stdout/stderr 合并捕获）；
 * - 单条超时或收到新批次时终止整个进程组（`detached: true` + `kill(-pid)`）；
 * - 非零退出回报 `failed` + `exitCode`，不影响后续条目；**例外**：`init` 阶段的必须项
 *   （`item.required === true`）失败/超时后不再启动后续条目（服务端仍会中断剩余记录并注销容器）；
 * - `post` 批次共享 `budgetMs`：剩余预算耗尽时后续条目直接回报 `timeout`（不启动进程）；
 * - 未被服务端确认的结果保存在内存（上限 50 条）供重连重放。
 *
 * 进程内全局单实例，保证同一时间只跑一个批次（后到的批次打断前一个，用于 post 打断 init）。
 */
export class WorkloadExecutor {
  private active: ActiveRun | null = null;
  private activePromise: Promise<WorkloadBatchOutcome> | null = null;
  private pendingResults: WorkloadResult[] = [];

  /** 当前是否有批次正在执行。 */
  isRunning(): boolean {
    return this.active !== null;
  }

  /** 未确认的执行结果快照（供重连重放读取）。 */
  getPendingResults(): WorkloadResult[] {
    return [...this.pendingResults];
  }

  /** 清空未确认的执行结果。 */
  clearPendingResults(): void {
    this.pendingResults = [];
  }

  /**
   * 重连后重放未确认结果：逐条 emit 后清空缓冲。
   * 服务端对已进入终态的记录按幂等忽略（契约 §2.9/§2.10）。
   */
  replayPendingResults(emit: WorkloadResultSink): void {
    const pending = this.getPendingResults();
    this.clearPendingResults();
    for (const result of pending) {
      emit(result);
    }
  }

  /** 等待当前批次结束；无批次时立即返回，超时也返回（不阻塞退出流程）。 */
  async waitForIdle(timeoutMs: number): Promise<void> {
    const promise = this.activePromise;
    if (!this.active || !promise) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([promise.then(() => undefined, () => undefined), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 执行一个批次。若已有批次在跑，先终止其进程组并停止推进，再执行新批次。
   */
  runBatch(
    payload: WorkloadRunPayload,
    onResult: WorkloadResultSink,
    options: WorkloadRunOptions = {},
  ): Promise<WorkloadBatchOutcome> {
    this.interruptActive();

    const run: ActiveRun = { cancelled: false, child: null };
    this.active = run;
    const promise = this.executeBatch(payload, onResult, run, options).finally(() => {
      // 仅当自己仍是当前批次时才清空（被打断时 active 已指向新批次）
      if (this.active === run) {
        this.active = null;
        this.activePromise = null;
      }
    });
    this.activePromise = promise;
    return promise;
  }

  private async executeBatch(
    payload: WorkloadRunPayload,
    onResult: WorkloadResultSink,
    run: ActiveRun,
    options: WorkloadRunOptions = {},
  ): Promise<WorkloadBatchOutcome> {
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const total = items.length;
    let failedCount = 0;
    const outcome = (): WorkloadBatchOutcome => ({
      cancelled: run.cancelled,
      failedCount,
      total,
    });
    if (items.length === 0) return outcome();

    const budgetMs = typeof payload.budgetMs === 'number' && payload.budgetMs > 0 ? payload.budgetMs : null;
    const batchStart = Date.now();
    const phase = payload.phase;
    const containerEnv = normalizeContainerEnv(payload.env);
    const secrets = collectSecretValues(process.env, containerEnv);

    // Github 凭据预取：仅在显式 `githubAuth === true` 时触发，失败则整批逐条 failed、不启动脚本。
    // 缺省/false 时不调用 hook，行为与旧版完全一致。
    if (payload.githubAuth === true && options.beforeGithubAuth) {
      try {
        await options.beforeGithubAuth(payload);
      } catch (error) {
        if (run.cancelled) return outcome();
        const reason = error instanceof Error ? error.message : String(error);
        const message = redactSecrets(`Github 凭据申请失败：${reason}`, secrets);
        const now = nowIso();
        for (const item of items) {
          if (run.cancelled) return outcome();
          failedCount += 1;
          this.report(onResult, {
            logId: item.logId,
            status: 'failed',
            exitCode: null,
            log: message,
            startedAt: now,
            finishedAt: nowIso(),
          });
        }
        return outcome();
      }
      if (run.cancelled) return outcome();
    }

    for (const item of items) {
      if (run.cancelled) return outcome();

      // 必须项短路（省时优化，服务端仍为唯一裁决）：init 阶段的必须项失败/超时后，
      // 上报本条结果即结束本批，不再启动后续条目。post 批次不参与必须判定。
      const shortCircuitOnFailure = phase === 'init' && item.required === true;
      const reportThenMaybeStop = (result: WorkloadResult): boolean => {
        if (result.status !== 'success') failedCount += 1;
        const redactedLog = redactSecrets(result.log, secrets);
        this.report(onResult, redactedLog === result.log ? result : { ...result, log: redactedLog });
        return shortCircuitOnFailure && (result.status === 'failed' || result.status === 'timeout');
      };

      let effectiveTimeoutMs = item.timeoutMs;
      if (budgetMs !== null) {
        const remaining = budgetMs - (Date.now() - batchStart);
        if (remaining <= 0) {
          // 预算耗尽：后续条目不再启动进程，直接回报 timeout
          if (reportThenMaybeStop(this.emptyResult(item.logId, 'timeout', ''))) return outcome();
          continue;
        }
        effectiveTimeoutMs = Math.min(item.timeoutMs, remaining);
      }

      if (!item.script || item.script.trim().length === 0) {
        if (reportThenMaybeStop(this.emptyResult(item.logId, 'failed', EMPTY_SCRIPT_MESSAGE))) return outcome();
        continue;
      }

      const itemOutcome = await this.executeItem(item, effectiveTimeoutMs, run, containerEnv);
      if (itemOutcome.cancelled) return outcome();
      if (itemOutcome.result && reportThenMaybeStop(itemOutcome.result)) return outcome();
    }
    return outcome();
  }

  private report(onResult: WorkloadResultSink, result: WorkloadResult): void {
    this.pendingResults.push(result);
    while (this.pendingResults.length > MAX_PENDING_RESULTS) {
      this.pendingResults.shift();
    }
    onResult(result);
  }

  private emptyResult(logId: string, status: WorkloadStatus, log: string): WorkloadResult {
    const now = nowIso();
    return { logId, status, exitCode: null, log, startedAt: now, finishedAt: now };
  }

  private executeItem(
    item: WorkloadItem,
    timeoutMs: number,
    run: ActiveRun,
    containerEnv: Record<string, string>,
  ): Promise<ItemOutcome> {
    return new Promise<ItemOutcome>((resolve) => {
      if (run.cancelled) {
        resolve({ cancelled: true });
        return;
      }

      const startedAt = nowIso();
      let child: ChildProcess;
      try {
        child = spawn('bash', ['-c', item.script], {
          cwd: homedir(),
          detached: true,
          env: buildWorkloadEnv(item.params, containerEnv),
        });
      } catch (error) {
        resolve({
          cancelled: false,
          result: {
            logId: item.logId,
            status: 'failed',
            exitCode: null,
            log: `启动脚本失败: ${(error as Error).message}`,
            startedAt,
            finishedAt: nowIso(),
          },
        });
        return;
      }

      run.child = child;
      const tail = new TailBuffer(MAX_OUTPUT_BYTES);
      let settled = false;
      let timedOut = false;

      const finish = (outcome: ItemOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (run.child === child) run.child = null;
        resolve(outcome);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        this.killGroup(child);
      }, Math.max(1, timeoutMs));

      child.stdout?.on('data', (chunk: Buffer) => tail.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => tail.push(chunk));

      child.on('error', (error: Error) => {
        tail.push(Buffer.from(`\n[执行脚本失败] ${error.message}`));
        if (run.cancelled) {
          finish({ cancelled: true });
          return;
        }
        finish({
          cancelled: false,
          result: {
            logId: item.logId,
            status: 'failed',
            exitCode: null,
            log: tail.toString(),
            startedAt,
            finishedAt: nowIso(),
          },
        });
      });

      child.on('close', (code, signal) => {
        if (run.cancelled) {
          finish({ cancelled: true });
          return;
        }
        if (timedOut) {
          finish({
            cancelled: false,
            result: {
              logId: item.logId,
              status: 'timeout',
              exitCode: null,
              log: tail.toString(),
              startedAt,
              finishedAt: nowIso(),
            },
          });
          return;
        }
        const exitCode = code ?? (signal ? 1 : 0);
        finish({
          cancelled: false,
          result: {
            logId: item.logId,
            status: exitCode === 0 ? 'success' : 'failed',
            exitCode,
            log: tail.toString(),
            startedAt,
            finishedAt: nowIso(),
          },
        });
      });
    });
  }

  private interruptActive(): void {
    const run = this.active;
    if (!run) return;
    run.cancelled = true;
    this.killGroup(run.child);
  }

  private killGroup(child: ChildProcess | null): void {
    if (!child || child.pid == null) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* process already exited */
      }
    }
  }
}
