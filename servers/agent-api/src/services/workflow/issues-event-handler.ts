import mongoose from 'mongoose';
import { config } from '../../config/index.js';
import { CloudHostIssuesLinkage } from '../../models/cloud-host-issues-linkage.js';
import { CloudHostSetupOperation } from '../../models/cloud-host-setup-operation.js';
import { ConfiguredWorkflow } from '../../models/configured-workflow.js';
import { ControllerWorkspace } from '../../models/controller-workspace.js';
import { IssueWorkflowTrigger } from '../../models/issue-workflow-trigger.js';
import { WorkflowInstance } from '../../models/workflow-instance.js';
import { cloudHostGithubService } from '../cloud-host-github-service.js';
import { cloudHostService } from '../cloud-host-service.js';
import { sanitizeOperationError } from '../cloud-host-workload-service.js';
import { controllerWorkspaceService } from '../controller-workspace.js';
import { githubService } from '../github.js';
import { KeyedMutex } from '../keyed-mutex.js';
import { normalizeWorkspacePrefix, resolveClonePath } from '../workspace-path.js';
import type { IssuesEventPayload } from './github-issues-webhook-payload.js';
import { workflowInstanceService, type InstantiateNodeInput } from './instance.js';
import {
  buildIssueNodeInput,
  buildIssueTriggerComment,
  buildTriggerInstanceName,
} from './issues-prompts.js';

type Doc = Record<string, unknown>;

export type IssuesIgnoreReason =
  | 'REPO_NOT_ENABLED'
  | 'NO_MATCHING_LINKAGE'
  | 'ALREADY_TRIGGERED'
  | 'CLOUD_HOST_NOT_RUNNING'
  | 'HANDLER_FAILED';

export interface IssuesEventResult {
  controllerId?: string;
  linkageId?: string;
  labelName?: string;
  action: 'CREATE_TRIGGER' | null;
  reason?: IssuesIgnoreReason;
}

export interface IssuesHandleResponse {
  handled: boolean;
  reason?: string;
  results: IssuesEventResult[];
}

const POLL_INTERVAL_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * issues 事件入口：仓库反查候选配置 → 标签命中 → 逐配置插入触发记录（唯一索引即幂等闸）
 * → 异步推进状态机（webhook 不等待全链路）。
 */
export async function handleIssuesEvent(event: IssuesEventPayload): Promise<IssuesHandleResponse> {
  const repoMatcher = new RegExp(`^${escapeRegExp(event.repoFullName)}$`, 'i');
  const candidates = (await CloudHostIssuesLinkage.find({
    repoFullNames: { $in: [repoMatcher] },
  }).lean()) as unknown as Doc[];

  if (candidates.length === 0) {
    return { handled: false, reason: 'REPO_NOT_ENABLED', results: [] };
  }

  const labels = new Set(event.labels.map((label) => label.toLowerCase()));
  const matched = candidates.filter((row) =>
    labels.has(String(row.labelNameLower ?? row.labelName ?? '').toLowerCase()),
  );
  if (matched.length === 0) {
    return { handled: false, reason: 'NO_MATCHING_LINKAGE', results: [] };
  }

  const results: IssuesEventResult[] = [];
  for (const linkage of matched) {
    const base: IssuesEventResult = {
      controllerId: String(linkage.controllerId),
      linkageId: String(linkage._id),
      labelName: String(linkage.labelName ?? ''),
      action: null,
    };
    try {
      const trigger = await IssueWorkflowTrigger.create({
        userId: linkage.userId as mongoose.Types.ObjectId,
        controllerId: linkage.controllerId as mongoose.Types.ObjectId,
        linkageId: linkage._id as mongoose.Types.ObjectId,
        configuredWorkflowId: linkage.configuredWorkflowId as mongoose.Types.ObjectId,
        labelName: String(linkage.labelName ?? ''),
        repoFullName: event.repoFullName,
        issueId: event.issueId,
        issueNumber: event.issueNumber,
        issueTitle: event.title,
        issueUrl: event.issueUrl,
        issueAuthor: event.author ?? null,
        issueBody: event.body ?? null,
        status: 'PENDING_WORKSPACE',
      });
      results.push({ ...base, action: 'CREATE_TRIGGER' });
      void issuesTriggerRunner.advance(String(trigger._id)).catch((err) => {
        console.warn('[issues-event] advance failed:', (err as Error).message);
      });
    } catch (err) {
      if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
        results.push({ ...base, reason: 'ALREADY_TRIGGERED' });
      } else {
        console.warn('[issues-event] create trigger failed:', (err as Error).message);
        results.push({ ...base, reason: 'HANDLER_FAILED' });
      }
    }
  }

  const handled = results.some((result) => result.action === 'CREATE_TRIGGER');
  return {
    handled,
    ...(handled ? {} : { reason: results[0]?.reason ?? 'NO_MATCHING_LINKAGE' }),
    results,
  };
}

