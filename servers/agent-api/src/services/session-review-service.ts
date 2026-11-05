import mongoose from 'mongoose';
import { SessionReview } from '../models/session-review.js';
import { sessionSSEService } from './session-sse.js';
import { actorFilter } from './workspace-context.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'session-review-service' });

/** Review MCP 长等待上限（契约 §2.12.1 / 裁决 9；env 可调，与 controller-api / agent-gear 同常量同默认） */
export const MCP_REVIEW_TIMEOUT_DEFAULT_MS = 1_800_000;

export function getMcpReviewTimeoutMs(): number {
  const raw = process.env.MCP_REVIEW_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : MCP_REVIEW_TIMEOUT_DEFAULT_MS;
}

export interface SessionReviewFileInput {
  path: string;
  absPath: string;
}

export interface SessionReviewSubmitInput {
  fileReviews: Record<string, unknown>;
  comment?: string | null;
  status: 'approve' | 'reject' | 'comment';
}

export type ReviewWaitResult =
  | { kind: 'resolved'; review: Record<string, unknown> }
  | { kind: 'cancelled'; reason: 'timeout' | 'session_closed' };

const ACTION_TO_STATUS: Record<SessionReviewSubmitInput['status'], string> = {
  approve: 'APPROVED',
  reject: 'REJECTED',
  comment: 'COMMENTED',
};

interface Waiter {
  resolve: (result: ReviewWaitResult) => void;
  timer: NodeJS.Timeout;
}

/**
 * SessionReview 领域服务：状态机 + 等待器 + 自动取消。
 *
 * **单实例前提**：等待器为进程内 `Map`（与 `KeyedMutex` / 工作流中断重试调度器同前提），
 * 多副本部署会导致超时取消与唤醒只发生在单个进程；当前 agent-api 为单实例部署。
 */
export class SessionReviewService {
  private waiters = new Map<string, Waiter>();

  private mapReview(doc: Record<string, unknown>): Record<string, unknown> {
    const id = String(doc._id);
    return {
      id,
      sessionId: String(doc.sessionId),
      files: ((doc.files ?? []) as Array<{ path: string }>).map((file) => file.path),
      status: doc.status,
      fileReviews: doc.fileReviews ?? null,
      comment: doc.comment ?? null,
      cancelReason: doc.cancelReason ?? null,
      createdAt: (doc.createdAt instanceof Date ? doc.createdAt.toISOString() : String(doc.createdAt ?? '')) ,
      resolvedAt: doc.resolvedAt instanceof Date ? doc.resolvedAt.toISOString() : doc.resolvedAt ? String(doc.resolvedAt) : null,
    };
  }

  private notify(userId: string, type: 'session_review_requested' | 'session_review_updated', review: Record<string, unknown>): void {
    try {
      sessionSSEService.pushToUser(userId, { type, data: { review } });
    } catch (err) {
      log.warn({ err, type, reviewId: review.id }, 'push review SSE failed');
    }
  }

  /** MCP review 工具创建 Review（PENDING + session_review_requested SSE） */
  async createForMcp(input: {
    userId: string;
    tenantId?: string | null;
    sessionId: string;
    controllerId: string;
    files: SessionReviewFileInput[];
    summary?: string | null;
  }): Promise<Record<string, unknown>> {
    const doc = await SessionReview.create({
      userId: input.userId,
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      sessionId: input.sessionId,
      controllerId: input.controllerId,
      files: input.files,
      summary: input.summary ?? undefined,
      status: 'PENDING',
      createdAt: new Date(),
    });
    const mapped = this.mapReview(doc.toObject() as Record<string, unknown>);
    this.notify(input.userId, 'session_review_requested', mapped);
    return mapped;
  }

