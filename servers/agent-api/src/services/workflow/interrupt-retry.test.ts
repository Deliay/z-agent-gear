import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../models/workflow-instance.js', () => ({
  WorkflowInstance: {
    findById: vi.fn(),
    updateOne: vi.fn(),
  },
}));

vi.mock('../session.js', () => ({
  sessionService: {
    getSessionStatusRaw: vi.fn(),
    close: vi.fn(),
    resume: vi.fn(),
    addMessage: vi.fn(),
  },
}));

vi.mock('../todo-service.js', () => ({
  todoService: {
    createWorkflowInterventionTodo: vi.fn(),
  },
}));

vi.mock('../session-idle-waiter.js', () => ({
  armSessionIdleWaiter: vi.fn(),
}));

vi.mock('./node-config.js', () => ({
  loadNodeConfig: vi.fn().mockResolvedValue({ nodeKey: 'n1', requiresWorktree: false, agentConfig: null }),
  initialModeModel: vi.fn().mockReturnValue(undefined),
}));

vi.mock('./engine.js', () => ({
  workflowEngine: {
    transition: vi.fn().mockResolvedValue({}),
    runOutsideTransitionLock: vi.fn((_id: string, task: () => Promise<unknown>) => task()),
  },
}));

import {
  interruptRetryDelayMs,
  scheduleInterruptionRetry,
  executeScheduledRetry,
  exhaustInterruptionRetry,
  INTERRUPT_RETRY_MAX,
} from './interrupt-retry.js';
import { WorkflowInstance } from '../../models/workflow-instance.js';
import { sessionService } from '../session.js';
import { todoService } from '../todo-service.js';
import { armSessionIdleWaiter } from '../session-idle-waiter.js';
import { workflowEngine } from './engine.js';

function oid(id: string) {
  return { toString: () => id } as import('mongoose').Types.ObjectId;
}

const INSTANCE_ID = '507f1f77bcf86cd799439011';
const NODE_ID = 'n1';
const SESSION_ID = 'sess-1';

function makeNode(overrides: Record<string, unknown> = {}) {
  return {
    nodeId: NODE_ID,
    nodeKey: 'n1',
    type: 'AI',
    name: '执行',
    stage: '实现',
    status: 'RUNNING',
    dependsOn: [],
    reworkCount: 0,
    sessionId: SESSION_ID,
    retryCount: 0,
    nextRetryAt: null,
    retryPhase: null,
    retryDeadlineAt: null,
    retryTrigger: null,
    ...overrides,
  };
}

function makeInstance(nodeOverrides: Record<string, unknown> = {}, instanceOverrides: Record<string, unknown> = {}) {
  const instance: Record<string, unknown> = {
    _id: oid(INSTANCE_ID),
    userId: oid('user-1'),
    controllerId: oid('ctrl-1'),
    workspaceId: oid('ws-1'),
    configuredWorkflowId: oid('cfg-1'),
    name: '测试实例',
    deletedAt: null,
    nodes: [makeNode(nodeOverrides)],
    ...instanceOverrides,
  };
  return instance;
}

/** 模拟 Mongoose Query：`findById(...).lean()`（生产代码统一用 lean 读取） */
function instanceQuery(instance: Record<string, unknown> | null) {
  return { lean: async () => instance } as never;
}

function stubInstance(instance: Record<string, unknown> | null): void {
  vi.mocked(WorkflowInstance.findById).mockImplementation((() => instanceQuery(instance)) as never);
}

function stubClaim(modifiedCount = 1): void {
  vi.mocked(WorkflowInstance.updateOne).mockResolvedValue({ modifiedCount } as never);
}

function argAt(mock: unknown, callIndex: number, argIndex: number): unknown {
  const calls = (mock as { mock: { calls: unknown[][] } }).mock.calls;
  return calls[callIndex][argIndex];
}

/** `WorkflowInstance.updateOne` 第 N 次调用的 `$set` 段 */
function updateSet(callIndex: number): Record<string, unknown> {
  return (argAt(WorkflowInstance.updateOne, callIndex, 1) as { $set: Record<string, unknown> }).$set;
}

