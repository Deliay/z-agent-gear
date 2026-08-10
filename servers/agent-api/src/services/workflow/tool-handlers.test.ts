import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../models/workflow-instance.js', () => ({
  WorkflowInstance: {
    findById: vi.fn(),
  },
}));

vi.mock('./engine.js', () => ({
  workflowEngine: {
    transition: vi.fn(),
  },
}));

import {
  callWorkflowTool,
  getWorkflowToolDefinitions,
  WorkflowToolError,
  type WorkflowToolScope,
} from './tool-handlers.js';
import { workflowEngine } from './engine.js';
import { WorkflowInstance } from '../../models/workflow-instance.js';

function oid(id: string) {
  return { toString: () => id } as import('mongoose').Types.ObjectId;
}

const SCOPE: WorkflowToolScope = { instanceId: 'inst-1', nodeId: 'n2', userId: 'user-1' };

function makeInstance(overrides: Record<string, unknown> = {}) {
  return {
    _id: oid('inst-1'),
    userId: oid('user-1'),
    name: 'demo',
    currentNodeNames: ['技术方案'],
    nodes: [
      {
        nodeId: 'n1',
        nodeKey: 'requirement',
        type: 'HUMAN',
        name: '产品需求',
        stage: '方案阶段',
        status: 'DONE',
        dependsOn: [],
        reworkCount: 0,
        createdAt: new Date('2026-08-01'),
      },
      {
        nodeId: 'n2',
        nodeKey: 'design',
        type: 'AI',
        name: '技术方案',
        stage: '方案阶段',
        status: 'RUNNING',
        dependsOn: ['n1'],
        sessionId: oid('sess-2'),
        reworkCount: 1,
        startedAt: new Date('2026-08-02'),
        createdAt: new Date('2026-08-01'),
      },
    ],
    blackboard: new Map<string, string>([
      ['n1-产品需求-产物-输入', '做一个工作流功能'],
      ['n2-技术方案-产物-技术方案文档', '方案内容'],
      ['打回-n2-1', '{"reason":"x"}'],
    ]),
    blackboardTrash: new Map<string, string>(),
    blackboardUpdatedAt: new Map<string, Date>(),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function loadInstance(instance = makeInstance()) {
  vi.mocked(WorkflowInstance.findById).mockResolvedValue(instance as never);
  return instance;
}

function expectToolError(code: string) {
  return (err: unknown) => {
    expect(err).toBeInstanceOf(WorkflowToolError);
    expect((err as WorkflowToolError).code).toBe(code);
    return true;
  };
}

describe('workflow tool-handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('工具定义', () => {
    it('提供全部 10 个工具且带 inputSchema', () => {
      const defs = getWorkflowToolDefinitions();
      expect(defs.map((d) => d.name).sort()).toEqual(
        [
          'getCurrentNodeId',
          'getParentNodeIds',
          'getNodeInfo',
          'getNodeArtifactKeys',
          'getBlackboardKeys',
          'getBlackboardValue',
          'removeBlackboardKey',
          'completeCurrentNode',
          'rejectCurrentNode',
          'completeCurrentRework',
        ].sort(),
      );
      for (const def of defs) {
        expect(def.description).toBeTruthy();
        expect(def.inputSchema).toMatchObject({ type: 'object' });
      }
    });
  });

  describe('作用域校验', () => {
    it('非节点会话 token（无 workflow 字段）调用返回未授权错误', async () => {
      await expect(callWorkflowTool(undefined, 'getCurrentNodeId', {})).rejects.toSatisfy(
        expectToolError('UNAUTHORIZED'),
      );
      expect(WorkflowInstance.findById).not.toHaveBeenCalled();
    });

    it('实例不存在或不属于 token 用户时拒绝', async () => {
      loadInstance(makeInstance({ userId: oid('other-user') }));
      await expect(callWorkflowTool(SCOPE, 'getCurrentNodeId', {})).rejects.toSatisfy(
        expectToolError('NOT_FOUND'),
      );
    });

    it('scope.nodeId 不在实例中时拒绝', async () => {
      loadInstance();
      await expect(
        callWorkflowTool({ ...SCOPE, nodeId: 'ghost' }, 'getCurrentNodeId', {}),
      ).rejects.toSatisfy(expectToolError('NODE_NOT_FOUND'));
    });
  });

  describe('信息获取类', () => {
    it('getCurrentNodeId 返回当前节点 ID', async () => {
      loadInstance();
      await expect(callWorkflowTool(SCOPE, 'getCurrentNodeId', {})).resolves.toEqual({ nodeId: 'n2' });
    });

    it('getParentNodeIds 返回父节点 ID 列表', async () => {
      loadInstance();
      await expect(callWorkflowTool(SCOPE, 'getParentNodeIds', {})).resolves.toEqual({
        parentNodeIds: ['n1'],
      });
    });

    it('getNodeInfo 默认返回当前节点信息，可指定任意节点', async () => {
      loadInstance();
      const current = (await callWorkflowTool(SCOPE, 'getNodeInfo', {})) as Record<string, unknown>;
      expect(current).toMatchObject({
        nodeId: 'n2',
        nodeKey: 'design',
        type: 'AI',
        name: '技术方案',
        status: 'RUNNING',
        reworkCount: 1,
        sessionId: 'sess-2',
      });

      const upstream = (await callWorkflowTool(SCOPE, 'getNodeInfo', { nodeId: 'n1' })) as Record<string, unknown>;
      expect(upstream).toMatchObject({ nodeId: 'n1', type: 'HUMAN', status: 'DONE' });
    });

    it('getNodeInfo 节点不存在时拒绝', async () => {
      loadInstance();
      await expect(callWorkflowTool(SCOPE, 'getNodeInfo', { nodeId: 'ghost' })).rejects.toSatisfy(
        expectToolError('NODE_NOT_FOUND'),
      );
    });

    it('getNodeArtifactKeys 前缀匹配该节点产物 keys', async () => {
      loadInstance();
      await expect(callWorkflowTool(SCOPE, 'getNodeArtifactKeys', { nodeId: 'n1' })).resolves.toEqual({
        keys: ['n1-产品需求-产物-输入'],
      });
      // 默认当前节点
      await expect(callWorkflowTool(SCOPE, 'getNodeArtifactKeys', {})).resolves.toEqual({
        keys: ['n2-技术方案-产物-技术方案文档'],
      });
    });

    it('getBlackboardKeys 全量 keys，支持 prefix 过滤', async () => {
      loadInstance();
      const all = (await callWorkflowTool(SCOPE, 'getBlackboardKeys', {})) as { keys: string[] };
      expect(all.keys).toHaveLength(3);
      await expect(callWorkflowTool(SCOPE, 'getBlackboardKeys', { prefix: 'n1-' })).resolves.toEqual({
        keys: ['n1-产品需求-产物-输入'],
      });
    });

    it('getBlackboardValue 按 key 读取；不存在时给出 KEY_NOT_FOUND', async () => {
      loadInstance();
      await expect(
        callWorkflowTool(SCOPE, 'getBlackboardValue', { key: 'n1-产品需求-产物-输入' }),
      ).resolves.toEqual({ key: 'n1-产品需求-产物-输入', value: '做一个工作流功能' });
      await expect(callWorkflowTool(SCOPE, 'getBlackboardValue', { key: '不存在' })).rejects.toSatisfy(
        expectToolError('KEY_NOT_FOUND'),
      );
      await expect(callWorkflowTool(SCOPE, 'getBlackboardValue', {})).rejects.toSatisfy(
        expectToolError('INVALID_PARAMS'),
      );
    });

    it('removeBlackboardKey 移除后黑板无、垃圾桶有', async () => {
      const instance = loadInstance();
      await expect(
        callWorkflowTool(SCOPE, 'removeBlackboardKey', { key: 'n1-产品需求-产物-输入' }),
      ).resolves.toEqual({ removed: true, key: 'n1-产品需求-产物-输入' });
      expect(instance.blackboard.has('n1-产品需求-产物-输入')).toBe(false);
      expect(instance.blackboardTrash.get('n1-产品需求-产物-输入')).toBe('做一个工作流功能');
    });
  });

  describe('节点操作类', () => {
    it('completeCurrentNode 走引擎 complete 转移并写入产物', async () => {
      loadInstance();
      vi.mocked(workflowEngine.transition).mockResolvedValue({ nodeId: 'n2', status: 'DONE' } as never);

      const result = await callWorkflowTool(SCOPE, 'completeCurrentNode', {
        artifacts: [{ title: '技术方案文档', value: '方案内容' }],
      });

      expect(workflowEngine.transition).toHaveBeenCalledWith('inst-1', 'n2', 'complete', {
        artifacts: [{ title: '技术方案文档', value: '方案内容' }],
      });
      expect(result).toMatchObject({ nodeId: 'n2', status: 'DONE' });
    });

    it('completeCurrentNode 参数校验：artifacts 可选，但提供时必须是 {title, value} 数组', async () => {
      loadInstance();
      vi.mocked(workflowEngine.transition).mockResolvedValue({ nodeId: 'n2', status: 'DONE' } as never);

      // artifacts 缺省允许（无产物的节点，如代码合并）
      await callWorkflowTool(SCOPE, 'completeCurrentNode', {});
      expect(workflowEngine.transition).toHaveBeenCalledWith('inst-1', 'n2', 'complete', { artifacts: [] });

      await expect(
        callWorkflowTool(SCOPE, 'completeCurrentNode', { artifacts: [{ title: 'x' }] }),
      ).rejects.toSatisfy(expectToolError('INVALID_PARAMS'));
    });

    it('rejectCurrentNode 走引擎 reject 转移，fromNodeId 为当前节点', async () => {
      loadInstance();
      vi.mocked(workflowEngine.transition).mockResolvedValue({ status: 'REJECT' } as never);

      await callWorkflowTool(SCOPE, 'rejectCurrentNode', { reason: '方案不完整' });

      expect(workflowEngine.transition).toHaveBeenCalledWith('inst-1', 'n2', 'reject', {
        reason: '方案不完整',
        fromNodeId: 'n2',
        targetNodeIds: undefined,
      });
    });

    it('rejectCurrentNode 支持 targetNodeId 限定返工上游，且必须是直接上游', async () => {
      loadInstance();
      vi.mocked(workflowEngine.transition).mockResolvedValue({ status: 'REJECT' } as never);

      await callWorkflowTool(SCOPE, 'rejectCurrentNode', { reason: 'r', targetNodeId: 'n1' });
      expect(workflowEngine.transition).toHaveBeenCalledWith('inst-1', 'n2', 'reject', {
        reason: 'r',
        fromNodeId: 'n2',
        targetNodeIds: ['n1'],
      });

      await expect(
        callWorkflowTool(SCOPE, 'rejectCurrentNode', { reason: 'r', targetNodeId: 'n9' }),
      ).rejects.toSatisfy(expectToolError('INVALID_PARAMS'));
      await expect(callWorkflowTool(SCOPE, 'rejectCurrentNode', {})).rejects.toSatisfy(
        expectToolError('INVALID_PARAMS'),
      );
    });

    it('completeCurrentRework 走引擎 completeRework 转移', async () => {
      loadInstance();
      vi.mocked(workflowEngine.transition).mockResolvedValue({ status: 'DONE' } as never);

      await callWorkflowTool(SCOPE, 'completeCurrentRework', {
        artifacts: [{ title: '技术方案文档', value: '修订版' }],
      });

      expect(workflowEngine.transition).toHaveBeenCalledWith('inst-1', 'n2', 'completeRework', {
        artifacts: [{ title: '技术方案文档', value: '修订版' }],
      });
    });

    it('非法状态转移时返回 INVALID_STATE 且 message 可读', async () => {
      loadInstance();
      vi.mocked(workflowEngine.transition).mockRejectedValue(
        new Error('节点「技术方案」当前状态为 READY，不允许执行「完成」（complete）'),
      );

      await expect(
        callWorkflowTool(SCOPE, 'completeCurrentNode', { artifacts: [{ title: 't', value: 'v' }] }),
      ).rejects.toSatisfy((err: unknown) => {
        expect((err as WorkflowToolError).code).toBe('INVALID_STATE');
        expect((err as WorkflowToolError).message).toContain('不允许');
        return true;
      });
    });

    it('未知工具名返回 UNKNOWN_TOOL', async () => {
      loadInstance();
      await expect(callWorkflowTool(SCOPE, 'hackThePlanet', {})).rejects.toSatisfy(
        expectToolError('UNKNOWN_TOOL'),
      );
    });
  });
});