/**
 * 触发状态机推进器：启动扫描 + 1s 定时轮询，单触发记录按 `issues-trigger:{id}` 串行。
 * 工作区初始化按 `issues-setup:{controllerId}` 串行（避免与手工 Git 项目设置互斥）。
 */
export class IssuesTriggerRunner {
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  private readonly triggerMutex = new KeyedMutex();
  private readonly setupMutex = new KeyedMutex();
  private readonly pollIntervalMs: number;

  constructor(options: { pollIntervalMs?: number } = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    void this.scan();
    this.timer = setInterval(() => {
      void this.scan();
    }, this.pollIntervalMs);
    this.timer.unref?.();
    console.log('[issues-trigger] runner started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 扫描未完成触发记录并推进（并发安全：单轮不重叠）。 */
  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const rows = await IssueWorkflowTrigger.find({
        status: { $in: ['PENDING_WORKSPACE', 'PENDING_INSTANTIATE', 'PENDING_HUMAN_NODE'] },
      })
        .sort({ updatedAt: 1 })
        .limit(50)
        .lean();
      for (const row of rows) {
        await this.advance(String(row._id)).catch((err) => {
          console.warn('[issues-trigger] scan advance failed:', (err as Error).message);
        });
      }
    } catch (err) {
      console.warn('[issues-trigger] scan failed:', (err as Error).message);
    } finally {
      this.scanning = false;
    }
  }

  /** 推进单条触发记录（幂等可重入；锁内重读）。 */
  async advance(triggerId: string): Promise<void> {
    if (!mongoose.isValidObjectId(triggerId)) return;
    await this.triggerMutex.runExclusive(`issues-trigger:${triggerId}`, async () => {
      const trigger = (await IssueWorkflowTrigger.findById(triggerId).lean()) as unknown as Doc | null;
      if (!trigger) return;
      const status = String(trigger.status ?? '');
      if (status === 'COMPLETED' || status === 'FAILED') return;
      if (status === 'PENDING_WORKSPACE') return this.prepareWorkspace(trigger);
      if (status === 'PENDING_INSTANTIATE') return this.instantiateWorkflow(trigger);
      if (status === 'PENDING_HUMAN_NODE') return this.advanceHumanNode(trigger);
    });
  }

  private async fail(triggerId: unknown, reason: string): Promise<void> {
    await IssueWorkflowTrigger.updateOne(
      { _id: triggerId, status: { $nin: ['COMPLETED', 'FAILED'] } },
      { $set: { status: 'FAILED', failureReason: sanitizeOperationError(reason) } },
    );
  }

  /** PENDING_WORKSPACE：云电脑 RUNNING 校验 → 工作区判定/初始化 → 回写 workspaceId。 */
  private async prepareWorkspace(trigger: Doc): Promise<void> {
    const userId = String(trigger.userId);
    const controllerId = String(trigger.controllerId);
    const repoFullName = String(trigger.repoFullName);
    try {
      const host = await cloudHostService.findOwnedRawHostByController(controllerId, userId);
      if (!host || host.status !== 'RUNNING') {
        await this.fail(trigger._id, 'CLOUD_HOST_NOT_RUNNING');
        return;
      }
      const prefix = await cloudHostService.defaultWorkspace(host);
      const clonePath = resolveClonePath(normalizeWorkspacePrefix(prefix), repoFullName);
      const existing = await ControllerWorkspace.findOne({ userId, controllerId, path: clonePath }).lean();
      if (existing) {
        await this.markWorkspaceReady(trigger._id, String(existing._id));
        return;
      }
      const workspaceId = await this.setupMutex.runExclusive(
        `issues-setup:${controllerId}`,
        () => this.ensureWorkspaceForRepo(trigger, { userId, controllerId, repoFullName, prefix, clonePath }),
      );
      if (workspaceId) await this.markWorkspaceReady(trigger._id, workspaceId);
    } catch (err) {
      await this.fail(trigger._id, (err as Error).message);
    }
  }