describe('interruptRetryDelayMs', () => {
  it('T-RETRY1: 0/1/2/4/8/16/30/30/30/30 分钟，越界收敛', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(interruptRetryDelayMs)).toEqual([
      0,
      60_000,
      120_000,
      240_000,
      480_000,
      960_000,
      1_800_000,
      1_800_000,
      1_800_000,
      1_800_000,
    ]);
    expect(interruptRetryDelayMs(0)).toBe(0);
    expect(interruptRetryDelayMs(-3)).toBe(0);
    expect(interruptRetryDelayMs(99)).toBe(1_800_000);
    expect(interruptRetryDelayMs(Number.NaN)).toBe(0);
  });
});

describe('scheduleInterruptionRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workflowEngine.runOutsideTransitionLock).mockImplementation(((_id: string, task: () => Promise<unknown>) => task()) as never);
  });

  it('T-RETRY2: 首次中断 → retryCount=1、立即执行', async () => {
    stubInstance(makeInstance());
    stubClaim(1);

    const before = Date.now();
    const result = await scheduleInterruptionRetry({
      instanceId: INSTANCE_ID,
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      trigger: 'ENDED',
    });

    expect(result).toBe('scheduled');
    const set = updateSet(0);
    expect(set['nodes.$.retryCount']).toBe(1);
    expect(set['nodes.$.retryPhase']).toBe('SCHEDULED');
    expect(set['nodes.$.retryTrigger']).toBe('ENDED');
    expect((set['nodes.$.nextRetryAt'] as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((set['nodes.$.nextRetryAt'] as Date).getTime()).toBeLessThan(before + 5_000);
    expect(workflowEngine.runOutsideTransitionLock).toHaveBeenCalledWith(INSTANCE_ID, expect.any(Function));
  });

  it('T-RETRY3: 第 2 次中断 → retryCount=2、约 1 分钟后执行、不立即执行', async () => {
    stubInstance(makeInstance({ retryCount: 1 }));
    stubClaim(1);

    const before = Date.now();
    const result = await scheduleInterruptionRetry({
      instanceId: INSTANCE_ID,
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      trigger: 'IDLED',
    });

    expect(result).toBe('scheduled');
    const set = updateSet(0);
    expect(set['nodes.$.retryCount']).toBe(2);
    expect((set['nodes.$.nextRetryAt'] as Date).getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(workflowEngine.runOutsideTransitionLock).not.toHaveBeenCalled();
  });

  it('T-RETRY4: 已在 SCHEDULED 时再排期（expectedPhase=null）→ CAS 不命中 → skipped', async () => {
    stubInstance(makeInstance({ retryPhase: 'RECONNECTING', retryCount: 1 }));
    stubClaim(0);

    const result = await scheduleInterruptionRetry({
      instanceId: INSTANCE_ID,
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      trigger: 'ENDED',
    });

    expect(result).toBe('skipped');
    expect(workflowEngine.runOutsideTransitionLock).not.toHaveBeenCalled();
    // CAS 带 retryCount 快照与 expectedPhase
    const filter = argAt(WorkflowInstance.updateOne, 0, 0) as {
      nodes: { $elemMatch: Record<string, unknown> };
    };
    expect(filter.nodes.$elemMatch).toMatchObject({ retryPhase: null, retryCount: 1 });
  });

  it('T-RETRY5: retryCount=9 排到第 10 次；retryCount=10 直接 retryExhausted + 待办', async () => {
    stubInstance(makeInstance({ retryCount: 9 }));
    stubClaim(1);
    await scheduleInterruptionRetry({ instanceId: INSTANCE_ID, nodeId: NODE_ID, sessionId: SESSION_ID, trigger: 'ENDED' });
    expect(updateSet(0)['nodes.$.retryCount']).toBe(INTERRUPT_RETRY_MAX);

    vi.clearAllMocks();
    stubInstance(makeInstance({ retryCount: INTERRUPT_RETRY_MAX }));
    const result = await scheduleInterruptionRetry({
      instanceId: INSTANCE_ID,
      nodeId: NODE_ID,
      sessionId: SESSION_ID,
      trigger: 'ENDED',
    });
    expect(result).toBe('exhausted');
    expect(WorkflowInstance.updateOne).not.toHaveBeenCalled();
    expect(workflowEngine.transition).toHaveBeenCalledWith(
      INSTANCE_ID,
      NODE_ID,
      'retryExhausted',
      expect.objectContaining({ reason: expect.stringContaining('10 次') }),
    );
    expect(todoService.createWorkflowInterventionTodo).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: INSTANCE_ID, nodeId: NODE_ID, sessionId: SESSION_ID }),
    );
  });

  it('T-RETRY5b: 节点已非 RUNNING/REWORK 或会话已变更 → skipped', async () => {
    stubInstance(makeInstance({ status: 'DONE' }));
    expect(
      await scheduleInterruptionRetry({ instanceId: INSTANCE_ID, nodeId: NODE_ID, sessionId: SESSION_ID, trigger: 'ENDED' }),
    ).toBe('skipped');

    stubInstance(makeInstance({ sessionId: 'other-session' }));
    expect(
      await scheduleInterruptionRetry({ instanceId: INSTANCE_ID, nodeId: NODE_ID, sessionId: SESSION_ID, trigger: 'ENDED' }),
    ).toBe('skipped');

    stubInstance(makeInstance({}, { deletedAt: new Date() }));
    expect(
      await scheduleInterruptionRetry({ instanceId: INSTANCE_ID, nodeId: NODE_ID, sessionId: SESSION_ID, trigger: 'ENDED' }),
    ).toBe('skipped');
    expect(WorkflowInstance.updateOne).not.toHaveBeenCalled();
  });
});

