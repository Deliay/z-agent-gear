import mongoose from 'mongoose';
import { WorkflowInstance } from '../../models/workflow-instance.js';
import { ConfiguredWorkflow } from '../../models/configured-workflow.js';
import { ControllerWorkspace } from '../../models/controller-workspace.js';
import { Controller } from '../../models/controller.js';
import { Session } from '../../models/session.js';
import { sessionService } from '../session.js';
import { workflowEngine } from './engine.js';
import { validateTemplateGraph } from './template.js';
import { validateAgentConfigs } from './configured.js';
import { getRedisClient } from '../../middleware/redis.js';
import { getAvailableServerTypes } from './capability.js';
import { sanitizeWorkspaceName, generateWorktreeSuffix, resolveEffectiveWorktreeDir } from './worktree-utils.js';

export type InstantiateSource = 'CONFIGURED' | 'TEMPLATE' | 'BLANK';

export interface InstantiateNodeInput {
  nodeKey: string;
  type?: 'HUMAN' | 'AI' | 'FLAG';
  name?: string;
  description?: string | null;
  stage?: string;
  prompts?: string[] | null;
  artifactTitles?: string[] | null;
  dependsOn?: string[];
  requiresWorktree?: boolean;
  agentConfig?: {
    acpServerType: string;
    modeId?: string | null;
    modelId?: string | null;
    initNewWorktree: boolean;
  } | null;
  sortOrder?: number | null;
}

export interface InstantiateWorkflowInput {
  source: InstantiateSource;
  configuredWorkflowId?: string | null;
  templateId?: string | null;
  controllerId: string;
  workspaceId: string;
  name: string;
  nodes: InstantiateNodeInput[];
  createWorkflowWorktree?: boolean | null;
}

/** 工作流实例服务：统一实例化入口 + 实例节点编辑 + 人类节点操作。 */
class WorkflowInstanceService {
  /**
   * 实例列表：workspaceId / controllerId 均可选，二者同传取交集，都不传 = 当前用户全部实例；
   * 默认仅活跃（未归档）；archived=true 仅已归档。
   */
  async list(
    userId: string,
    options: { workspaceId?: string | null; controllerId?: string | null; archived?: boolean } = {},
  ) {
    const filter: Record<string, unknown> = {
      userId,
      deletedAt: null,
      archivedAt: options.archived ? { $ne: null } : null,
    };
    if (options.workspaceId) filter.workspaceId = options.workspaceId;
    if (options.controllerId) filter.controllerId = options.controllerId;
    return WorkflowInstance.find(filter)
      .sort({ createdAt: -1 })
      .lean();
  }

  /** 兼容旧调用：按工作区列举（委托 list，语义不变） */
  async listForWorkspace(userId: string, workspaceId: string, archived = false) {
    return this.list(userId, { workspaceId, archived });
  }

  async findById(id: string, userId: string) {
    return WorkflowInstance.findOne({ _id: id, userId, deletedAt: null }).lean();
  }

  /** 将节点图归一化为完整结构（补默认值，供图校验与快照落库） */
  private normalizeNodes(nodes: InstantiateNodeInput[]) {
    return nodes.map((n) => ({
      nodeKey: n.nodeKey,
      type: n.type ?? 'AI',
      name: n.name ?? n.nodeKey,
      description: n.description ?? null,
      stage: n.stage ?? '默认阶段',
      prompts: n.prompts ? [...n.prompts] : undefined,
      artifactTitles: n.artifactTitles ? [...n.artifactTitles] : undefined,
      dependsOn: [...(n.dependsOn ?? [])],
      requiresWorktree: n.requiresWorktree ?? false,
      agentConfig: n.agentConfig ? { ...n.agentConfig } : null,
      sortOrder: n.sortOrder ?? undefined,
    }));
  }