  /** 工作区初始化（`issues-setup:{controllerId}` 串行内执行；失败已落库，返回 null）。 */
  private async ensureWorkspaceForRepo(
    trigger: Doc,
    ctx: { userId: string; controllerId: string; repoFullName: string; prefix: string; clonePath: string },
  ): Promise<string | null> {
    const existing = await ControllerWorkspace.findOne({
      userId: ctx.userId,
      controllerId: ctx.controllerId,
      path: ctx.clonePath,
    }).lean();
    if (existing) return String(existing._id);
    try {
      await this.waitForSetupSlot(ctx.userId, ctx.controllerId);
      const accountId = await githubService.resolveRepoAccount(ctx.userId, ctx.repoFullName);
      return await this.runSetupAndGetWorkspace(trigger, ctx, accountId);
    } catch (err) {
      await this.fail(trigger._id, (err as Error).message);
      return null;
    }
  }

  private async runSetupAndGetWorkspace(
    trigger: Doc,
    ctx: { userId: string; controllerId: string; repoFullName: string; prefix: string; clonePath: string },
    accountId: string,
  ): Promise<string | null> {
    const operation = await cloudHostGithubService.createOperation({
      userId: ctx.userId,
      controllerId: ctx.controllerId,
      accountId,
      repoFullName: ctx.repoFullName,
      targetPath: ctx.prefix,
      createSession: false,
    });
    const operationId = String(operation.id);
    await IssueWorkflowTrigger.updateOne(
      { _id: trigger._id },
      { $set: { setupOperationId: operationId } },
    );
    if (!(await this.waitForOperation(operationId))) {
      const op = await CloudHostSetupOperation.findById(operationId).lean();
      await this.fail(trigger._id, String(op?.error ?? 'workspace setup failed'));
      return null;
    }
    const workspace = await controllerWorkspaceService.ensureWorkspace(
      ctx.controllerId,
      ctx.userId,
      ctx.clonePath,
    );
    return String(workspace.id);
  }

  /** 轮询 setup 操作终态；stale（`updatedAt` 未推进超过阈值）标记 FAILED 并返回 false。 */
  private async waitForOperation(operationId: string): Promise<boolean> {
    for (;;) {
      const op = await CloudHostSetupOperation.findById(operationId).lean();
      if (!op) return false;
      if (op.status === 'SUCCEEDED') return true;
      if (op.status === 'FAILED') return false;
      const updatedAt = op.updatedAt instanceof Date ? op.updatedAt.getTime() : 0;
      if (Date.now() - updatedAt > config.cloudHostSetupStaleMs) {
        await CloudHostSetupOperation.updateOne(
          { _id: operationId, status: 'RUNNING' },
          { $set: { status: 'FAILED', error: '操作已中断，请重试' } },
        );
        return false;
      }
      await sleep(this.pollIntervalMs);
    }
  }

  /** 等待同云电脑手工 Git 项目设置结束（`github-setup:` 互斥拒绝的规避：轮询等待而非失败）。 */
  private async waitForSetupSlot(userId: string, controllerId: string): Promise<void> {
    for (;;) {
      const running = await CloudHostSetupOperation.findOne({
        userId,
        controllerId,
        kind: 'githubSetup',
        status: 'RUNNING',
      }).lean();
      if (!running) return;
      const updatedAt = running.updatedAt instanceof Date ? running.updatedAt.getTime() : 0;
      if (Date.now() - updatedAt > config.cloudHostSetupStaleMs) {
        await CloudHostSetupOperation.updateOne(
          { _id: running._id, status: 'RUNNING' },
          { $set: { status: 'FAILED', error: '操作已中断，请重试' } },
        );
        continue;
      }
      await sleep(this.pollIntervalMs);
    }
  }

  /** PENDING_INSTANTIATE：映射节点图 → 实例化 → 回写实例与首个人类节点。 */
  private async instantiateWorkflow(trigger: Doc): Promise<void> {
    try {
      const userId = String(trigger.userId);
      const controllerId = String(trigger.controllerId);
      const workspaceId = trigger.workspaceId ? String(trigger.workspaceId) : '';
      if (!workspaceId) {
        await this.fail(trigger._id, 'workspace not ready');
        return;
      }
      const configuredWorkflowId = String(trigger.configuredWorkflowId);
      const workflow = await ConfiguredWorkflow.findOne({ _id: configuredWorkflowId, userId }).lean();
      if (!workflow) {
        await this.fail(trigger._id, 'workflow not found');
        return;
      }
      const nodes = mapConfiguredNodes(workflow.nodes as never);
      await this.createInstance(trigger, { userId, controllerId, workspaceId, configuredWorkflowId, nodes });
    } catch (err) {
      await this.fail(trigger._id, (err as Error).message);
    }
  }

