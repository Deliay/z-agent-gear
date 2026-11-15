import { WorkflowInstance, type IWorkflowInstance } from '../../models/workflow-instance.js';
import { ControllerWorkspace } from '../../models/controller-workspace.js';
import { logger as rootLogger } from '../../observability/logger.js';
import { getAvailableServerTypes } from './capability.js';
import { getWorkspaceContext, actorFilter } from '../workspace-context.js';
import { resolveWorkspaceDefaultBranch } from '../workspace-default-branch.js';
import { createWorkflowWorktree, removeWorkflowWorktree } from './workflow-worktree.js';
import { invalidateWorkflowInstanceCache } from './instance.js';
import { workflowEngine } from './engine.js';
import { resolveInstanceUnavailableReason, loadControllerStatus } from './unavailable.js';
import type { ResolvedWorktreeCommitter } from '../commit-settings-service.js';

const logger = rootLogger.child({ component: 'workflow-continuation' });

export interface NodeHarnessMapping {
  nodeId: string;
  acpServerType: string;
}

export interface ContinueWorkflowInstanceInput {
  controllerId: string;
  workspaceId: string;
  /** 缺省 true */
  createWorkflowWorktree?: boolean | null;
  harnessMappings: NodeHarnessMapping[];
}

export const CONTINUATION_MESSAGES = {
  notFound: '工作流实例不存在或无权限',
  deleted: '工作流实例已删除',
  finished: '工作流实例已完成，无需接续',
  available: '工作流实例当前可用，无需接续',
  workspaceInvalid: '工作区不存在、无权限或不属于该控制器',
  mappingsNotExact: 'Harness 映射必须恰好覆盖全部未完成 AI 节点',
  mappingInvalidNode: (name: string) => `Harness 映射包含非 AI 或已完成节点：${name}`,
  harnessUnsupported: (type: string) => `控制器不支持该 Harness 类型: ${type}`,
  notGitRepo: '该工作区不是 Git 仓库（未设置默认分支），无法创建 Worktree',
  concurrent: '实例已被并发接续或状态已变化，请刷新后重试',
  nodeFailedReason: '控制器不可用，工作流已接续到新环境，请重启节点继续执行',
} as const;

function isUnfinishedAiNode(node: { type?: string; status?: string }): boolean {
  return node.type === 'AI' && node.status !== 'DONE';
}

/** 从实例快照还原 Worktree 提交人（换绑不换身份；两者皆空 = 不下发，沿用容器级 bot） */
function resolveCommitterSnapshot(instance: {
  worktreeCommitterName?: string | null;
  worktreeCommitterEmail?: string | null;
  worktreeCoAuthorName?: string | null;
  worktreeCoAuthorEmail?: string | null;
}): ResolvedWorktreeCommitter | null {
  if (!instance.worktreeCommitterName || !instance.worktreeCommitterEmail) return null;
  const committer: ResolvedWorktreeCommitter = {
    name: instance.worktreeCommitterName,
    email: instance.worktreeCommitterEmail,
  };
  if (instance.worktreeCoAuthorName && instance.worktreeCoAuthorEmail) {
    committer.coAuthorName = instance.worktreeCoAuthorName;
    committer.coAuthorEmail = instance.worktreeCoAuthorEmail;
  }
  return committer;
}

/**
 * 已实例化工作流接续：
 * 校验（状态门/不可用门/目标控制器与工作区/逐节点映射恰好覆盖）→ 可选创建新 Worktree →
 * 字段级 CAS 换绑（含 Harness 逐节点改写、清未完成节点 sessionId、追加接续历史）→
 * RUNNING/REWORK AI 节点经引擎收敛 FAILED(CONTROLLER_UNAVAILABLE) → 缓存失效。
 *
 * 任一前置校验失败即整体拒绝，实例零改动。
 */