describe('executeScheduledRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sessionService.getSessionStatusRaw).mockResolvedValue('idling');
    vi.mocked(sessionService.close).mockResolvedValue(true);
    vi.mocked(sessionService.resume).mockResolvedValue({ success: true, status: 'connecting' });
    vi.mocked(sessionService.addMessage).mockResolvedValue({});
    vi.mocked(armSessionIdleWaiter).mockReturnValue({ promise: Promise.resolve(true), cancel: vi.fn() });
    vi.mocked(workflowEngine.runOutsideTransitionLock).mockImplementation(((_id: string, task: () => Promise<unknown>) => task()) as never);
  });

  it('T-RETRY6: 正常路径：占位 → close → resume → 等 idle → addMessage（顺序与参数）', async () => {
    const instance = makeInstance({ retryPhase: 'RECONNECTING', retryCount: 1, retryTrigger: 'ENDED', nextRetryAt: new Date() });
    stubInstance(instance);
    stubClaim(1);

    await executeScheduledRetry(INSTANCE_ID, NODE_ID);

    expect(WorkflowInstance.updateOne).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ nodes: { $elemMatch: expect.objectContaining({ retryPhase: 'SCHEDULED' }) } }),
      expect.objectContaining({ $set: expect.objectContaining({ 'nodes.$.retryPhase': 'RECONNECTING' }) }),
    );
    expect(sessionService.close).toHaveBeenCalledWith(SESSION_ID, 'user-1', {
      suppressFallback: true,
      reason: 'workflow_interruption_retry',
    });
    expect(armSessionIdleWaiter).toHaveBeenCalledWith(SESSION_ID, 5 * 60_000);
    expect(sessionService.resume).toHaveBeenCalledWith(SESSION_ID, 'user-1', undefined);
    expect(String((vi.mocked(sessionService.addMessage).mock.calls[0][1] as { content: string }).content)).toContain('工作流');
    const closeOrder = vi.mocked(sessionService.close).mock.invocationCallOrder[0];
    const resumeOrder = vi.mocked(sessionService.resume).mock.invocationCallOrder[0];
    const msgOrder = vi.mocked(sessionService.addMessage).mock.invocationCallOrder[0];
    expect(closeOrder).toBeLessThan(resumeOrder);
    expect(resumeOrder).toBeLessThan(msgOrder);
    // 最后清理调度字段（保留 retryCount）
    const lastCall = vi.mocked(WorkflowInstance.updateOne).mock.calls.at(-1)!;
    expect(lastCall[1]).toEqual({
      $set: {
        'nodes.$.retryPhase': null,
        'nodes.$.nextRetryAt': null,
        'nodes.$.retryDeadlineAt': null,
        'nodes.$.retryTrigger': null,
      },
    });
  });

  it('T-RETRY7: 会话已 ended → 跳过 close，直接 resume', async () => {
    vi.mocked(sessionService.getSessionStatusRaw).mockResolvedValue('ended');
    stubInstance(makeInstance({ retryPhase: 'RECONNECTING', retryCount: 1, retryTrigger: 'IDLED' }));
    stubClaim(1);

    await executeScheduledRetry(INSTANCE_ID, NODE_ID);

    expect(sessionService.close).not.toHaveBeenCalled();
    expect(sessionService.resume).toHaveBeenCalled();
    // IDLED 触发重发停滞提醒
    expect(String((vi.mocked(sessionService.addMessage).mock.calls[0][1] as { content: string }).content)).toContain('本轮执行已停止');
  });

  it('T-RETRY8: resume.success=false → 从 RECONNECTING 重排（count+1、phase=SCHEDULED）', async () => {
    vi.mocked(sessionService.resume).mockResolvedValue({ success: false, status: 'ended', error: 'ACP_RESUME_FAILED' });
    stubInstance(makeInstance({ retryPhase: 'RECONNECTING', retryCount: 1 }));
    stubClaim(1);

    await executeScheduledRetry(INSTANCE_ID, NODE_ID);

    expect(sessionService.addMessage).not.toHaveBeenCalled();
    // 第二次 updateOne 是重排 CAS
    const reschedule = updateSet(1);
    expect(reschedule['nodes.$.retryCount']).toBe(2);
    expect(reschedule['nodes.$.retryPhase']).toBe('SCHEDULED');
  });

  it('T-RETRY9: 等待空闲 false（超时/ended+error）→ 重排', async () => {
    vi.mocked(armSessionIdleWaiter).mockReturnValue({ promise: Promise.resolve(false), cancel: vi.fn() });
    stubInstance(makeInstance({ retryPhase: 'RECONNECTING', retryCount: 3 }));
    stubClaim(1);

    await executeScheduledRetry(INSTANCE_ID, NODE_ID);

    expect(sessionService.addMessage).not.toHaveBeenCalled();
    expect((argAt(WorkflowInstance.updateOne, 1, 1) as { $set: Record<string, unknown> }).$set['nodes.$.retryCount']).toBe(4);
  });

  it('T-RETRY10: 发送前双校验失败（节点已 DONE）→ 不 addMessage、不重排', async () => {
    const scheduled = makeInstance({ retryPhase: 'RECONNECTING', retryCount: 1 });
    const fresh = makeInstance({ status: 'DONE' });
    vi.mocked(WorkflowInstance.findById)
      .mockImplementationOnce((() => instanceQuery(scheduled)) as never)
      .mockImplementationOnce((() => instanceQuery(fresh)) as never);
    stubClaim(1);

    await executeScheduledRetry(INSTANCE_ID, NODE_ID);

    expect(sessionService.addMessage).not.toHaveBeenCalled();
    expect(WorkflowInstance.updateOne).toHaveBeenCalledTimes(1); // 仅占位，无重排/清理
  });

  it('T-RETRY10b: 发送前 sessionId 变更 → 放弃', async () => {
    const scheduled = makeInstance({ retryPhase: 'RECONNECTING', retryCount: 1 });
    const fresh = makeInstance({ retryPhase: 'RECONNECTING', sessionId: 'sess-new' });
    vi.mocked(WorkflowInstance.findById)
      .mockImplementationOnce((() => instanceQuery(scheduled)) as never)
      .mockImplementationOnce((() => instanceQuery(fresh)) as never);
    stubClaim(1);

    await executeScheduledRetry(INSTANCE_ID, NODE_ID);

    expect(sessionService.addMessage).not.toHaveBeenCalled();
    expect(WorkflowInstance.updateOne).toHaveBeenCalledTimes(1);
  });

  it('T-RETRY11: 占位 CAS 未命中 → 无任何会话动作（单赢家）', async () => {
    stubClaim(0);

    await executeScheduledRetry(INSTANCE_ID, NODE_ID);

    expect(sessionService.getSessionStatusRaw).not.toHaveBeenCalled();
    expect(sessionService.close).not.toHaveBeenCalled();
    expect(sessionService.resume).not.toHaveBeenCalled();
  });

  it('T-RETRY12: 重排时 retryCount=10 → retryExhausted + 待办（reason 含次数）', async () => {
    vi.mocked(sessionService.resume).mockResolvedValue({ success: false, status: 'ended' });
    stubInstance(makeInstance({ retryPhase: 'RECONNECTING', retryCount: 10 }));
    stubClaim(1);

    await executeScheduledRetry(INSTANCE_ID, NODE_ID);

    expect(workflowEngine.transition).toHaveBeenCalledWith(
      INSTANCE_ID,
      NODE_ID,
      'retryExhausted',
      expect.objectContaining({ reason: expect.stringContaining('10 次') }),
    );
    expect(todoService.createWorkflowInterventionTodo).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining('10 次') }),
    );
  });

  it('T-RETRY13: 超限转移遇 re-entrant 锁错 → 退避后重试并最终成功；非重入异常只告警', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(workflowEngine.transition)
        .mockRejectedValueOnce(new Error('KeyedMutex re-entrant lock detected for key: inst'))
        .mockResolvedValueOnce({} as never);
      stubInstance(makeInstance({ retryCount: 10 }));

      const pending = exhaustInterruptionRetry({
        instanceId: INSTANCE_ID,
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        retryCount: 10,
      });
      await vi.advanceTimersByTimeAsync(100);
      await pending;

      expect(workflowEngine.transition).toHaveBeenCalledTimes(2);
      expect(todoService.createWorkflowInterventionTodo).toHaveBeenCalled();

      vi.clearAllMocks();
      vi.mocked(workflowEngine.transition).mockRejectedValue(new Error('event not allowed'));
      await exhaustInterruptionRetry({
        instanceId: INSTANCE_ID,
        nodeId: NODE_ID,
        sessionId: SESSION_ID,
        retryCount: 10,
      });
      expect(workflowEngine.transition).toHaveBeenCalledTimes(1);
      expect(todoService.createWorkflowInterventionTodo).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 会话已丢失（sessionId 缺失）：按计划「计为本次失败」消耗一次预算后再重排
// ---------------------------------------------------------------------------

describe('executeScheduledRetry 会话已丢失', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workflowEngine.runOutsideTransitionLock).mockImplementation(((_id: string, task: () => Promise<unknown>) => task()) as never);
  });

  it('T-RETRY14: sessionId 缺失 → 不直接失败，重排（retryCount+1、SCHEDULED）并在用尽时 retryExhausted', async () => {
    stubInstance(
      makeInstance({ retryPhase: 'RECONNECTING', retryCount: 1, sessionId: undefined }),
    );
    stubClaim(1);

    await executeScheduledRetry(INSTANCE_ID, NODE_ID);

    expect(sessionService.getSessionStatusRaw).not.toHaveBeenCalled();
    expect(sessionService.resume).not.toHaveBeenCalled();
    const reschedule = updateSet(1);
    expect(reschedule['nodes.$.retryCount']).toBe(2);
    expect(reschedule['nodes.$.retryPhase']).toBe('SCHEDULED');

    // 已达上限：再次失败 → retryExhausted + 待办
    vi.clearAllMocks();
    vi.mocked(workflowEngine.transition).mockResolvedValue({} as never);
    stubInstance(
      makeInstance({ retryPhase: 'RECONNECTING', retryCount: INTERRUPT_RETRY_MAX, sessionId: undefined }),
    );
    stubClaim(1);
    await executeScheduledRetry(INSTANCE_ID, NODE_ID);
    expect(workflowEngine.transition).toHaveBeenCalledWith(
      INSTANCE_ID,
      NODE_ID,
      'retryExhausted',
      expect.objectContaining({ reason: expect.stringContaining('10 次') }),
    );
    expect(todoService.createWorkflowInterventionTodo).toHaveBeenCalled();
  });
});
