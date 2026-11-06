import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../models/session-review.js', () => ({
  SessionReview: {
    create: vi.fn(),
    find: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock('./session-sse.js', () => ({
  sessionSSEService: {
    pushToUser: vi.fn(),
  },
}));

vi.mock('./workspace-context.js', () => ({
  actorFilter: vi.fn(() => ({ userId: 'user-1' })),
}));

import { SessionReviewService, getMcpReviewTimeoutMs } from './session-review-service.js';
import { SessionReview } from '../models/session-review.js';
import { sessionSSEService } from './session-sse.js';

function reviewDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: '64b000000000000000000001',
    userId: 'user-1',
    sessionId: '64b000000000000000000002',
    controllerId: '64b000000000000000000003',
    files: [{ path: 'src/a.ts', absPath: '/ws/src/a.ts' }],
    summary: 'please review',
    status: 'PENDING',
    fileReviews: null,
    comment: null,
    cancelReason: null,
    createdAt: new Date('2026-11-05T12:00:00Z'),
    resolvedAt: null,
    ...overrides,
  };
}

describe('SessionReviewService', () => {
  let service: SessionReviewService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SessionReviewService();
  });

  afterEach(() => {
    service.clearWaiters();
    vi.useRealTimers();
  });

  it('T-SR1 createForMcp：PENDING 文档 + SSE session_review_requested 载荷含 review', async () => {
    vi.mocked(SessionReview.create).mockResolvedValue({
      toObject: () => reviewDoc(),
    } as never);

    const review = await service.createForMcp({
      userId: 'user-1',
      sessionId: '64b000000000000000000002',
      controllerId: '64b000000000000000000003',
      files: [{ path: 'src/a.ts', absPath: '/ws/src/a.ts' }],
      summary: 'please review',
    });

    expect(SessionReview.create).toHaveBeenCalledWith(expect.objectContaining({
      status: 'PENDING',
      files: [{ path: 'src/a.ts', absPath: '/ws/src/a.ts' }],
    }));
    expect(review.status).toBe('PENDING');
    expect(review.files).toEqual(['src/a.ts']);
    expect(sessionSSEService.pushToUser).toHaveBeenCalledWith('user-1', {
      type: 'session_review_requested',
      data: { review: expect.objectContaining({ id: '64b000000000000000000001', status: 'PENDING' }) },
    });
  });

  it('T-SR2 submit 正常：PENDING→终态、写 fileReviews/comment/resolvedAt、唤醒等待器、SSE session_review_updated', async () => {
    const resolved = reviewDoc({ status: 'APPROVED', fileReviews: { 'src/a.ts': [] }, comment: 'ok', resolvedAt: new Date() });
    vi.mocked(SessionReview.findOneAndUpdate).mockReturnValue({
      lean: vi.fn().mockResolvedValue(resolved),
    } as never);

    const waiter = service.waitForResolution('64b000000000000000000001', 60_000);
    const result = await service.submit('user-1', '64b000000000000000000001', {
      fileReviews: { 'src/a.ts': [] },
      comment: 'ok',
      status: 'approve',
    });

    expect(SessionReview.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: '64b000000000000000000001', status: 'PENDING', userId: 'user-1' },
      { $set: { status: 'APPROVED', fileReviews: { 'src/a.ts': [] }, comment: 'ok', resolvedAt: expect.any(Date) } },
      { new: true },
    );
    expect(result.status).toBe('APPROVED');
    await expect(waiter).resolves.toEqual({ kind: 'resolved', review: expect.objectContaining({ status: 'APPROVED' }) });
    expect(sessionSSEService.pushToUser).toHaveBeenCalledWith('user-1', {
      type: 'session_review_updated',
      data: { review: expect.objectContaining({ status: 'APPROVED' }) },
    });

    // reject / comment 映射
    vi.mocked(SessionReview.findOneAndUpdate).mockReturnValue({
      lean: vi.fn().mockResolvedValue(reviewDoc({ status: 'REJECTED' })),
    } as never);
    await service.submit('user-1', '64b000000000000000000001', { fileReviews: {}, status: 'reject' });
    expect(vi.mocked(SessionReview.findOneAndUpdate).mock.calls.at(-1)?.[1]).toMatchObject({ $set: { status: 'REJECTED' } });

    vi.mocked(SessionReview.findOneAndUpdate).mockReturnValue({
      lean: vi.fn().mockResolvedValue(reviewDoc({ status: 'COMMENTED' })),
    } as never);
    await service.submit('user-1', '64b000000000000000000001', { fileReviews: {}, status: 'comment' });
    expect(vi.mocked(SessionReview.findOneAndUpdate).mock.calls.at(-1)?.[1]).toMatchObject({ $set: { status: 'COMMENTED' } });
  });

  it('T-SR3 重复提交 / 与取消竞争：CAS 未命中抛 Review not found or already resolved', async () => {
    vi.mocked(SessionReview.findOneAndUpdate).mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    } as never);

    await expect(
      service.submit('user-1', '64b000000000000000000001', { fileReviews: {}, status: 'approve' }),
    ).rejects.toThrow('Review not found or already resolved');

    await expect(
      service.submit('user-1', 'not-an-object-id', { fileReviews: {}, status: 'approve' }),
    ).rejects.toThrow('Review not found or already resolved');
  });

  it('T-SR4 超时：到点 CAS→CANCELLED(cancelReason=timeout)，等待器按 cancelled 唤醒', async () => {
    vi.useFakeTimers();
    vi.mocked(SessionReview.findOneAndUpdate).mockReturnValue({
      lean: vi.fn().mockResolvedValue(reviewDoc({ status: 'CANCELLED', cancelReason: 'timeout', resolvedAt: new Date() })),
    } as never);

    const waiter = service.waitForResolution('64b000000000000000000001', 30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(waiter).resolves.toEqual({ kind: 'cancelled', reason: 'timeout' });
    expect(SessionReview.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: '64b000000000000000000001', status: 'PENDING' },
      { $set: { status: 'CANCELLED', cancelReason: 'timeout', resolvedAt: expect.any(Date) } },
      { new: true },
    );
  });

  it('T-SR5 cancelBySession：会话 close/ended → PENDING 批量 CANCELLED(session_closed)', async () => {
    vi.mocked(SessionReview.find).mockReturnValue({
      lean: vi.fn().mockResolvedValue([reviewDoc()]),
    } as never);
    vi.mocked(SessionReview.updateMany).mockResolvedValue({ modifiedCount: 1 } as never);

    const waiter = service.waitForResolution('64b000000000000000000001', 60_000);
    const count = await service.cancelBySession('64b000000000000000000002', 'session_closed');

    expect(count).toBe(1);
    expect(SessionReview.updateMany).toHaveBeenCalledWith(
      { _id: { $in: [expect.anything()] }, status: 'PENDING' },
      { $set: { status: 'CANCELLED', cancelReason: 'session_closed', resolvedAt: expect.any(Date) } },
    );
    await expect(waiter).resolves.toEqual({ kind: 'cancelled', reason: 'session_closed' });
    expect(sessionSSEService.pushToUser).toHaveBeenCalledWith('user-1', {
      type: 'session_review_updated',
      data: { review: expect.objectContaining({ status: 'CANCELLED', cancelReason: 'session_closed' }) },
    });
  });

  it('T-SR6 listByUser：PENDING 在前、终态 resolvedAt 倒序、上限 20', async () => {
    const rows = [
      reviewDoc({ _id: 'a', status: 'APPROVED', resolvedAt: new Date('2026-11-01') }),
      reviewDoc({ _id: 'b', status: 'PENDING', createdAt: new Date('2026-11-03') }),
      reviewDoc({ _id: 'c', status: 'PENDING', createdAt: new Date('2026-11-04') }),
      reviewDoc({ _id: 'd', status: 'REJECTED', resolvedAt: new Date('2026-11-02') }),
    ];
    vi.mocked(SessionReview.find).mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(rows),
        }),
      }),
    } as never);

    const list = await service.listByUser('user-1');

    expect(list.map((item) => item.id)).toEqual(['c', 'b', 'd', 'a']);
    expect(SessionReview.find).toHaveBeenCalledWith({ userId: 'user-1' });
    const limit = (vi.mocked(SessionReview.find).mock.results[0].value.sort as ReturnType<typeof vi.fn>).mock.results[0].value.limit as ReturnType<typeof vi.fn>;
    expect(limit).toHaveBeenCalledWith(40);
  });

  it('getMcpReviewTimeoutMs 默认 1_800_000，env 可调', () => {
    delete process.env.MCP_REVIEW_TIMEOUT_MS;
    expect(getMcpReviewTimeoutMs()).toBe(1_800_000);
    process.env.MCP_REVIEW_TIMEOUT_MS = '5000';
    try {
      expect(getMcpReviewTimeoutMs()).toBe(5000);
    } finally {
      delete process.env.MCP_REVIEW_TIMEOUT_MS;
    }
  });
});