  /**
   * 统一实例化：三来源（CONFIGURED/TEMPLATE/BLANK）仅决定节点图初值，
   * 服务端始终以 input.nodes 提交图为准校验并快照落库。
   * 校验：controller/workspace 归属、完整图校验 + agentConfig 校验、requiresWorktree git 校验。
   */
  async instantiate(userId: string, input: InstantiateWorkflowInput) {
    // 1. 三来源必填校验
    if (input.source === 'CONFIGURED' && !input.configuredWorkflowId) {
      throw new Error('来源为已配置工作流时必须提供 configuredWorkflowId');
    }
    if (input.source === 'TEMPLATE' && !input.templateId) {
      throw new Error('来源为模板时必须提供 templateId');
    }

    // 2. controller/workspace 归属校验
    const workspace = await ControllerWorkspace.findOne({
      _id: input.workspaceId,
      userId,
      controllerId: input.controllerId,
    }).lean();
    if (!workspace) {
      throw new Error('工作区不存在、无权限或不属于该控制器');
    }
    const availableServerTypes = await getAvailableServerTypes(input.controllerId, userId);

    // 3. 完整图校验 + agentConfig 校验（以提交图为准）
    const fullNodes = this.normalizeNodes(input.nodes);
    validateTemplateGraph(fullNodes as never);
    validateAgentConfigs(fullNodes as unknown as Parameters<typeof validateAgentConfigs>[0], availableServerTypes);

    // 4. requiresWorktree git 校验
    const needsWorktree = fullNodes.some((n) => n.requiresWorktree && n.agentConfig?.initNewWorktree);
    if (needsWorktree && !workspace.defaultBranch) {
      throw new Error(
        '该工作流包含需要 Worktree 隔离的节点，但工作区不是 Git 仓库（未设置默认分支），无法实例化',
      );
    }

    // 5. 创建工作流 Worktree（如果启用）
    let workflowWorktreePath: string | undefined;
    let workflowWorktreeBranch: string | undefined;
    if (input.createWorkflowWorktree && workspace.defaultBranch) {
      const result = await this.createWorkflowWorktree(
        input.controllerId,
        {
          _id: workspace._id.toString(),
          name: workspace.name,
          path: workspace.path,
          defaultBranch: workspace.defaultBranch,
        },
        input.name,
      );
      workflowWorktreePath = result.path;
      workflowWorktreeBranch = result.branch;
    }

    // 6. 节点全量快照落库（nodeKey → nodeId 映射，dependsOn 改写为 nodeId 引用）
    const nodeIdByKey = new Map(fullNodes.map((n) => [n.nodeKey, new mongoose.Types.ObjectId().toString()]));
    const nodes = fullNodes.map((n) => ({
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
      // 实例快照字段
      prompts: n.prompts ? [...n.prompts] : undefined,
      artifactTitles: n.artifactTitles ? [...n.artifactTitles] : undefined,
      agentConfig: n.agentConfig ? { ...n.agentConfig } : undefined,
      requiresWorktree: n.requiresWorktree,
      sortOrder: n.sortOrder,
    }));
    // 首节点（入度为 0 的人类节点）READY
    const first = nodes.find((n) => n.dependsOn.length === 0);
    if (first) {
      first.status = 'READY';
    }

    try {
      return await WorkflowInstance.create({
        userId,
        controllerId: input.controllerId,
        workspaceId: input.workspaceId,
        configuredWorkflowId: input.source === 'CONFIGURED' ? input.configuredWorkflowId : null,
        name: input.name,
        nodes,
        currentNodeNames: [],
        lastNodeName: first?.name ?? null,
        lastNodeStatus: first ? 'READY' : null,
        workflowWorktreePath,
        workflowWorktreeBranch,
      });
    } catch (err) {
      // 如果创建实例失败且已创建 Worktree，回滚 Worktree
      if (workflowWorktreePath) {
        try {
          await this.removeWorkflowWorktree(
            input.controllerId,
            workspace.path,
            workflowWorktreePath,
            workflowWorktreeBranch,
          );
        } catch (rollbackErr) {
          console.error('回滚 Worktree 失败:', rollbackErr);
        }
      }
      throw err;
    }
  }

  /** 创建工作流 Worktree：通过 Redis 发送 git:worktree:add 命令到控制器，使用随机后缀天然去重 */
  private async createWorkflowWorktree(
    controllerId: string,
    workspace: { _id: string; name: string; path: string; defaultBranch?: string },
    workflowName: string,
  ): Promise<{ path: string; branch: string }> {
    const redis = getRedisClient();
    
    // 查询控制器获取 worktreeDir 配置（生效目录解析：已配置用配置值，未配置回退默认值，与校验端同源）
    const controller = await Controller.findOne({ _id: controllerId }).lean();
    const worktreeDir = resolveEffectiveWorktreeDir(controller as { worktreeDir?: string | null } | null);
    
    // slug 化处理：纯中文名会产生空串，使用兜底值
    const slug = workflowName
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50)
      || `wf-${Date.now().toString(36)}`;
    