  private async createInstance(
    trigger: Doc,
    ctx: { userId: string; controllerId: string; workspaceId: string; configuredWorkflowId: string; nodes: InstantiateNodeInput[] },
  ): Promise<void> {
    const instance = await workflowInstanceService.instantiate(ctx.userId, {
      source: 'CONFIGURED',
      configuredWorkflowId: ctx.configuredWorkflowId,
      controllerId: ctx.controllerId,
      workspaceId: ctx.workspaceId,
      name: buildTriggerInstanceName(
        String(trigger.repoFullName),
        Number(trigger.issueNumber ?? 0),
        String(trigger.issueTitle ?? ''),
      ),
      nodes: ctx.nodes,
    });
    const instanceId = String(instance._id);
    const humanNodeId = resolveFirstHumanNode(instance.nodes as never);
    if (!humanNodeId) {
      await IssueWorkflowTrigger.updateOne(
        { _id: trigger._id },
        { $set: { workflowInstanceId: instanceId, status: 'COMPLETED', failureReason: 'workflow has no human node' } },
      );
      return;
    }
    await IssueWorkflowTrigger.updateOne(
      { _id: trigger._id },
      { $set: { workflowInstanceId: instanceId, humanNodeId, status: 'PENDING_HUMAN_NODE' } },
    );
  }

  /** PENDING_HUMAN_NODE：回评（一次补偿）→ 轮询首个人类节点 → 自动完成。 */
  private async advanceHumanNode(trigger: Doc): Promise<void> {
    const instanceId = trigger.workflowInstanceId ? String(trigger.workflowInstanceId) : '';
    if (!instanceId) {
      await this.fail(trigger._id, 'workflow interrupted');
      return;
    }
    const instance = await WorkflowInstance.findById(instanceId).lean();
    if (!instance || instance.deletedAt || instance.archivedAt) {
      await this.fail(trigger._id, 'workflow interrupted');
      return;
    }
    const humanNodeId = String(trigger.humanNodeId ?? '');
    const node = instance.nodes.find((item) => item.nodeId === humanNodeId);
    if (!node) {
      await this.fail(trigger._id, 'workflow interrupted');
      return;
    }
    if (node.status === 'DONE') {
      await this.markCompleted(trigger._id, humanNodeId);
      return;
    }
    const createdAt = trigger.createdAt instanceof Date ? trigger.createdAt.getTime() : 0;
    if (createdAt && Date.now() - createdAt > config.issuesTriggerHumanNodeTimeoutMs) {
      await this.fail(trigger._id, 'human node timeout');
      return;
    }
    await this.ensureComment(trigger, instanceId);
    await this.completeHuman(trigger, instanceId, humanNodeId);
  }

  /** Issue 回评：失败不阻断推进；仅在未成功且尝试次数 < 2（首次 + 一次补偿）时重试。 */
  private async ensureComment(trigger: Doc, instanceId: string): Promise<void> {
    if (trigger.commentId) return;
    const attempts = Number(trigger.commentAttempts ?? 0);
    if (attempts >= 2) return;
    try {
      const commentId = await githubService.createIssueComment(
        String(trigger.userId),
        String(trigger.repoFullName),
        Number(trigger.issueNumber ?? 0),
        buildIssueTriggerComment(instanceId),
      );
      await IssueWorkflowTrigger.updateOne(
        { _id: trigger._id },
        { $set: { commentId, commentError: null }, $inc: { commentAttempts: 1 } },
      );
    } catch (err) {
      await IssueWorkflowTrigger.updateOne(
        { _id: trigger._id },
        { $set: { commentError: sanitizeOperationError(err) }, $inc: { commentAttempts: 1 } },
      );
    }
  }

