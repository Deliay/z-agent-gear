import mongoose from 'mongoose';
import { WorkflowInstance } from '../../models/workflow-instance.js';
import { ConfiguredWorkflow } from '../../models/configured-workflow.js';
import { ControllerWorkspace } from '../../models/controller-workspace.js';
import { workflowEngine } from './engine.js';

/**
 * 工作流实例服务：实例化入口 + 人类节点操作。
 * 状态转移一律走 WorkflowEngine.transition（唯一入口）。
 */
class WorkflowInstanceService {
  async listForWorkspace(userId: string, workspaceId: string) {
    return WorkflowInstance.find({ userId, workspaceId }).sort({ createdAt: -1 }).lean();
  }

  async findById(id: string, userId: string) {
    return WorkflowInstance.findOne({ _id: id, userId }).lean();
  }

  /**
   * 实例化：校验 → 创建实例（全部 INITIALIZING，首节点 READY）。
   * 校验：已配置工作流归属、工作区归属、requiresWorktree 节点要求工作区为 git 仓库（已设置默认分支）。
   */
  async instantiate(userId: string, configuredWorkflowId: string, workspaceId: string, name: string) {
    const configured = await ConfiguredWorkflow.findOne({ _id: configuredWorkflowId, userId }).lean();
    if (!configured) {
      throw new Error('已配置工作流不存在或无权限');
    }
    const workspace = await ControllerWorkspace.findOne({
      _id: workspaceId,
      userId,
      controllerId: configured.controllerId,
    }).lean();
    if (!workspace) {
      throw new Error('工作区不存在、无权限或不属于该控制器');
    }

    const needsWorktree = configured.nodes.some(
      (n) => n.requiresWorktree && n.agentConfig?.initNewWorktree,
    );
    if (needsWorktree && !workspace.defaultBranch) {
      throw new Error(
        '该工作流包含需要 Worktree 隔离的节点，但工作区不是 Git 仓库（未设置默认分支），无法实例化',
      );
    }

    // nodeKey → 实例节点 nodeId 映射，dependsOn 同步改写为 nodeId 引用
    const nodeIdByKey = new Map(
      configured.nodes.map((n) => [n.nodeKey, new mongoose.Types.ObjectId().toString()]),
    );
    const nodes = configured.nodes.map((n) => ({
      nodeId: nodeIdByKey.get(n.nodeKey)!,
      nodeKey: n.nodeKey,
      type: n.type,
      name: n.name,
      description: n.description ?? undefined,
      stage: n.stage,
      status: 'INITIALIZING',
      dependsOn: (n.dependsOn ?? []).map((key) => nodeIdByKey.get(key)!),
      createdAt: new Date(),
      reworkCount: 0,
    }));
    // 首节点（入度为 0 的人类节点）READY
    const first = nodes.find((n) => n.dependsOn.length === 0);
    if (first) {
      first.status = 'READY';
    }

    return WorkflowInstance.create({
      userId,
      controllerId: configured.controllerId,
      workspaceId,
      configuredWorkflowId,
      name,
      nodes,
      currentNodeNames: [],
    });
  }

  /** 人类节点完成：READY→RUNNING→DONE（已 RUNNING 时直接完成），input 作为产物写入黑板 */
  async completeHumanNode(userId: string, instanceId: string, nodeId: string, input?: string | null) {
    const instance = await WorkflowInstance.findOne({ _id: instanceId, userId }).lean();
    if (!instance) {
      throw new Error('工作流实例不存在或无权限');
    }
    const node = instance.nodes.find((n) => n.nodeId === nodeId);
    if (!node) {
      throw new Error(`工作流实例中不存在节点：${nodeId}`);
    }
    if (node.type !== 'HUMAN') {
      throw new Error(`节点「${node.name}」不是人类节点，不能人工完成`);
    }
    // 下游人类节点在上游全部 DONE 时会被引擎自动激活为 RUNNING（「待人工处理」），
    // 此时无需补 start；READY 时才需要 start→complete 组合。其余非法状态由 complete 转移报错。
    if (node.status === 'READY') {
      await workflowEngine.transition(instanceId, nodeId, 'start', {});
    }
    return workflowEngine.transition(instanceId, nodeId, 'complete', {
      artifacts: input ? [{ title: '输入', value: input }] : [],
    });
  }

  /** 人类打回：RUNNING→REJECT 并触发上游 REWORK（引擎校验） */
  async rejectNode(userId: string, instanceId: string, nodeId: string, reason: string) {
    const instance = await WorkflowInstance.findOne({ _id: instanceId, userId }).lean();
    if (!instance) {
      throw new Error('工作流实例不存在或无权限');
    }
    return workflowEngine.transition(instanceId, nodeId, 'reject', { reason, fromNodeId: null });
  }
}

export const workflowInstanceService = new WorkflowInstanceService();
