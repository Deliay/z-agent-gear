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
  /** 工作负载名称，仅用于日志/展示。 */
  workloadName: string;
  /** 待执行脚本内容；空字符串表示该条为已删除工作负载的占位记录。 */
  script: string;
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
 * 工作负载脚本执行器（agent-gear 侧）。
 *
 * - 按 `items` 顺序**串行**执行 `bash -c <script>`（`cwd=os.homedir()`，继承进程环境，stdout/stderr 合并捕获）；
 * - 单条超时或收到新批次时终止整个进程组（`detached: true` + `kill(-pid)`）；
 * - 非零退出回报 `failed` + `exitCode`，不影响后续条目；
 * - `post` 批次共享 `budgetMs`：剩余预算耗尽时后续条目直接回报 `timeout`（不启动进程）；
 * - 未被服务端确认的结果保存在内存（上限 50 条）供重连重放。
 *
 * 进程内全局单实例，保证同一时间只跑一个批次（后到的批次打断前一个，用于 post 打断 init）。
 */
export class WorkloadExecutor {
  private active: ActiveRun | null = null;
  private activePromise: Promise<void> | null = null;
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
  runBatch(payload: WorkloadRunPayload, onResult: WorkloadResultSink): Promise<void> {
    this.interruptActive();

    const run: ActiveRun = { cancelled: false, child: null };
    this.active = run;
    const promise = this.executeBatch(payload, onResult, run).finally(() => {
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
  ): Promise<void> {
    const items = Array.isArray(payload?.items) ? payload.items : [];
    if (items.length === 0) return;

    const budgetMs = typeof payload.budgetMs === 'number' && payload.budgetMs > 0 ? payload.budgetMs : null;
    const batchStart = Date.now();

    for (const item of items) {
      if (run.cancelled) return;

      let effectiveTimeoutMs = item.timeoutMs;
      if (budgetMs !== null) {
        const remaining = budgetMs - (Date.now() - batchStart);
        if (remaining <= 0) {
          // 预算耗尽：后续条目不再启动进程，直接回报 timeout
          this.report(onResult, this.emptyResult(item.logId, 'timeout', ''));
          continue;
        }
        effectiveTimeoutMs = Math.min(item.timeoutMs, remaining);
      }

      if (!item.script || item.script.trim().length === 0) {
        this.report(onResult, this.emptyResult(item.logId, 'failed', EMPTY_SCRIPT_MESSAGE));
        continue;
      }

      const outcome = await this.executeItem(item, effectiveTimeoutMs, run);
      if (outcome.cancelled) return;
      if (outcome.result) this.report(onResult, outcome.result);
    }
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

  private executeItem(item: WorkloadItem, timeoutMs: number, run: ActiveRun): Promise<ItemOutcome> {
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
          env: process.env,
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