    // 使用共享 sanitize 函数，确保与 session.ts 校验前缀一致
    const safeWorkspaceName = sanitizeWorkspaceName(workspace.name);
    
    // 使用随机后缀天然去重，避免多实例并发碰撞
    const uniqueSuffix = generateWorktreeSuffix();
    const branch = `workflow/${slug}-${uniqueSuffix}`;
    const wtPath = `${worktreeDir}/${safeWorkspaceName}/workflow-${slug}-${uniqueSuffix}`;

    const requestId = `wt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await redis.publish(
      'session:command',
      JSON.stringify({
        type: 'git:worktree:add',
        requestId,
        controllerId,
        repoPath: workspace.path,
        worktreePath: wtPath,
        branch,
      }),
    );

    // 等待控制器响应（最多 30 秒）
    for (let i = 0; i < 30; i++) {
      const result = await redis.get(`git:worktree:add:${requestId}`);
      if (result) {
        const parsed = JSON.parse(result);
        await redis.del(`git:worktree:add:${requestId}`);
        
        if (!parsed.success) {
          throw new Error(`创建工作流 Worktree 失败: ${parsed.error}`);
        }
        
        return {
          path: parsed.worktreePath || wtPath,
          branch,
        };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('创建工作流 Worktree 超时');
  }

  /**
   * 修改未开始的实例节点（原子条件更新）。
   * 条件：节点 status ∈ [INITIALIZING,READY] 且 startedAt=null（从未开始过）。
   * 旧实例节点（无快照字段）先按回查补齐快照再应用修改。
   * 未匹配时二次查询区分「节点不存在」与「已开始」。
   */
  async updateNode(userId: string, instanceId: string, nodeId: string, input: {
    name?: string | null;
    description?: string | null;
    stage?: string;
    prompts?: string[] | null;
    artifactTitles?: string[] | null;
    requiresWorktree?: boolean;
    agentConfig?: { acpServerType: string; modeId?: string | null; modelId?: string | null; initNewWorktree: boolean } | null;
    sortOrder?: number | null;
  }) {
    const instance = await WorkflowInstance.findOne({ _id: instanceId, userId, deletedAt: null }).lean();
    if (!instance) {
      throw new Error('工作流实例不存在或无权限');
    }
    const node = instance.nodes.find((n) => n.nodeId === nodeId);
    if (!node) {
      throw new Error(`工作流实例中不存在节点：${nodeId}`);
    }

    // 快照字段存在的节点可直接原子更新；旧实例节点先补齐快照再更新
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch['nodes.$[n].name'] = input.name;
    if (input.description !== undefined) patch['nodes.$[n].description'] = input.description;
    if (input.stage !== undefined) patch['nodes.$[n].stage'] = input.stage;
    if (input.requiresWorktree !== undefined) patch['nodes.$[n].requiresWorktree'] = input.requiresWorktree;
    if (input.prompts !== undefined) patch['nodes.$[n].prompts'] = input.prompts ?? null;
    if (input.artifactTitles !== undefined) patch['nodes.$[n].artifactTitles'] = input.artifactTitles ?? null;
    if (input.agentConfig !== undefined) patch['nodes.$[n].agentConfig'] = input.agentConfig ?? null;
    if (input.sortOrder !== undefined) patch['nodes.$[n].sortOrder'] = input.sortOrder ?? null;

    // 若该节点是旧实例（无快照字段），先补齐快照（回查已配置工作流）
    if (node.prompts === undefined && node.agentConfig === undefined) {
      await this.backfillSnapshotFromConfigured(
        instance as unknown as Record<string, unknown>,
        node as unknown as Record<string, unknown>,
      );
    }

    const updated = await WorkflowInstance.findOneAndUpdate(
      {
        _id: instanceId,
        deletedAt: null,
        nodes: {
          $elemMatch: {
            nodeId,
            status: { $in: ['INITIALIZING', 'READY'] },
            startedAt: null,
          },
        },
      },
      { $set: patch },
      {
        arrayFilters: [{ 'n.nodeId': nodeId }],
        new: true,
      },
    ).lean();

    if (!updated) {
      // 二次查询区分原因
      const cur = await WorkflowInstance.findOne({ _id: instanceId, userId, deletedAt: null }).lean();
      const curNode = cur?.nodes.find((n) => n.nodeId === nodeId);
      if (!curNode) {
        throw new Error(`工作流实例中不存在节点：${nodeId}`);
      }
      throw new Error(`节点「${curNode.name}」已开始，不可修改（仅从未开始过的节点可编辑）`);
    }

    const updatedNode = updated.nodes.find((n) => n.nodeId === nodeId)!;
    // 使节点缓存失效
    const redis = getRedisClient();
    await redis.del(`workflow:instance:${instanceId}`);
    return { instance: updated, node: updatedNode };
  }

  /** 旧实例节点：按 nodeKey 回查已配置工作流补齐快照字段（仅用于旧实例兼容） */
  private async backfillSnapshotFromConfigured(instance: Record<string, unknown>, node: Record<string, unknown>) {
    const configured = await ConfiguredWorkflow.findById(instance.configuredWorkflowId as string).lean();
    if (!configured) {
      throw new Error(`实例引用的已配置工作流不存在：${String(instance.configuredWorkflowId)}`);
    }
    const configuredNode = (configured.nodes as { nodeKey: string; prompts?: string[] | null; artifactTitles?: string[] | null; agentConfig?: unknown; requiresWorktree?: boolean }[]).find(
      (n) => n.nodeKey === node.nodeKey,
    );
    if (!configuredNode) {
      throw new Error(`旧实例引用的配置已变更：节点「${String(node.name)}」（${String(node.nodeKey)}）已不存在`);
    }
    const fill: Record<string, unknown> = {};
    fill['nodes.$[n].prompts'] = configuredNode.prompts ? [...configuredNode.prompts] : null;
    fill['nodes.$[n].artifactTitles'] = configuredNode.artifactTitles ? [...configuredNode.artifactTitles] : null;
    fill['nodes.$[n].requiresWorktree'] = configuredNode.requiresWorktree ?? false;
    fill['nodes.$[n].agentConfig'] = configuredNode.agentConfig ?? null;
    await WorkflowInstance.updateOne(
      { _id: instance._id },
      { $set: fill },
      { arrayFilters: [{ 'n.nodeId': node.nodeId }] },
    );
  }

  /** 人类节点完成：READY→RUNNING→DONE（已 RUNNING 时直接完成），input 作为产物写入黑板；
   *  REWORK（被 AI 打回）时走 completeRework 重新提交：重置旧产物入垃圾桶、复工下游 REJECT 节点 */
  async completeHumanNode(userId: string, instanceId: string, nodeId: string, input?: string | null) {
    const instance = await WorkflowInstance.findOne({ _id: instanceId, userId, deletedAt: null }).lean();
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
    // REWORK：被下游打回后重新提交，走 completeRework（重置产物 + 复工下游）
    if (node.status === 'REWORK') {
      return workflowEngine.transition(instanceId, nodeId, 'completeRework', {
        artifacts: input ? [{ title: '输入', value: input }] : [],
      });
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

  /** 人类打回：RUNNING/REWORK→REJECT 并触发上游 REWORK（引擎校验） */
  async rejectNode(userId: string, instanceId: string, nodeId: string, reason: string) {
    const instance = await WorkflowInstance.findOne({ _id: instanceId, userId, deletedAt: null }).lean();
    if (!instance) {
      throw new Error('工作流实例不存在或无权限');
    }
    return workflowEngine.transition(instanceId, nodeId, 'reject', { reason, fromNodeId: null });
  }

  /** 重启节点：RUNNING/REWORK/FAILED 会话失败或卡住时人工触发，关闭旧会话拉起全新会话（引擎校验） */
  async restartNode(
    userId: string,
    instanceId: string,
    nodeId: string,
    agentConfig?: { acpServerType: string; modeId?: string | null; modelId?: string | null; initNewWorktree: boolean } | null,
  ) {
    const instance = await WorkflowInstance.findOne({ _id: instanceId, userId, deletedAt: null }).lean();
    if (!instance) {
      throw new Error('工作流实例不存在或无权限');
    }

    const node = instance.nodes.find((n) => n.nodeId === nodeId);
    if (!node) {
      throw new Error(`工作流实例中不存在节点：${nodeId}`);
    }

    // HUMAN/FLAG 节点无会话，不接受 agentConfig（忽略传入值，避免写入无意义的快照）
    if (node.type !== 'AI') {
      agentConfig = undefined;
    }

    // 如果提供了 agentConfig，校验其 acpServerType 是否在控制器可用能力内
    if (agentConfig) {
      const availableServerTypes = await getAvailableServerTypes(instance.controllerId.toString(), userId);
      if (!availableServerTypes.includes(agentConfig.acpServerType)) {
        throw new Error(`控制器不支持该 Harness 类型: ${agentConfig.acpServerType}`);
      }
    }

    return workflowEngine.transition(instanceId, nodeId, 'restart', { agentConfig });
  }

  /** 归档/取消归档实例：仅分组展示差异，不影响流程运转与节点会话 */
  async setArchived(userId: string, id: string, archived: boolean) {
    const instance = await WorkflowInstance.findOne({ _id: id, userId, deletedAt: null }).lean();
    if (!instance) {
      throw new Error('工作流实例不存在或无权限');
    }
    await WorkflowInstance.updateOne(
      { _id: id },
      { $set: { archivedAt: archived ? new Date() : null } },
    );
    return true;
  }

  /**
   * 删除实例（软删除）：停止流程运转、删除流程下全部会话，实例数据保留（仅标记 deletedAt）。
   * 先标记 deletedAt 使引擎/orchestrator 兜底立即排除本实例，再逐个删除节点会话，避免竞态。
   * 如果实例有工作流 Worktree，一并清理；清理失败时标记 worktreeCleanupFailed 供后续孤儿回收。
   */
  async deleteInstance(userId: string, id: string) {
    const instance = await WorkflowInstance.findOne({ _id: id, userId, deletedAt: null }).lean();
    if (!instance) {
      throw new Error('工作流实例不存在或无权限');
    }
    await WorkflowInstance.updateOne({ _id: id }, { $set: { deletedAt: new Date() } });
    // 删除流程下全部会话（停止 ACP 会话、清理 worktree 与消息记录）
    const sessions = await Session.find({ workflowInstanceId: id }).select('_id').lean();
    for (const session of sessions) {
      try {
        await sessionService.delete(session._id.toString(), userId, { skipAckWait: true });
      } catch (err) {
        console.error(`删除工作流实例「${instance.name}」的会话失败（${session._id}）：`, err);
      }
    }
    // 清理工作流 Worktree（如果存在）
    if (instance.workflowWorktreePath) {
      try {
        // 查询工作区路径作为 repoPath
        const workspace = await ControllerWorkspace.findOne({ _id: instance.workspaceId }).lean();
        if (workspace) {
          await this.removeWorkflowWorktree(
            instance.controllerId.toString(),
            workspace.path,
            instance.workflowWorktreePath,
            instance.workflowWorktreeBranch ?? undefined,
          );
        }
      } catch (err) {
        console.error(`删除工作流实例「${instance.name}」的 Worktree 失败:`, err);
        // 标记清理失败，便于后续孤儿 Worktree 回收
        await WorkflowInstance.updateOne(
          { _id: id },
          { $set: { worktreeCleanupFailed: true } },
        );
      }
    }
    return true;
  }

  /** 清理工作流 Worktree：通过 Redis 发送 git:worktree:remove 命令到控制器，失败/超时抛错 */
  private async removeWorkflowWorktree(
    controllerId: string,
    repoPath: string,
    worktreePath: string,
    worktreeBranch?: string,
  ): Promise<void> {
    const redis = getRedisClient();
    const requestId = `wtr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await redis.publish(
      'session:command',
      JSON.stringify({
        type: 'git:worktree:remove',
        requestId,
        controllerId,
        repoPath,
        worktreePath,
        branch: worktreeBranch,
      }),
    );
    // 等待控制器响应（最多 10 秒）
    for (let i = 0; i < 10; i++) {
      const result = await redis.get(`git:worktree:remove:${requestId}`);
      if (result) {
        const parsed = JSON.parse(result);
        await redis.del(`git:worktree:remove:${requestId}`);
        if (!parsed.success) {
          throw new Error(`清理 Worktree 失败: ${parsed.error}`);
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('清理 Worktree 超时');
  }
}

export const workflowInstanceService = new WorkflowInstanceService();
