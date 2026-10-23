import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../session.js', () => ({
  sessionService: {
    create: vi.fn(),
    addMessage: vi.fn(),
    resume: vi.fn(),
    close: vi.fn(),
    setMode: vi.fn(),
    setModel: vi.fn(),
    onSessionEnded: vi.fn(),
    onSessionRemoved: vi.fn(),
    onSessionIdled: vi.fn(),
  },
}));

vi.mock('../todo-service.js', () => ({
  todoService: {
    createWorkflowInterventionTodo: vi.fn(),
  },
}));

vi.mock('../../models/configured-workflow.js', () => ({
  ConfiguredWorkflow: {
    findById: vi.fn(),
    findOne: vi.fn(),
  },
}));

vi.mock('../../models/workflow-instance.js', () => ({
  WorkflowInstance: {
    findById: vi.fn(),
    findOne: vi.fn(),
  },
}));

vi.mock('../../models/mcp-server.js', () => ({
  McpServer: {
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock('./admin-tools.js', () => ({
  ADMIN_PLATFORM_SERVER_NAME: 'agent-workflow-admin-tools',
  ensureAdminToolsServer: vi.fn().mockResolvedValue('mcp-admin-1'),
}));

import { workflowOrchestrator, WORKFLOW_SYSTEM_PROMPT } from './orchestrator.js';
import { workflowEngine, type WorkflowInstanceDoc, type WorkflowNodeDoc } from './engine.js';
import { sessionService } from '../session.js';
import { todoService } from '../todo-service.js';
import { ConfiguredWorkflow } from '../../models/configured-workflow.js';
import { WorkflowInstance } from '../../models/workflow-instance.js';
import { McpServer } from '../../models/mcp-server.js';

function oid(id: string) {
  return { toString: () => id } as import('mongoose').Types.ObjectId;
}

function leanQuery(result: unknown) {
  return { lean: vi.fn().mockResolvedValue(result) } as never;
}

function makeNode(overrides: Partial<WorkflowNodeDoc> = {}): WorkflowNodeDoc {
  return {
    nodeId: 'n1',
    nodeKey: 'requirement',
    type: 'HUMAN',
    name: '需求',
    stage: '需求',
    status: 'DONE',
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

function makeConfigured() {
  return {
    _id: oid('cfg-1'),
    nodes: [
      {
        nodeKey: 'requirement',
        type: 'HUMAN',
        name: '需求',
        stage: '需求',
        dependsOn: [],
        requiresWorktree: false,
        agentConfig: null,
      },
      {
        nodeKey: 'design',
        type: 'AI',
        name: '技术方案',
        stage: 'design',
        prompts: ['产出技术方案', '包含架构图'],
        dependsOn: ['requirement'],
        requiresWorktree: true,
        agentConfig: { acpServerType: 'opencode', modeId: null as string | null, modelId: null as string | null, initNewWorktree: true },
      },
      {
        nodeKey: 'impl',
        type: 'AI',
        name: '代码实现',
        stage: 'impl',
        prompts: ['实现代码'],
        dependsOn: ['design'],
        requiresWorktree: true,
        agentConfig: { acpServerType: 'opencode', modeId: null as string | null, modelId: null as string | null, initNewWorktree: true },
      },
    ],
  };
}

function lastInputMessage(): string {
  const calls = vi.mocked(sessionService.addMessage).mock.calls;
  return (calls[calls.length - 1][1] as { content: string }).content;
}

describe('WorkflowOrchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ConfiguredWorkflow.findById).mockReturnValue(leanQuery(makeConfigured()));
    vi.mocked(sessionService.create).mockResolvedValue({ id: 'sess-new' } as never);
    vi.mocked(McpServer.findOneAndUpdate).mockResolvedValue({ _id: oid('mcp-platform-1') } as never);
  });

  it('O1: AI 节点 start 提示词组装 = 系统提示 + 节点提示词数组 + 全部上游产物', async () => {
    const instance = makeInstance([
      makeNode(),
      makeNode({ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', stage: 'design', status: 'READY', dependsOn: ['n1'] }),
    ]);
    instance.blackboard.set('n1-需求-产物-输入', '做一个工作流功能');

    const node = instance.nodes[1];
    await workflowOrchestrator.startNodeSession(instance, node);

    const content = lastInputMessage();
    expect(content).toContain(WORKFLOW_SYSTEM_PROMPT);
    expect(content).toContain('产出技术方案');
    expect(content).toContain('包含架构图');
    expect(content).toContain('n1-需求-产物-输入');
    expect(content).toContain('做一个工作流功能');
  });

  it('O2: 无上游产物的节点提示词仅含系统提示 + 节点提示词', async () => {
    const instance = makeInstance([
      makeNode(),
      makeNode({ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', stage: 'design', status: 'READY', dependsOn: ['n1'] }),
    ]);

    await workflowOrchestrator.startNodeSession(instance, instance.nodes[1]);

    const content = lastInputMessage();
    expect(content).toContain(WORKFLOW_SYSTEM_PROMPT);
    expect(content).toContain('产出技术方案');
    expect(content).not.toContain('上游产物');
  });

  it('O3a: AI 节点配置的 modeId/modelId 透传到 sessionService.create（harness 会话初始化为配置值而非默认）', async () => {
    const configured = makeConfigured();
    configured.nodes[1].agentConfig = {
      acpServerType: 'opencode',
      modeId: 'code',
      modelId: 'gpt-5',
      initNewWorktree: true,
    };
    vi.mocked(ConfiguredWorkflow.findById).mockReturnValue(leanQuery(configured));

    const instance = makeInstance([
      makeNode(),
      makeNode({ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', stage: 'design', status: 'READY', dependsOn: ['n1'] }),
    ]);

    await workflowOrchestrator.startNodeSession(instance, instance.nodes[1]);

    expect(sessionService.create).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ modeId: 'code', modelId: 'gpt-5' }),
    );
  });

  it('O3b: agentConfig 未配置 mode/model 时不透传（保持 undefined，使用 harness 默认）', async () => {
    const configured = makeConfigured();
    configured.nodes[1].agentConfig = {
      acpServerType: 'opencode',
      modeId: null,
      modelId: null,
      initNewWorktree: true,
    };
    vi.mocked(ConfiguredWorkflow.findById).mockReturnValue(leanQuery(configured));

    const instance = makeInstance([
      makeNode(),
      makeNode({ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', stage: 'design', status: 'READY', dependsOn: ['n1'] }),
    ]);

    await workflowOrchestrator.startNodeSession(instance, instance.nodes[1]);

    const call = vi.mocked(sessionService.create).mock.calls[0][1] as Record<string, unknown>;
    expect(call.modeId).toBeUndefined();
    expect(call.modelId).toBeUndefined();
  });

  it('O3: 会话打标：create 参数含 workflowInstanceId/workflowNodeId，节点回填 sessionId', async () => {
    const instance = makeInstance([
      makeNode(),
      makeNode({ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', stage: 'design', status: 'READY', dependsOn: ['n1'] }),
    ]);

    const node = instance.nodes[1];
    await workflowOrchestrator.startNodeSession(instance, node);

    expect(sessionService.create).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ workflowInstanceId: 'inst-1', workflowNodeId: 'n2' }),
    );
    expect(node.sessionId).toBe('sess-new');
  });

  it('O3b: 节点会话自动装配平台工作流工具服务 + 管理工具集（幂等 upsert transport/source=platform）', async () => {
    const instance = makeInstance([
      makeNode(),
      makeNode({ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', stage: 'design', status: 'READY', dependsOn: ['n1'] }),
    ]);

    await workflowOrchestrator.startNodeSession(instance, instance.nodes[1]);

    expect(McpServer.findOneAndUpdate).toHaveBeenCalledWith(
      { userId: 'user-1', name: 'agent-workflow-tools' },
      {
        $setOnInsert: expect.objectContaining({
          name: 'agent-workflow-tools',
          transport: 'platform',
          source: 'platform',
          enabled: true,
        }),
      },
      { upsert: true, new: true },
    );
    // 管理工具集同样被装配进节点会话
    expect(sessionService.create).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ mcpServerIds: ['mcp-platform-1', 'mcp-admin-1'] }),
    );
  });

  it('O4: 阶段 worktree 后缀为 <instance-slug>/<stage-slug>，同阶段节点复用', async () => {
    const instance = makeInstance([
      makeNode(),
      makeNode({ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', stage: 'design', status: 'READY', dependsOn: ['n1'] }),
      makeNode({ nodeId: 'n3', nodeKey: 'impl', type: 'AI', name: '代码实现', stage: 'impl', status: 'READY', dependsOn: ['n2'] }),
    ]);

    await workflowOrchestrator.startNodeSession(instance, instance.nodes[1]);
    expect(sessionService.create).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ enableWorktree: true, worktreeBranchSuffix: 'demo-instance/design' }),
    );

    // 同阶段（design）另一节点复用同一后缀
    const sameStageNode = makeNode({
      nodeId: 'n4', nodeKey: 'design', type: 'AI', name: '方案修订', stage: 'design', status: 'READY', dependsOn: ['n1'],
    });
    await workflowOrchestrator.startNodeSession(instance, sameStageNode);
    expect(vi.mocked(sessionService.create).mock.calls[1][1]).toMatchObject({
      worktreeBranchSuffix: 'demo-instance/design',
    });
  });

  it('O4b: requiresWorktree=false 的节点不启用 worktree', async () => {
    const configured = makeConfigured();
    configured.nodes[1].requiresWorktree = false;
    vi.mocked(ConfiguredWorkflow.findById).mockReturnValue(leanQuery(configured));

    const instance = makeInstance([
      makeNode(),
      makeNode({ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', stage: 'design', status: 'READY', dependsOn: ['n1'] }),
    ]);
    await workflowOrchestrator.startNodeSession(instance, instance.nodes[1]);

    expect(sessionService.create).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ enableWorktree: false, worktreeBranchSuffix: undefined }),
    );
  });

  it('O8: 节点完成时先触发下游 start（新建会话）再结束本会话', async () => {
    const instance = makeInstance([
      makeNode(),
      makeNode({ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', stage: 'design', status: 'RUNNING', dependsOn: ['n1'], sessionId: 'sess-2' }),
      makeNode({ nodeId: 'n3', nodeKey: 'impl', type: 'AI', name: '代码实现', stage: 'impl', status: 'INITIALIZING', dependsOn: ['n2'] }),
    ]);
    vi.mocked(WorkflowInstance.findById).mockResolvedValue(instance as never);
    workflowOrchestrator.register();

    await workflowEngine.transition('inst-1', 'n2', 'complete', {});

    // 下游会话被创建
    expect(sessionService.create).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ workflowNodeId: 'n3' }),
    );
    // 本会话被结束，且顺序：先 create（下游）后 close（本会话）
    expect(sessionService.close).toHaveBeenCalledWith('sess-2', 'user-1');
    expect(vi.mocked(sessionService.create).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sessionService.close).mock.invocationCallOrder[0],
    );
  });

  it('O6: 兜底——会话 ended 且节点仍 RUNNING 时 resume 并发送兜底提示词（每节点仅 1 次）', async () => {
    const instance = makeInstance([
      makeNode({ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', stage: 'design', status: 'RUNNING', dependsOn: [], sessionId: 'sess-2' }),
    ]);
    vi.mocked(WorkflowInstance.findOne).mockResolvedValue(instance as never);
    vi.mocked(sessionService.resume).mockResolvedValue({ success: true, status: 'connecting' } as never);

    await workflowOrchestrator.handleSessionEnded('sess-2');

    // 兜底 resume 同样带内下发初始配置（无配置时为 undefined）
    expect(sessionService.resume).toHaveBeenCalledWith('sess-2', 'user-1', undefined);
    const content = lastInputMessage();
    expect(content).toContain('工作流');
    expect(content).toContain('工具');
    expect(instance.nodes[0].fallbackSent).toBe(true);
    expect(instance.save).toHaveBeenCalled();

    // 第二次停止：不再 resume（防死循环），节点升级为 FAILED（阻断流程等待人工介入）
    vi.clearAllMocks();
    vi.mocked(WorkflowInstance.findById).mockResolvedValue(instance as never);
    await workflowOrchestrator.handleSessionEnded('sess-2');
    expect(sessionService.resume).not.toHaveBeenCalled();
    expect(sessionService.addMessage).not.toHaveBeenCalled();
    expect(instance.nodes[0].status).toBe('FAILED');
    expect(instance.nodes[0].failInfo).toMatchObject({ source: 'SESSION_STUCK' });
    expect(instance.save).toHaveBeenCalled();
  });

  it('O7: 兜底——会话 ended 但节点已转移（非 RUNNING）时不发送兜底提示词', async () => {
    const instance = makeInstance([
      makeNode({ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', stage: 'design', status: 'DONE', dependsOn: [], sessionId: 'sess-2' }),
    ]);
    vi.mocked(WorkflowInstance.findOne).mockResolvedValue(instance as never);

    await workflowOrchestrator.handleSessionEnded('sess-2');

    expect(sessionService.resume).not.toHaveBeenCalled();
    expect(sessionService.addMessage).not.toHaveBeenCalled();
  });

  it('O9: 会话被移除（start/resume 失败清理）且节点仍 RUNNING → 节点升级 FAILED（SESSION_START_FAILED）', async () => {
    const instance = makeInstance([
      makeNode({ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', stage: 'design', status: 'RUNNING', dependsOn: [], sessionId: 'sess-2' }),
    ]);
    vi.mocked(WorkflowInstance.findOne).mockResolvedValue(instance as never);
    vi.mocked(WorkflowInstance.findById).mockResolvedValue(instance as never);

    await workflowOrchestrator.handleSessionRemoved('sess-2');

    // 会话已不存在，兜底 resume 无意义——节点必须可见地失败，而非静默卡死
    expect(sessionService.resume).not.toHaveBeenCalled();
    expect(instance.nodes[0].status).toBe('FAILED');
    expect(instance.nodes[0].failInfo).toMatchObject({ source: 'SESSION_START_FAILED' });
    expect(instance.save).toHaveBeenCalled();
  });

  it('O9b: 会话被移除但节点已转移（DONE）→ 忽略', async () => {
    const instance = makeInstance([
      makeNode({ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', stage: 'design', status: 'DONE', dependsOn: [], sessionId: 'sess-2' }),
    ]);
    vi.mocked(WorkflowInstance.findOne).mockResolvedValue(instance as never);

    await workflowOrchestrator.handleSessionRemoved('sess-2');

    expect(instance.nodes[0].status).toBe('DONE');
    expect(instance.save).not.toHaveBeenCalled();
  });

  it('O10: 空闲停滞（turn 结束节点未推进）首次 → 置 fallbackSent 并补发提醒提示词（不 resume）', async () => {
    const instance = makeInstance([
      makeNode({ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', stage: 'design', status: 'RUNNING', dependsOn: [], sessionId: 'sess-2' }),
    ]);
    vi.mocked(WorkflowInstance.findOne).mockResolvedValue(instance as never);

    await workflowOrchestrator.handleSessionIdled('sess-2');

    // 会话仍存活（idling），无需 resume；直接补发提醒让 AI 继续
    expect(sessionService.resume).not.toHaveBeenCalled();
    expect(sessionService.addMessage).toHaveBeenCalled();
    expect(lastInputMessage()).toContain('工作流');
    expect(instance.nodes[0].fallbackSent).toBe(true);
    expect(instance.save).toHaveBeenCalled();
    // 未升级失败
    expect(instance.nodes[0].status).toBe('RUNNING');
  });

  it('O10b: 再次空闲停滞 → 节点升级 FAILED（SESSION_STUCK）并创建人工介入强提醒待办', async () => {
    const instance = makeInstance([
      makeNode({ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', stage: 'design', status: 'RUNNING', dependsOn: [], sessionId: 'sess-2', fallbackSent: true }),
    ]);
    vi.mocked(WorkflowInstance.findOne).mockResolvedValue(instance as never);
    vi.mocked(WorkflowInstance.findById).mockResolvedValue(instance as never);

    await workflowOrchestrator.handleSessionIdled('sess-2');

    expect(sessionService.addMessage).not.toHaveBeenCalled();
    expect(instance.nodes[0].status).toBe('FAILED');
    expect(instance.nodes[0].failInfo).toMatchObject({ source: 'SESSION_STUCK' });
    expect(todoService.createWorkflowInterventionTodo).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', nodeName: '技术方案' }),
    );
  });

  it('O10c: 空闲事件但节点已转移（DONE）→ 忽略', async () => {
    const instance = makeInstance([
      makeNode({ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', stage: 'design', status: 'DONE', dependsOn: [], sessionId: 'sess-2' }),
    ]);
    vi.mocked(WorkflowInstance.findOne).mockResolvedValue(instance as never);

    await workflowOrchestrator.handleSessionIdled('sess-2');

    expect(sessionService.addMessage).not.toHaveBeenCalled();
    expect(instance.save).not.toHaveBeenCalled();
  });

  it('O10d: 非工作流会话的空闲事件 → 忽略', async () => {
    vi.mocked(WorkflowInstance.findOne).mockResolvedValue(null as never);

    await workflowOrchestrator.handleSessionIdled('sess-normal');

    expect(sessionService.addMessage).not.toHaveBeenCalled();
  });

  it('reworkNodeSession: resume 原会话、初始 Mode/模型随 acp:resume 带内下发、重发打回原因', async () => {
    const instance = makeInstance([
      makeNode({ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', stage: 'design', status: 'REWORK', dependsOn: [], sessionId: 'sess-2' }),
    ]);
    vi.mocked(sessionService.resume).mockResolvedValue({ success: true, status: 'connecting' } as never);
    const configured = makeConfigured();
    configured.nodes[1].agentConfig = { acpServerType: 'opencode', modeId: 'code', modelId: 'gpt-5', initNewWorktree: true } as unknown as typeof configured.nodes[1]['agentConfig'];
    vi.mocked(ConfiguredWorkflow.findById).mockReturnValue(leanQuery(configured));

    await workflowOrchestrator.reworkNodeSession(instance, instance.nodes[0], { reason: '方案不完整', fromNodeId: 'n3' });

    // 初始 mode/model 随 resume 带内下发（bridge 在首条 prompt 前应用）；
    // setMode/setModel 的 idling 守卫在 resume 阶段恒丢弃，不得再依赖
    expect(sessionService.resume).toHaveBeenCalledWith('sess-2', 'user-1', { modeId: 'code', modelId: 'gpt-5' });
    expect(sessionService.setMode).not.toHaveBeenCalled();
    expect(sessionService.setModel).not.toHaveBeenCalled();
    expect(lastInputMessage()).toContain('方案不完整');
  });

  it('resumeNodeSession: 关闭下游 REJECT 节点空闲会话，并以全新会话复工', async () => {
    const instance = makeInstance([
      makeNode({ nodeId: 'n3', nodeKey: 'impl', type: 'AI', name: '代码实现', stage: 'impl', status: 'RUNNING', dependsOn: [], sessionId: 'sess-3' }),
    ]);
    vi.mocked(sessionService.close).mockResolvedValue(true);

    await workflowOrchestrator.resumeNodeSession(instance, instance.nodes[0]);

    // 关闭阻塞期间的空闲会话
    expect(sessionService.close).toHaveBeenCalledWith('sess-3', 'user-1');
    // 以全新会话复工（startNodeSession 创建新会话并发送提示词）
    expect(sessionService.create).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ workflowNodeId: 'n3' }),
    );
  });

  it('resumeNodeSession: HUMAN 节点复工不拉起会话（不调用 close/create）', async () => {
    const instance = makeInstance([
      makeNode({ nodeId: 'n3', nodeKey: 'review', type: 'HUMAN', name: '评审', stage: '验收', status: 'RUNNING', dependsOn: [] }),
    ]);
    vi.mocked(sessionService.close).mockResolvedValue(true);

    await workflowOrchestrator.resumeNodeSession(instance, instance.nodes[0]);

    expect(sessionService.close).not.toHaveBeenCalled();
    expect(sessionService.create).not.toHaveBeenCalled();
  });

  it('resumeNodeSession: FLAG 节点复工不拉起会话（不调用 close/create）', async () => {
    const instance = makeInstance([
      makeNode({ nodeId: 'f1', nodeKey: 'milestone', type: 'FLAG', name: '里程碑', stage: '验收', status: 'RUNNING', dependsOn: [] }),
    ]);
    vi.mocked(sessionService.close).mockResolvedValue(true);

    await workflowOrchestrator.resumeNodeSession(instance, instance.nodes[0]);

    expect(sessionService.close).not.toHaveBeenCalled();
    expect(sessionService.create).not.toHaveBeenCalled();
  });

  it('resumeNodeSession: AI 节点复工仍关闭旧会话并拉起全新会话', async () => {
    const instance = makeInstance([
      makeNode({ nodeId: 'n3', nodeKey: 'impl', type: 'AI', name: '代码实现', stage: 'impl', status: 'RUNNING', dependsOn: [], sessionId: 'sess-3' }),
    ]);
    vi.mocked(sessionService.close).mockResolvedValue(true);

    await workflowOrchestrator.resumeNodeSession(instance, instance.nodes[0]);

    expect(sessionService.close).toHaveBeenCalledWith('sess-3', 'user-1');
    expect(sessionService.create).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ workflowNodeId: 'n3' }),
    );
  });

  it('restart 节点：引擎 restart 事件关闭旧会话并拉起全新会话（onNodeRestart 接 resumeNodeSession）', async () => {
    const instance = makeInstance([
      makeNode({ nodeId: 'n3', nodeKey: 'impl', type: 'AI', name: '代码实现', stage: 'impl', status: 'FAILED', dependsOn: [], sessionId: 'sess-3', failInfo: { reason: 'r', source: 'SESSION_STUCK', at: new Date() } }),
    ]);
    vi.mocked(WorkflowInstance.findById).mockResolvedValue(instance as never);
    vi.mocked(sessionService.close).mockResolvedValue(true);
    workflowOrchestrator.register();

    await workflowEngine.transition('inst-1', 'n3', 'restart', {});

    expect(sessionService.close).toHaveBeenCalledWith('sess-3', 'user-1');
    expect(sessionService.create).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ workflowNodeId: 'n3' }),
    );
    expect(instance.nodes[0].status).toBe('RUNNING');
    expect(instance.nodes[0].failInfo).toBeNull();
  });

  it('restart 人类节点不拉起会话（类型守卫）', async () => {
    const instance = makeInstance([
      makeNode({ nodeId: 'n3', nodeKey: 'review', type: 'HUMAN', name: '评审', stage: '验收', status: 'RUNNING', dependsOn: [] }),
    ]);
    vi.mocked(WorkflowInstance.findById).mockResolvedValue(instance as never);
    workflowOrchestrator.register();

    await workflowEngine.transition('inst-1', 'n3', 'restart', {});

    expect(sessionService.close).not.toHaveBeenCalled();
    expect(sessionService.create).not.toHaveBeenCalled();
    expect(instance.nodes[0].status).toBe('RUNNING');
  });

  it('S1: 新实例节点（含快照字段）提示词/Agent 配置来自快照，不回查配置', async () => {
    const snapshotNode = {
      ...makeNode({ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', stage: 'design', status: 'READY', dependsOn: ['n1'] }),
      prompts: ['快照提示词A', '快照提示词B'],
      requiresWorktree: true,
      agentConfig: { acpServerType: 'claude_code', modeId: 'plan', modelId: null, initNewWorktree: true },
    };
    const instance = makeInstance([makeNode(), snapshotNode]);

    await workflowOrchestrator.startNodeSession(instance, instance.nodes[1]);

    // 不回查配置
    expect(ConfiguredWorkflow.findById).not.toHaveBeenCalled();
    const content = lastInputMessage();
    expect(content).toContain('快照提示词A');
    expect(content).not.toContain('产出技术方案');
    expect(sessionService.create).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ acpServerType: 'claude_code', enableWorktree: true }),
    );
  });

  it('S2: 旧实例节点（无快照字段）回退 loadConfiguredNode，行为与一期一致', async () => {
    const oldNode = makeNode({ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', stage: 'design', status: 'READY', dependsOn: ['n1'] });
    const instance = makeInstance([makeNode(), oldNode]);
    vi.mocked(ConfiguredWorkflow.findById).mockReturnValue(leanQuery(makeConfigured()));

    await workflowOrchestrator.startNodeSession(instance, instance.nodes[1]);

    expect(ConfiguredWorkflow.findById).toHaveBeenCalled();
    const content = lastInputMessage();
    expect(content).toContain('产出技术方案');
  });

  it('S3: 配置被删除后旧实例节点回查失败，错误可读', async () => {
    const oldNode = makeNode({ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', stage: 'design', status: 'READY', dependsOn: ['n1'] });
    const instance = makeInstance([makeNode(), oldNode]);
    vi.mocked(ConfiguredWorkflow.findById).mockReturnValue(leanQuery(null));

    await expect(workflowOrchestrator.startNodeSession(instance, instance.nodes[1])).rejects.toThrow(
      /已配置工作流不存在/,
    );
  });
});

describe('assemblePrompt 追加提示词', () => {
  function instanceWith(additionalPrompts: unknown) {
    return {
      _id: oid('inst-1'),
      nodes: [
        { nodeId: 'n1', nodeKey: 'requirement', type: 'HUMAN', name: '需求', stage: '需求', status: 'DONE', dependsOn: [], reworkCount: 0 },
        { nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '方案', stage: '设计', status: 'READY', dependsOn: ['n1'], reworkCount: 0 },
      ],
      blackboard: new Map([['n1-需求-产物-输入', '需求内容']]),
      blackboardTrash: new Map(),
      blackboardUpdatedAt: new Map(),
      additionalPrompts,
    } as unknown as WorkflowInstanceDoc;
  }

  const node = {
    nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '方案', stage: '设计', status: 'READY', dependsOn: ['n1'], reworkCount: 0,
  } as unknown as WorkflowNodeDoc;

  it('无追加提示词时与现状一致（不含追加段）', () => {
    const text = workflowOrchestrator.assemblePrompt(instanceWith(undefined), node, ['产出方案']);
    expect(text).not.toContain('## 追加提示词');
  });

  it('按 key 升序追加，每 key 一段且位于上游产物之后', () => {
    const text = workflowOrchestrator.assemblePrompt(
      instanceWith(new Map([['github-pr-review', '评审意见'], ['github-pr', '指引']])),
      node,
      ['产出方案'],
    );
    expect(text.indexOf('## 追加提示词')).toBeGreaterThan(text.indexOf('## 上游产物'));
    expect(text.indexOf('### github-pr')).toBeLessThan(text.indexOf('### github-pr-review'));
    expect(text).toContain('### github-pr\n指引');
  });

  it('同 key 覆盖后只出现一次', () => {
    const map = new Map<string, string>();
    map.set('github-pr', '旧值');
    map.set('github-pr', '新值');
    const text = workflowOrchestrator.assemblePrompt(instanceWith(map), node, []);
    expect(text.match(/### github-pr/g)).toHaveLength(1);
    expect(text).toContain('新值');
    expect(text).not.toContain('旧值');
  });

  it('兼容 lean 普通对象', () => {
    const text = workflowOrchestrator.assemblePrompt(instanceWith({ 'github-pr': '指引' }), node, []);
    expect(text).toContain('## 追加提示词');
    expect(text).toContain('### github-pr\n指引');
  });
});