  /** 首个人类节点自动完成（READY/RUNNING）；非法状态转移时重读确认幂等。 */
  private async completeHuman(trigger: Doc, instanceId: string, humanNodeId: string): Promise<void> {
    if (!['READY', 'RUNNING'].includes(String(await this.nodeStatus(instanceId, humanNodeId)))) return;
    try {
      await workflowInstanceService.completeHumanNode(
        String(trigger.userId),
        instanceId,
        humanNodeId,
        buildIssueNodeInput({
          repoFullName: String(trigger.repoFullName),
          issueNumber: Number(trigger.issueNumber ?? 0),
          issueTitle: String(trigger.issueTitle ?? ''),
          issueUrl: trigger.issueUrl ? String(trigger.issueUrl) : null,
          issueAuthor: trigger.issueAuthor ? String(trigger.issueAuthor) : null,
          issueBody: trigger.issueBody ? String(trigger.issueBody) : null,
        }),
      );
    } catch (err) {
      // 并发/重复推进：节点已 DONE 视为幂等成功，否则保留 PENDING 等下一轮
      if ((await this.nodeStatus(instanceId, humanNodeId)) === 'DONE') {
        await this.markCompleted(trigger._id, humanNodeId);
        return;
      }
      console.warn('[issues-trigger] complete human node failed:', (err as Error).message);
      return;
    }
    await this.markCompleted(trigger._id, humanNodeId);
  }

  private async nodeStatus(instanceId: string, nodeId: string): Promise<string> {
    const instance = await WorkflowInstance.findById(instanceId).lean();
    return String(instance?.nodes.find((node) => node.nodeId === nodeId)?.status ?? '');
  }

  private async markCompleted(triggerId: unknown, nodeId: string): Promise<void> {
    await IssueWorkflowTrigger.updateOne(
      { _id: triggerId, status: 'PENDING_HUMAN_NODE' },
      { $set: { status: 'COMPLETED', completedNodeId: nodeId } },
    );
  }

  private async markWorkspaceReady(triggerId: unknown, workspaceId: string): Promise<void> {
    await IssueWorkflowTrigger.updateOne(
      { _id: triggerId, status: 'PENDING_WORKSPACE' },
      { $set: { workspaceId, status: 'PENDING_INSTANTIATE' } },
    );
  }
}

/** ConfiguredWorkflow.nodes → InstantiateNodeInput（dependsOn 保留 nodeKey，由 instantiate 重写）。 */
export function mapConfiguredNodes(nodes: readonly Doc[] | undefined | null): InstantiateNodeInput[] {
  return (nodes ?? []).map((node) => ({
    nodeKey: String(node.nodeKey ?? ''),
    type: node.type as InstantiateNodeInput['type'],
    name: String(node.name ?? ''),
    description: (node.description as string | null | undefined) ?? null,
    stage: String(node.stage ?? '默认阶段'),
    prompts: (node.prompts as string[] | undefined) ?? null,
    artifactTitles: (node.artifactTitles as string[] | undefined) ?? null,
    dependsOn: ((node.dependsOn as string[] | undefined) ?? []).map(String),
    requiresWorktree: Boolean(node.requiresWorktree),
    linkUpstreamPullRequest: Boolean(node.linkUpstreamPullRequest),
    agentConfig: (node.agentConfig as InstantiateNodeInput['agentConfig']) ?? null,
    sortOrder: (node.sortOrder as number | null | undefined) ?? null,
  }));
}

interface TopoNode {
  nodeId: string;
  type: string;
  dependsOn?: string[];
  sortOrder?: number | null;
}

/**
 * 执行序上第一个 HUMAN 节点（Kahn 拓扑 + 同层 sortOrder 升序、再按快照顺序稳定）。
 * 无 HUMAN 返回 null（配置校验已拦截，此处仅防御）。
 */
export function resolveFirstHumanNode(nodes: readonly TopoNode[]): string | null {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const remaining = new Map(nodes.map((node) => [node.nodeId, node]));
  const indegree = new Map(
    nodes.map((node) => [
      node.nodeId,
      (node.dependsOn ?? []).filter((id) => byId.has(id)).length,
    ]),
  );
  const order: string[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((node) => (indegree.get(node.nodeId) ?? 0) === 0)
      .sort(
        (a, b) =>
          (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER),
      );
    if (ready.length === 0) break;
    const node = ready[0];
    order.push(node.nodeId);
    remaining.delete(node.nodeId);
    for (const candidate of remaining.values()) {
      if ((candidate.dependsOn ?? []).includes(node.nodeId)) {
        indegree.set(candidate.nodeId, (indegree.get(candidate.nodeId) ?? 1) - 1);
      }
    }
  }

  const firstHuman = order.map((id) => byId.get(id)!).find((node) => node.type === 'HUMAN');
  return firstHuman?.nodeId ?? null;
}

export const issuesTriggerRunner = new IssuesTriggerRunner();