  /** Review 列表：PENDING 在前、终态按 resolvedAt 倒序、上限 20（HomeOverview 分支复用） */
  async listByUser(
    userId: string,
    options: { status?: string | null; sessionId?: string | null; limit?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const filter: Record<string, unknown> = { ...actorFilter(userId) };
    if (options.status) filter.status = options.status;
    if (options.sessionId && mongoose.isValidObjectId(options.sessionId)) {
      filter.sessionId = new mongoose.Types.ObjectId(options.sessionId);
    }
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 20);
    const docs = await SessionReview.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit * 2)
      .lean();
    const mapped = docs.map((doc) => this.mapReview(doc as unknown as Record<string, unknown>));
    // PENDING 在前（创建序倒序），终态按 resolvedAt 倒序（裁决：PENDING 优先、终态 resolvedAt 倒序），收敛到上限
    const pending = mapped
      .filter((item) => item.status === 'PENDING')
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const resolved = mapped
      .filter((item) => item.status !== 'PENDING')
      .sort((a, b) => String(b.resolvedAt ?? '').localeCompare(String(a.resolvedAt ?? '')));
    return [...pending, ...resolved].slice(0, limit);
  }

  async findById(userId: string, id: string): Promise<Record<string, unknown> | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await SessionReview.findOne({
      _id: id,
      ...actorFilter(userId),
    }).lean();
    return doc ? this.mapReview(doc as unknown as Record<string, unknown>) : null;
  }

  /**
   * 提交评审结论：PENDING→终态 CAS（防重复提交 / 与取消竞争），唤醒等待器并发
   * `session_review_updated` SSE；CAS 未命中抛 `Review not found or already resolved`。
   */
  async submit(userId: string, id: string, input: SessionReviewSubmitInput): Promise<Record<string, unknown>> {
    if (!mongoose.isValidObjectId(id)) {
      throw new Error('Review not found or already resolved');
    }
    const doc = await SessionReview.findOneAndUpdate(
      {
        _id: id,
        status: 'PENDING',
        ...actorFilter(userId),
      },
      {
        $set: {
          status: ACTION_TO_STATUS[input.status] ?? 'COMMENTED',
          fileReviews: input.fileReviews ?? {},
          comment: input.comment ?? undefined,
          resolvedAt: new Date(),
        },
      },
      { new: true },
    ).lean();
    if (!doc) {
      throw new Error('Review not found or already resolved');
    }
    const mapped = this.mapReview(doc as unknown as Record<string, unknown>);
    this.wakeWaiter(String(doc._id), { kind: 'resolved', review: mapped });
    this.notify(String(doc.userId), 'session_review_updated', mapped);
    return mapped;
  }

  /** 会话关闭/结束收敛：PENDING 批量 CAS → CANCELLED 并按 session_closed 唤醒 */
  async cancelBySession(sessionId: string, reason: 'session_closed' | 'timeout' = 'session_closed'): Promise<number> {
    if (!mongoose.isValidObjectId(sessionId)) return 0;
    const pending = await SessionReview.find({ sessionId, status: 'PENDING' }).lean();
    if (pending.length === 0) return 0;
    const ids = pending.map((doc) => doc._id);
    await SessionReview.updateMany(
      { _id: { $in: ids }, status: 'PENDING' },
      { $set: { status: 'CANCELLED', cancelReason: reason, resolvedAt: new Date() } },
    );
    for (const doc of pending) {
      const mapped = this.mapReview({ ...(doc as unknown as Record<string, unknown>), status: 'CANCELLED', cancelReason: reason, resolvedAt: new Date() });
      this.wakeWaiter(String(doc._id), { kind: 'cancelled', reason });
      this.notify(String(doc.userId), 'session_review_updated', mapped);
    }
    return pending.length;
  }

  /**
   * 等待 Review 终态（MCP review 工具同步等待；超时上限 30min）。
   * 超时自行 CAS PENDING→CANCELLED(timeout) 并按 cancelled 唤醒。
   */
  waitForResolution(reviewId: string, timeoutMs?: number): Promise<ReviewWaitResult> {
    const existing = this.waiters.get(reviewId);
    if (existing) {
      // 同一 Review 的并发等待合并（以先注册的等待器为准）
      return new Promise<ReviewWaitResult>((resolve) => {
        const prev = existing.resolve;
        existing.resolve = (result) => {
          prev(result);
          resolve(result);
        };
      });
    }
    return new Promise<ReviewWaitResult>((resolve) => {
      const timer = setTimeout(() => {
        void this.timeoutReview(reviewId);
      }, timeoutMs ?? getMcpReviewTimeoutMs());
      timer.unref?.();
      this.waiters.set(reviewId, { resolve, timer });
    });
  }

  private async timeoutReview(reviewId: string): Promise<void> {
    try {
      const doc = await SessionReview.findOneAndUpdate(
        { _id: reviewId, status: 'PENDING' },
        { $set: { status: 'CANCELLED', cancelReason: 'timeout', resolvedAt: new Date() } },
        { new: true },
      ).lean();
      if (doc) {
        const mapped = this.mapReview(doc as unknown as Record<string, unknown>);
        this.notify(String(doc.userId), 'session_review_updated', mapped);
      }
    } catch (err) {
      log.warn({ err, reviewId }, 'review timeout CAS failed');
    }
    this.wakeWaiter(reviewId, { kind: 'cancelled', reason: 'timeout' });
  }

  private wakeWaiter(reviewId: string, result: ReviewWaitResult): void {
    const waiter = this.waiters.get(reviewId);
    if (!waiter) return;
    this.waiters.delete(reviewId);
    clearTimeout(waiter.timer);
    waiter.resolve(result);
  }

  /** 测试辅助：清空等待器 */
  clearWaiters(): void {
    for (const [, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
    }
    this.waiters.clear();
  }
}

export const sessionReviewService = new SessionReviewService();
