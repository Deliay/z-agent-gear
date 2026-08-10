import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../session.js', () => ({
  sessionService: {
    create: vi.fn(),
    addMessage: vi.fn(),
    resume: vi.fn(),
    close: vi.fn(),
    onSessionEnded: vi.fn(),
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

import { workflowOrchestrator, WORKFLOW_SYSTEM_PROMPT } from './orchestrator.js';
import { workflowEngine, type WorkflowInstanceDoc, type WorkflowNodeDoc } from './engine.js';
import { sessionService } from '../session.js';
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
        agentConfig: { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: true },
      },
      {
        nodeKey: 'impl',
        type: 'AI',
        name: '代码实现',
        stage: 'impl',
        prompts: ['实现代码'],
        dependsOn: ['design'],
        requiresWorktree: true,
        agentConfig: { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: true },
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

  it('O3b: 节点会话自动装配平台工作流工具服务（幂等 upsert transport/source=platform）', async () => {
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
    expect(sessionService.create).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ mcpServerIds: ['mcp-platform-1'] }),
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

    expect(sessionService.resume).toHaveBeenCalledWith('sess-2', 'user-1');
    const content = lastInputMessage();
    expect(content).toContain('工作流');
    expect(content).toContain('工具');
    expect(instance.nodes[0].fallbackSent).toBe(true);
    expect(instance.save).toHaveBeenCalled();

    // 第二次不再发送（防死循环）
    vi.clearAllMocks();
    await workflowOrchestrator.handleSessionEnded('sess-2');
    expect(sessionService.resume).not.toHaveBeenCalled();
    expect(sessionService.addMessage).not.toHaveBeenCalled();
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

  it('reworkNodeSession: resume 原会话并发送打回原因', async () => {
    const instance = makeInstance([
      makeNode({ nodeId: 'n2', nodeKey: 'design', type: 'AI', name: '技术方案', stage: 'design', status: 'REWORK', dependsOn: [], sessionId: 'sess-2' }),
    ]);
    vi.mocked(sessionService.resume).mockResolvedValue({ success: true, status: 'connecting' } as never);

    await workflowOrchestrator.reworkNodeSession(instance, instance.nodes[0], { reason: '方案不完整', fromNodeId: 'n3' });

    expect(sessionService.resume).toHaveBeenCalledWith('sess-2', 'user-1');
    expect(lastInputMessage()).toContain('方案不完整');
  });

  it('resumeNodeSession: 通知 REJECT 节点会话重新获取产物', async () => {
    const instance = makeInstance([
      makeNode({ nodeId: 'n3', nodeKey: 'impl', type: 'AI', name: '代码实现', stage: 'impl', status: 'RUNNING', dependsOn: [], sessionId: 'sess-3' }),
    ]);

    await workflowOrchestrator.resumeNodeSession(instance, instance.nodes[0]);

    expect(lastInputMessage()).toContain('重新获取');
  });
});