export async function continueWorkflowInstance(
  userId: string,
  instanceId: string,
  input: ContinueWorkflowInstanceInput,
): Promise<IWorkflowInstance> {
  // 1. 读取与状态门（不过滤 deletedAt，区分「不存在」与「已删除」）
  const instance = await WorkflowInstance.findOne({ _id: instanceId, ...actorFilter(userId) }).lean();
  if (!instance) {
    throw new Error(CONTINUATION_MESSAGES.notFound);
  }
  if (instance.deletedAt) {
    throw new Error(CONTINUATION_MESSAGES.deleted);
  }
  if (instance.finishedAt) {
    throw new Error(CONTINUATION_MESSAGES.finished);
  }

  // 2. 不可用门：当前实例必须不可用，否则无需接续
  const unavailableReason = await resolveInstanceUnavailableReason(instance, loadControllerStatus);
  if (!unavailableReason) {
    throw new Error(CONTINUATION_MESSAGES.available);
  }

  // 3. 目标控制器：归属 + 在线 + 能力清单（一站式校验，离线/不归属文案原样冒泡）
  const availableServerTypes = await getAvailableServerTypes(input.controllerId, userId);

  // 4. 目标工作区：必须归属目标控制器（项目工作区跟随控制器可见性，团队成员可复用）
  const workspace = await ControllerWorkspace.findOne(
    getWorkspaceContext()
      ? { _id: input.workspaceId, controllerId: input.controllerId }
      : { _id: input.workspaceId, userId, controllerId: input.controllerId },
  ).lean();
  if (!workspace) {
    throw new Error(CONTINUATION_MESSAGES.workspaceInvalid);
  }

  // 5. Harness 映射校验：恰好覆盖全部未完成 AI 节点 + 逐一能力校验
  const nodeById = new Map(instance.nodes.map((node) => [node.nodeId, node]));
  const unfinishedAiNodes = instance.nodes.filter(isUnfinishedAiNode);
  const unfinishedIds = new Set(unfinishedAiNodes.map((node) => node.nodeId));
  const mappings = input.harnessMappings ?? [];
  const mappingIds = new Set(mappings.map((mapping) => mapping.nodeId));

  if (mappingIds.size !== mappings.length) {
    throw new Error(CONTINUATION_MESSAGES.mappingsNotExact);
  }
  for (const mapping of mappings) {
    if (unfinishedIds.has(mapping.nodeId)) continue;
    const node = nodeById.get(mapping.nodeId);
    // 命中实例内非 AI / 已完成节点：语义明确的拒绝文案；未知 nodeId 归入「必须恰好覆盖」
    if (node) {
      throw new Error(CONTINUATION_MESSAGES.mappingInvalidNode(node.name));
    }
    throw new Error(CONTINUATION_MESSAGES.mappingsNotExact);
  }
  if (mappingIds.size !== unfinishedIds.size) {
    throw new Error(CONTINUATION_MESSAGES.mappingsNotExact);
  }
  for (const mapping of mappings) {
    if (!availableServerTypes.includes(mapping.acpServerType)) {
      throw new Error(CONTINUATION_MESSAGES.harnessUnsupported(mapping.acpServerType));
    }
  }

  // 6. Worktree 决策：默认创建；非 Git 工作区（缺默认分支）先回填尝试，仍缺失则拒绝
  const createWorktree = input.createWorkflowWorktree ?? true;
  if (createWorktree && !workspace.defaultBranch) {
    const resolved = await resolveWorkspaceDefaultBranch({
      userId,
      controllerId: input.controllerId,
      workspaceId: input.workspaceId,
    });
    if (!resolved) {
      throw new Error(CONTINUATION_MESSAGES.notGitRepo);
    }
    workspace.defaultBranch = resolved;
  }

  // 7. 创建新 Worktree（提交人快照沿用实例既有快照，换绑不换身份）
  let created: { path: string; branch: string } | null = null;
  if (createWorktree && workspace.defaultBranch) {
    created = await createWorkflowWorktree(
      input.controllerId,
      {
        _id: workspace._id.toString(),
        name: workspace.name,
        path: workspace.path,
        defaultBranch: workspace.defaultBranch,
      },
      instance.name,
      resolveCommitterSnapshot(instance),
    );
  }

  // 8. 字段级 CAS 换绑（controllerId 旧值防并发重复接续）
  const set: Record<string, unknown> = {
    controllerId: input.controllerId,
    workspaceId: input.workspaceId,
    workflowWorktreePath: created?.path ?? null,
    workflowWorktreeBranch: created?.branch ?? null,
    // 未完成节点会话随原控制器不可达：清空 sessionId（DONE 节点保留供只读回看）
    'nodes.$[u].sessionId': null,
  };
  const arrayFilters: Record<string, unknown>[] = [{ 'u.status': { $ne: 'DONE' } }];
  mappings.forEach((mapping, index) => {
    set[`nodes.$[h${index}].agentConfig.acpServerType`] = mapping.acpServerType;
    arrayFilters.push({ [`h${index}.nodeId`]: mapping.nodeId });
  });

  const result = await WorkflowInstance.updateOne(
    {
      _id: instanceId,
      deletedAt: null,
      finishedAt: null,
      controllerId: instance.controllerId,
    },
    {
      $set: set,
      $push: {
        continuationHistory: {
          fromControllerId: instance.controllerId,
          fromWorkspaceId: instance.workspaceId,
          toControllerId: input.controllerId,
          toWorkspaceId: input.workspaceId,
          at: new Date(),
        },
      },
    },
    { arrayFilters },
  );

  if (result.modifiedCount === 0) {
    // 回滚本次新建的 Worktree（失败仅告警，不改变拒绝结果）
    if (created) {
      try {
        await removeWorkflowWorktree(input.controllerId, workspace.path, created.path, created.branch);
      } catch (err) {
        logger.warn(
          { event: 'continuation-rollback-worktree-failed', instanceId, err },
          'rollback continuation worktree failed',
        );
      }
    }
    throw new Error(CONTINUATION_MESSAGES.concurrent);
  }

  // 9. RUNNING/REWORK 的 AI 节点会话已随原控制器死亡：经引擎收敛为 FAILED（单节点失败仅告警）
  for (const node of instance.nodes) {
    if (node.type !== 'AI') continue;
    if (node.status !== 'RUNNING' && node.status !== 'REWORK') continue;
    try {
      await workflowEngine.transition(instanceId, node.nodeId, 'fail', {
        reason: CONTINUATION_MESSAGES.nodeFailedReason,
        source: 'CONTROLLER_UNAVAILABLE',
      });
    } catch (err) {
      logger.warn(
        { event: 'continuation-fail-node-failed', instanceId, nodeId: node.nodeId, err },
        'mark node failed after continuation failed',
      );
    }
  }

  // 10. 缓存失效并返回更新后实例
  await invalidateWorkflowInstanceCache(instanceId);
  const updated = await WorkflowInstance.findById(instanceId).lean();
  if (!updated) {
    throw new Error(CONTINUATION_MESSAGES.notFound);
  }
  return updated as unknown as IWorkflowInstance;
}
