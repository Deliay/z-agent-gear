import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../models/workflow-instance.js', () => ({
  WorkflowInstance: {
    findById: vi.fn(),
    findOne: vi.fn(),
  },
}));

import { workflowEngine, type WorkflowInstanceDoc, type WorkflowNodeDoc } from './engine.js';
import { WorkflowInstance } from '../../models/workflow-instance.js';

function oid(id: string) {
  return { toString: () => id } as import('mongoose').Types.ObjectId;
}

function makeNode(overrides: Partial<WorkflowNodeDoc> = {}): WorkflowNodeDoc {
  return {
    nodeId: 'n1',
    nodeKey: 'n1',
    type: 'HUMAN',
    name: '节点1',
    stage: '阶段1',
    status: 'INITIALIZING',
    dependsOn: [],
    reworkCount: 0,
    ...overrides,
  };
}

function makeInstance(nodes: WorkflowNodeDoc[]): WorkflowInstanceDoc & { save: ReturnType<typeof vi.fn> } {
  return {
    _id: oid('inst-1'),
    userId: oid('user-1'),
    controllerId: oid('ctrl-1'),
    workspaceId: oid('ws-1'),
    configuredWorkflowId: oid('cfg-1'),
    name: 'demo-instance',
    nodes,
    currentNodeNames: [],
    blackboard: new Map<string, string>(),
    blackboardTrash: new Map<string, string>(),
    blackboardUpdatedAt: new Map<string, Date>(),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

/** 线性链：n1(HUMAN) → n2(AI) → n3(AI) */
function linearInstance() {
  return makeInstance([
    makeNode({ nodeId: 'n1', nodeKey: 'n1', name: '需求', status: 'READY' }),
    makeNode({ nodeId: 'n2', nodeKey: 'n2', type: 'AI', name: '技术方案', status: 'INITIALIZING', dependsOn: ['n1'] }),
    makeNode({ nodeId: 'n3', nodeKey: 'n3', type: 'AI', name: '代码实现', status: 'INITIALIZING', dependsOn: ['n2'] }),
  ]);
}

const hooks = {
  onNodeStart: vi.fn(),
  onNodeRework: vi.fn(),
  onNodeResume: vi.fn(),
  onNodeDone: vi.fn(),
};

function loadInstance(instance: ReturnType<typeof makeInstance>) {
  vi.mocked(WorkflowInstance.findById).mockResolvedValue(instance as never);
}

describe('WorkflowEngine.transition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workflowEngine.registerHooks(hooks);
  });

  it('E1: INITIALIZING→READY（上游未完成时 AI 节点仅就绪，不拉起会话）', async () => {
    const instance = linearInstance(); // n1 仍 READY（未 DONE）
    loadInstance(instance);

    await workflowEngine.transition('inst-1', 'n2', 'start');

    expect(instance.nodes[1].status).toBe('READY');
    expect(hooks.onNodeStart).not.toHaveBeenCalled();
    expect(instance.save).toHaveBeenCalled();
  });

  it('E2: READY→RUNNING（全部上游 DONE），写入 startedAt 并触发会话 hook', async () => {
    const instance = linearInstance();
    instance.nodes[0].status = 'DONE';
    instance.nodes[1].status = 'READY';
    loadInstance(instance);

    await workflowEngine.transition('inst-1', 'n2', 'start');

    const node = instance.nodes[1];
    expect(node.status).toBe('RUNNING');
    expect(node.startedAt).toBeInstanceOf(Date);
    expect(hooks.onNodeStart).toHaveBeenCalledWith(instance, node);
    expect(instance.currentNodeNames).toEqual(['技术方案']);
  });

  it('E3: RUNNING→DONE（complete）：产物写入黑板，触发下游 start 后再结束本会话', async () => {
    const instance = linearInstance();
    instance.nodes[0].status = 'DONE';
    instance.nodes[1].status = 'RUNNING';
    instance.nodes[1].sessionId = 'sess-2';
    loadInstance(instance);

    await workflowEngine.transition('inst-1', 'n2', 'complete', {
      artifacts: [{ title: '技术方案文档', value: '方案内容' }],
    });

    const node = instance.nodes[1];
    expect(node.status).toBe('DONE');
    // 产物 key：{nodeId}-{nodeName}-产物-{title}
    expect(instance.blackboard.get('n2-技术方案-产物-技术方案文档')).toBe('方案内容');
    expect(instance.blackboardUpdatedAt.get('n2-技术方案-产物-技术方案文档')).toBeInstanceOf(Date);
    // 下游 n3 被接力拉起（INITIALIZING → RUNNING，因唯一上游已 DONE）
    expect(instance.nodes[2].status).toBe('RUNNING');
    expect(hooks.onNodeStart).toHaveBeenCalledWith(instance, instance.nodes[2]);
    // 先触发下游 start，再结束本会话
    expect(hooks.onNodeStart.mock.invocationCallOrder[0]).toBeLessThan(
      hooks.onNodeDone.mock.invocationCallOrder[0],
    );
    expect(hooks.onNodeDone).toHaveBeenCalledWith(instance, node);
    expect(instance.currentNodeNames).toEqual(['代码实现']);
  });

  it('E4: RUNNING→REJECT（reject 携带 reason）：写打回记录，触发全部直接上游 REWORK', async () => {
    const instance = linearInstance();
    instance.nodes[0].status = 'DONE';
    instance.nodes[1].status = 'RUNNING';
    loadInstance(instance);

    await workflowEngine.transition('inst-1', 'n2', 'reject', { reason: '方案不完整', fromNodeId: 'n3' });

    const node = instance.nodes[1];
    expect(node.status).toBe('REJECT');
    expect(node.rejectInfo).toMatchObject({ reason: '方案不完整', fromNodeId: 'n3' });
    expect(node.rejectInfo?.at).toBeInstanceOf(Date);
    // 黑板打回记录
    const record = JSON.parse(instance.blackboard.get('打回-n2-1')!);
    expect(record).toMatchObject({ reason: '方案不完整', fromNodeId: 'n3' });
    // 上游 n1（DONE）进入 REWORK
    const upstream = instance.nodes[0];
    expect(upstream.status).toBe('REWORK');
    expect(upstream.reworkCount).toBe(1);
    expect(upstream.reworkedAt).toBeInstanceOf(Date);
    expect(hooks.onNodeRework).toHaveBeenCalledWith(
      instance,
      upstream,
      expect.objectContaining({ reason: '方案不完整', fromNodeId: 'n2' }),
    );
    expect(instance.currentNodeNames).toEqual([]);
  });

  it('E5: REJECT→RUNNING（resume）允许，并触发 onNodeResume', async () => {
    const instance = linearInstance();
    instance.nodes[1].status = 'REJECT';
    loadInstance(instance);

    await workflowEngine.transition('inst-1', 'n2', 'resume');

    expect(instance.nodes[1].status).toBe('RUNNING');
    expect(hooks.onNodeResume).toHaveBeenCalledWith(instance, instance.nodes[1]);
  });

  it('E6: REWORK→DONE（completeRework）：重置产物入垃圾桶，通知下游 REJECT 节点 resume', async () => {
    const instance = linearInstance();
    instance.nodes[0].status = 'REWORK';
    instance.nodes[0].reworkCount = 1;
    instance.nodes[1].status = 'REJECT';
    // n1 的旧产物
    instance.blackboard.set('n1-需求-产物-输入', '旧需求');
    loadInstance(instance);

    await workflowEngine.transition('inst-1', 'n1', 'completeRework', {
      artifacts: [{ title: '输入', value: '新需求' }],
    });

    const node = instance.nodes[0];
    expect(node.status).toBe('DONE');
    // 旧产物入垃圾桶，新产物写入黑板
    expect(instance.blackboardTrash.get('n1-需求-产物-输入')).toBe('旧需求');
    expect(instance.blackboard.get('n1-需求-产物-输入')).toBe('新需求');
    // 下游 REJECT 节点被 resume
    expect(instance.nodes[1].status).toBe('RUNNING');
    expect(hooks.onNodeResume).toHaveBeenCalledWith(instance, instance.nodes[1]);
  });

  it('E7: READY/RUNNING/DONE→REWORK（收到打回）允许，reworkCount+1 并写 reworkedAt', async () => {
    for (const from of ['READY', 'RUNNING', 'DONE'] as const) {
      vi.clearAllMocks();
      const instance = linearInstance();
      instance.nodes[1].status = from;
      loadInstance(instance);

      await workflowEngine.transition('inst-1', 'n2', 'rework', { reason: 'r', fromNodeId: 'n3' });

      expect(instance.nodes[1].status).toBe('REWORK');
      expect(instance.nodes[1].reworkCount).toBe(1);
      expect(instance.nodes[1].reworkedAt).toBeInstanceOf(Date);
    }
  });

  it('E8: 非法转移一律拒绝并返回可读错误', async () => {
    const cases: Array<[string, string, string]> = [
      ['INITIALIZING', 'complete', '不允许'],
      ['READY', 'complete', '不允许'],
      ['DONE', 'resume', '不允许'],
      ['RUNNING', 'completeRework', '不允许'],
      ['REJECT', 'complete', '不允许'],
      ['DONE', 'start', '不允许'],
    ];
    for (const [status, event] of cases) {
      const instance = linearInstance();
      instance.nodes[1].status = status as WorkflowNodeDoc['status'];
      loadInstance(instance);
      await expect(
        workflowEngine.transition('inst-1', 'n2', event as never),
      ).rejects.toThrow(/不允许/);
    }
  });

  it('E9: 打回无依赖上游的首节点 → 拒绝并提示无上游可打回', async () => {
    const instance = linearInstance();
    instance.nodes[0].status = 'RUNNING';
    loadInstance(instance);

    await expect(
      workflowEngine.transition('inst-1', 'n1', 'reject', { reason: '重来' }),
    ).rejects.toThrow(/首节点|无上游/);
    expect(instance.nodes[0].status).toBe('RUNNING');
  });

  it('E16: REWORK→REJECT（返工中再次打回上游）：a→b→c 中 c 打回 b 后，b 可再打回 a', async () => {
    const instance = linearInstance();
    // 场景：n3 打回 n2 后，n2 处于 REWORK（reworkCount=1），n1 已 DONE
    instance.nodes[0].status = 'DONE';
    instance.nodes[1].status = 'REWORK';
    instance.nodes[1].reworkCount = 1;
    loadInstance(instance);

    await workflowEngine.transition('inst-1', 'n2', 'reject', { reason: '需求本身有问题', fromNodeId: null });

    // n2：REWORK→REJECT，rejectInfo 覆盖为本次打回
    const node = instance.nodes[1];
    expect(node.status).toBe('REJECT');
    expect(node.rejectInfo).toMatchObject({ reason: '需求本身有问题', fromNodeId: null });
    // 黑板追加打回记录
    const record = JSON.parse(instance.blackboard.get('打回-n2-1')!);
    expect(record).toMatchObject({ reason: '需求本身有问题' });
    // 上游 n1（DONE）再次进入 REWORK
    const upstream = instance.nodes[0];
    expect(upstream.status).toBe('REWORK');
    expect(upstream.reworkCount).toBe(1);
    expect(hooks.onNodeRework).toHaveBeenCalledWith(
      instance,
      upstream,
      expect.objectContaining({ reason: '需求本身有问题', fromNodeId: 'n2' }),
    );
  });

  it('E17: 链式打回后 complete：下游仍为 REJECT 的节点随本节点完成而复工（流程不卡住）', async () => {
    const instance = linearInstance();
    // 场景：n3 打回 n2、n2 打回 n1 后，n1 返工完成使 n2 复工（RUNNING）；n3 仍为 REJECT
    instance.nodes[0].status = 'DONE';
    instance.nodes[1].status = 'RUNNING';
    instance.nodes[2].status = 'REJECT';
    loadInstance(instance);

    await workflowEngine.transition('inst-1', 'n2', 'complete', {
      artifacts: [{ title: '方案', value: '修订版方案' }],
    });

    expect(instance.nodes[1].status).toBe('DONE');
    // 下游 REJECT 节点被 resume（而非 start，start 对 REJECT 非法会卡住流程）
    expect(instance.nodes[2].status).toBe('RUNNING');
    expect(hooks.onNodeResume).toHaveBeenCalledWith(instance, instance.nodes[2]);
    expect(hooks.onNodeDone).toHaveBeenCalledWith(instance, instance.nodes[1]);
  });

  it('E10: 多上游汇合：部分上游 DONE 时不 RUNNING，全部 DONE 才 READY→RUNNING', async () => {
    const instance = makeInstance([
      makeNode({ nodeId: 'n1', nodeKey: 'n1', name: '需求', status: 'DONE' }),
      makeNode({ nodeId: 'n2', nodeKey: 'n2', type: 'AI', name: '方案', status: 'RUNNING' }),
      makeNode({ nodeId: 'n3', nodeKey: 'n3', type: 'AI', name: '联调', status: 'INITIALIZING', dependsOn: ['n1', 'n2'] }),
    ]);
    loadInstance(instance);

    // 部分上游 DONE：仅就绪
    await workflowEngine.transition('inst-1', 'n3', 'start');
    expect(instance.nodes[2].status).toBe('READY');
    expect(hooks.onNodeStart).not.toHaveBeenCalled();

    // 另一上游完成 → 级联触发 n3 start → RUNNING
    await workflowEngine.transition('inst-1', 'n2', 'complete', {});
    expect(instance.nodes[2].status).toBe('RUNNING');
    expect(hooks.onNodeStart).toHaveBeenCalledWith(instance, instance.nodes[2]);
  });

  it('E11: FLAG 节点收到上游完成事件即透传到下游，自身 DONE 且不产生会话', async () => {
    const instance = makeInstance([
      makeNode({ nodeId: 'n1', nodeKey: 'n1', name: '需求', status: 'DONE' }),
      makeNode({ nodeId: 'f1', nodeKey: 'f1', type: 'FLAG', name: '里程碑', status: 'INITIALIZING', dependsOn: ['n1'] }),
      makeNode({ nodeId: 'n2', nodeKey: 'n2', type: 'AI', name: '收尾', status: 'INITIALIZING', dependsOn: ['f1'] }),
    ]);
    loadInstance(instance);

    await workflowEngine.transition('inst-1', 'f1', 'start');

    expect(instance.nodes[1].status).toBe('DONE');
    // FLAG 不触发会话 hook；下游 AI 节点被接力
    expect(hooks.onNodeStart).toHaveBeenCalledTimes(1);
    expect(hooks.onNodeStart).toHaveBeenCalledWith(instance, instance.nodes[2]);
    expect(hooks.onNodeStart).not.toHaveBeenCalledWith(instance, instance.nodes[1]);
    expect(instance.nodes[2].status).toBe('RUNNING');
  });

  it('E12: 并行分支两个节点同时 RUNNING，currentNodeNames 含两个节点名', async () => {
    const instance = makeInstance([
      makeNode({ nodeId: 'n1', nodeKey: 'n1', name: '需求', status: 'DONE' }),
      makeNode({ nodeId: 'n2', nodeKey: 'n2', type: 'AI', name: '前端实现', status: 'INITIALIZING', dependsOn: ['n1'] }),
      makeNode({ nodeId: 'n3', nodeKey: 'n3', type: 'AI', name: '后端实现', status: 'INITIALIZING', dependsOn: ['n1'] }),
    ]);
    loadInstance(instance);

    await workflowEngine.transition('inst-1', 'n2', 'start');
    await workflowEngine.transition('inst-1', 'n3', 'start');

    expect(instance.nodes[1].status).toBe('RUNNING');
    expect(instance.nodes[2].status).toBe('RUNNING');
    expect(instance.currentNodeNames).toEqual(expect.arrayContaining(['前端实现', '后端实现']));
    expect(instance.currentNodeNames).toHaveLength(2);
  });

  it('reject 可通过 targetNodeIds 限定返工的上游（默认全部直接上游）', async () => {
    const instance = makeInstance([
      makeNode({ nodeId: 'n1', nodeKey: 'n1', name: '需求', status: 'DONE' }),
      makeNode({ nodeId: 'n2', nodeKey: 'n2', type: 'AI', name: '方案', status: 'DONE' }),
      makeNode({ nodeId: 'n3', nodeKey: 'n3', type: 'AI', name: '评审', status: 'DONE' }),
      makeNode({ nodeId: 'n4', nodeKey: 'n4', type: 'AI', name: '实现', status: 'RUNNING', dependsOn: ['n1', 'n2', 'n3'] }),
    ]);
    loadInstance(instance);

    await workflowEngine.transition('inst-1', 'n4', 'reject', { reason: '方案有问题', targetNodeIds: ['n2'] });

    expect(instance.nodes[3].status).toBe('REJECT');
    expect(instance.nodes[1].status).toBe('REWORK');
    expect(instance.nodes[0].status).toBe('DONE');
    expect(instance.nodes[2].status).toBe('DONE');
  });

  it('E13: RUNNING→FAILED（fail 携带 reason/source）：写 failInfo，阻断流程（下游不激活）', async () => {
    const instance = linearInstance();
    instance.nodes[0].status = 'DONE';
    instance.nodes[1].status = 'RUNNING';
    loadInstance(instance);

    await workflowEngine.transition('inst-1', 'n2', 'fail', {
      reason: '缺少关键信息，无法继续',
      source: 'LLM_REPORTED',
    });

    const node = instance.nodes[1];
    expect(node.status).toBe('FAILED');
    expect(node.failInfo).toMatchObject({ reason: '缺少关键信息，无法继续', source: 'LLM_REPORTED' });
    expect(node.failInfo?.at).toBeInstanceOf(Date);
    // 阻断：下游保持 INITIALIZING，不触发任何会话 hook
    expect(instance.nodes[2].status).toBe('INITIALIZING');
    expect(hooks.onNodeStart).not.toHaveBeenCalled();
    expect(instance.currentNodeNames).toEqual([]);
    expect(instance.save).toHaveBeenCalled();
  });

  it('E14: FAILED→RUNNING（resumeFailed）：清 failInfo；非 FAILED 状态拒绝', async () => {
    const instance = linearInstance();
    instance.nodes[1].status = 'FAILED';
    instance.nodes[1].failInfo = { reason: 'r', source: 'LLM_REPORTED', at: new Date() };
    loadInstance(instance);

    await workflowEngine.transition('inst-1', 'n2', 'resumeFailed');

    expect(instance.nodes[1].status).toBe('RUNNING');
    expect(instance.nodes[1].failInfo).toBeNull();
    expect(instance.currentNodeNames).toEqual(['技术方案']);

    // 非 FAILED 状态拒绝 resumeFailed
    for (const status of ['RUNNING', 'DONE', 'READY'] as const) {
      const inst2 = linearInstance();
      inst2.nodes[1].status = status;
      loadInstance(inst2);
      await expect(workflowEngine.transition('inst-1', 'n2', 'resumeFailed')).rejects.toThrow(/不允许/);
    }
  });

  it('E15: 非 RUNNING 状态调 fail 拒绝', async () => {
    for (const status of ['READY', 'DONE', 'FAILED', 'REJECT'] as const) {
      const instance = linearInstance();
      instance.nodes[1].status = status;
      loadInstance(instance);
      await expect(
        workflowEngine.transition('inst-1', 'n2', 'fail', { reason: 'r' }),
      ).rejects.toThrow(/不允许/);
    }
  });

  it('实例或节点不存在时拒绝', async () => {
    vi.mocked(WorkflowInstance.findById).mockResolvedValue(null as never);
    await expect(workflowEngine.transition('inst-x', 'n1', 'start')).rejects.toThrow(/实例不存在/);

    const instance = linearInstance();
    loadInstance(instance);
    await expect(workflowEngine.transition('inst-1', 'ghost', 'start')).rejects.toThrow(/不存在节点/);
  });

  it('已删除实例（deletedAt 非空）拒绝一切转移', async () => {
    const instance = linearInstance();
    instance.nodes[1].status = 'RUNNING';
    instance.deletedAt = new Date();
    loadInstance(instance);

    await expect(workflowEngine.transition('inst-1', 'n2', 'complete', {})).rejects.toThrow(/已删除/);
    expect(instance.nodes[1].status).toBe('RUNNING');
  });

  it('E18: 转移记录最后执行节点（级联末位为准）：complete 有下游时为下游节点', async () => {
    const instance = linearInstance();
    instance.nodes[0].status = 'DONE';
    instance.nodes[1].status = 'RUNNING';
    loadInstance(instance);

    // n2 complete → 下游 n3 start（AI，上游全 DONE → RUNNING）→ lastNode = n3
    await workflowEngine.transition('inst-1', 'n2', 'complete', {});

    expect(instance.lastNodeName).toBe('代码实现');
    expect(instance.lastNodeStatus).toBe('RUNNING');
  });

  it('E19: 终端 complete 的 lastNode 为自身 DONE；reject 级联后 lastNode 为上游 REWORK', async () => {
    // 终端节点 complete → lastNode = 自身 DONE
    const inst1 = linearInstance();
    inst1.nodes[0].status = 'DONE';
    inst1.nodes[1].status = 'DONE';
    inst1.nodes[2].status = 'RUNNING';
    loadInstance(inst1);
    await workflowEngine.transition('inst-1', 'n3', 'complete', {});
    expect(inst1.lastNodeName).toBe('代码实现');
    expect(inst1.lastNodeStatus).toBe('DONE');

    // n2 reject → 级联 n1 REWORK → lastNode = n1 REWORK
    const inst2 = linearInstance();
    inst2.nodes[0].status = 'DONE';
    inst2.nodes[1].status = 'RUNNING';
    loadInstance(inst2);
    await workflowEngine.transition('inst-1', 'n2', 'reject', { reason: '方案不完整' });
    expect(inst2.lastNodeName).toBe('需求');
    expect(inst2.lastNodeStatus).toBe('REWORK');
  });
});
