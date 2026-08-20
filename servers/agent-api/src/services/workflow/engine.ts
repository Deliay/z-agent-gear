import { WorkflowInstance } from '../../models/workflow-instance.js';
import { artifactKey, getArtifactKeys, removeKey, addRejectRecord } from './blackboard.js';

/** 引擎可操作的最小节点结构（Mongoose 文档或测试 mock 均可满足） */
export interface WorkflowNodeDoc {
  nodeId: string;
  nodeKey: string;
  type: string;
  name: string;
  description?: string | null;
  stage: string;
  status: string;
  dependsOn: string[];
  sessionId?: unknown;
  createdAt?: Date;
  startedAt?: Date;
  reworkedAt?: Date;
  reworkCount: number;
  fallbackSent?: boolean;
  rejectInfo?: { reason: string; fromNodeId?: string | null; at: Date } | null;
  failInfo?: { reason: string; source: string; at: Date } | null;
}

/** 引擎可操作的最小实例结构 */
export interface WorkflowInstanceDoc {
  _id: { toString(): string };
  userId: { toString(): string };
  controllerId: { toString(): string };
  workspaceId: { toString(): string };
  configuredWorkflowId: { toString(): string };
  name: string;
  nodes: WorkflowNodeDoc[];
  currentNodeNames: string[];
  blackboard: Map<string, string>;
  blackboardTrash: Map<string, string>;
  blackboardUpdatedAt: Map<string, Date>;
  /** 软删除标记（删除实例时置为删除时间；非空则拒绝一切转移） */
  deletedAt?: Date | null;
  /** 最后执行过的节点（实例对外状态展示；每次转移按时间序更新，级联末位为准） */
  lastNodeName?: string | null;
  lastNodeStatus?: string | null;
  save(): Promise<unknown>;
}

export type WorkflowEvent =
  | 'start'
  | 'complete'
  | 'reject'
  | 'rework'
  | 'completeRework'
  | 'resume'
  | 'fail'
  | 'resumeFailed'
  | 'restart';

export interface TransitionPayload {
  /** reject：打回原因 */
  reason?: string;
  /** reject/rework：发起打回的节点 nodeId */
  fromNodeId?: string | null;
  /** reject：限定返工的直接上游 nodeId 列表（默认全部直接上游） */
  targetNodeIds?: string[];
  /** complete/completeRework：产物列表，写入黑板 */
  artifacts?: { title: string; value: string }[];
  /** fail：失败来源（SESSION_STUCK=提醒后仍停止 / LLM_REPORTED=LLM 主动标记） */
  source?: string;
  /** restart：可选的新 Agent 配置 */
  agentConfig?: {
    acpServerType: string;
    modeId?: string | null;
    modelId?: string | null;
    initNewWorktree: boolean;
  } | null;
}

/**
 * 引擎副作用 hook（由 Orchestrator 注册，引擎不直接 import Orchestrator，避免循环依赖）。
 * - onNodeStart：AI 节点 READY→RUNNING 前拉起会话
 * - onNodeRework：节点进入 REWORK（resume 原会话并发送打回原因）
 * - onNodeResume：REJECT→RUNNING（通知其重新获取产物）
 * - onNodeDone：节点 DONE 后结束本会话（在下游 start 之后调用）
 */
export interface EngineHooks {
  onNodeStart?(instance: WorkflowInstanceDoc, node: WorkflowNodeDoc): Promise<void>;
  onNodeRework?(instance: WorkflowInstanceDoc, node: WorkflowNodeDoc, payload: TransitionPayload): Promise<void>;
  onNodeResume?(instance: WorkflowInstanceDoc, node: WorkflowNodeDoc): Promise<void>;
  onNodeDone?(instance: WorkflowInstanceDoc, node: WorkflowNodeDoc): Promise<void>;
  onNodeRestart?(instance: WorkflowInstanceDoc, node: WorkflowNodeDoc): Promise<void>;
}

/** 显式状态转移表（event → 允许的源状态 → 目标状态） */
const TRANSITIONS: Record<WorkflowEvent, { from: string[]; to: string }> = {
  start: { from: ['INITIALIZING', 'READY'], to: 'READY' },
  complete: { from: ['RUNNING'], to: 'DONE' },
  // 返工中（REWORK）也允许再次打回：a→b→c 中 c 打回 b 后，b 可继续打回 a
  reject: { from: ['RUNNING', 'REWORK'], to: 'REJECT' },
  rework: { from: ['READY', 'RUNNING', 'DONE'], to: 'REWORK' },
  completeRework: { from: ['REWORK'], to: 'DONE' },
  resume: { from: ['REJECT'], to: 'RUNNING' },
  fail: { from: ['RUNNING'], to: 'FAILED' },
  resumeFailed: { from: ['FAILED'], to: 'RUNNING' },
  // 重启节点：会话失败/卡住时人工触发，关闭旧会话并拉起全新会话重试
  restart: { from: ['RUNNING', 'REWORK', 'FAILED'], to: 'RUNNING' },
};

const EVENT_LABEL: Record<WorkflowEvent, string> = {
  start: '启动',
  complete: '完成',
  reject: '打回',
  rework: '返工',
  completeRework: '返工完成',
  resume: '复工',
  fail: '标记失败',
  resumeFailed: '恢复运行',
  restart: '重启节点',
};

class WorkflowEngine {
  private hooks: EngineHooks = {};

  /** 注册副作用 hook（Orchestrator 在服务启动时调用） */
  registerHooks(hooks: EngineHooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  /** 唯一状态转移入口：所有路径（GraphQL mutation / MCP 工具 / 兜底逻辑）统一走此入口 */
  async transition(
    instanceId: string,
    nodeId: string,
    event: WorkflowEvent,
    payload: TransitionPayload = {},
  ): Promise<WorkflowNodeDoc> {
    const instance = (await WorkflowInstance.findById(instanceId)) as unknown as WorkflowInstanceDoc | null;
    if (!instance) {
      throw new Error(`工作流实例不存在：${instanceId}`);
    }
    if (instance.deletedAt) {
      throw new Error('工作流实例已删除，无法继续流转');
    }
    const node = instance.nodes.find((n) => n.nodeId === nodeId);
    if (!node) {
      throw new Error(`工作流实例中不存在节点：${nodeId}`);
    }
    await this.apply(instance, node, event, payload);
    this.refreshCurrentNodeNames(instance);
    await instance.save();
    return node;
  }

  private async apply(
    instance: WorkflowInstanceDoc,
    node: WorkflowNodeDoc,
    event: WorkflowEvent,
    payload: TransitionPayload,
  ): Promise<void> {
    const rule = TRANSITIONS[event];
    if (!rule.from.includes(node.status)) {
      throw new Error(
        `节点「${node.name}」当前状态为 ${node.status}，不允许执行「${EVENT_LABEL[event]}」（${event}）`,
      );
    }

    switch (event) {
      case 'start': {
        node.status = 'READY';
        await this.maybeActivate(instance, node);
        // FLAG 透传已在 maybeActivate 内按时间序记录，避免覆盖下游
        if (node.type !== 'FLAG') this.markLastNode(instance, node);
        break;
      }
      case 'complete': {
        this.writeArtifacts(instance, node, payload.artifacts);
        node.status = 'DONE';
        this.markLastNode(instance, node);
        // 先推进下游再结束本会话：
        // - 下游 REJECT（链式打回场景：下游在打回更上游时自身被打回）→ resume 复工
        // - 其余 → start（新建会话/激活）
        for (const downstream of this.downstreamsOf(instance, node)) {
          if (downstream.status === 'REJECT') {
            await this.apply(instance, downstream, 'resume', {});
          } else {
            await this.apply(instance, downstream, 'start', {});
          }
        }
        // 先落库再结束本会话：onNodeDone 关闭会话会触发兜底检查（读取 DB 节点状态），
        // 若此时新状态未持久化，兜底逻辑会误读节点仍为 RUNNING 而错误 resume 会话
        this.refreshCurrentNodeNames(instance);
        await instance.save();
        await this.hooks.onNodeDone?.(instance, node);
        break;
      }
      case 'reject': {
        const upstreams = this.upstreamsOf(instance, node);
        if (upstreams.length === 0) {
          throw new Error(`节点「${node.name}」是首节点，没有上游节点可打回`);
        }
        node.status = 'REJECT';
        node.rejectInfo = { reason: payload.reason ?? '', fromNodeId: payload.fromNodeId ?? null, at: new Date() };
        this.markLastNode(instance, node);
        await addRejectRecord(instance, node.nodeId, payload.reason ?? '', payload.fromNodeId);
        // 触发直接上游 REWORK（可通过 targetNodeIds 限定范围）
        const targets = payload.targetNodeIds ? new Set(payload.targetNodeIds) : null;
        for (const upstream of upstreams) {
          if (targets && !targets.has(upstream.nodeId)) continue;
          if (TRANSITIONS.rework.from.includes(upstream.status)) {
            await this.apply(instance, upstream, 'rework', { reason: payload.reason, fromNodeId: node.nodeId });
          }
        }
        break;
      }
      case 'rework': {
        node.status = 'REWORK';
        this.markLastNode(instance, node);
        node.reworkCount = (node.reworkCount ?? 0) + 1;
        node.reworkedAt = new Date();
        await this.hooks.onNodeRework?.(instance, node, payload);
        break;
      }
      case 'completeRework': {
        // 重置产物：旧产物 key 挪入垃圾桶
        for (const key of getArtifactKeys(instance, node.nodeId, node.name)) {
          await removeKey(instance, key);
        }
        this.writeArtifacts(instance, node, payload.artifacts);
        node.status = 'DONE';
        this.markLastNode(instance, node);
        // 通知下游 REJECT 节点复工
        for (const downstream of this.downstreamsOf(instance, node)) {
          if (downstream.status === 'REJECT') {
            await this.apply(instance, downstream, 'resume', {});
          }
        }
        this.refreshCurrentNodeNames(instance);
        await instance.save();
        await this.hooks.onNodeDone?.(instance, node);
        break;
      }
      case 'resume': {
        node.status = 'RUNNING';
        this.markLastNode(instance, node);
        await this.hooks.onNodeResume?.(instance, node);
        break;
      }
      case 'fail': {
        // 失败：阻断流程（非 DONE 下游永不激活），等待人工介入；不触发会话 hook
        // （SESSION_STUCK 来源会话已 ended；LLM_REPORTED 来源会话保留供人类对话介入）
        node.status = 'FAILED';
        this.markLastNode(instance, node);
        node.failInfo = {
          reason: payload.reason ?? '',
          source: payload.source ?? 'LLM_REPORTED',
          at: new Date(),
        };
        break;
      }
      case 'resumeFailed': {
        // 人工在节点会话中给出指示后由 LLM 调用恢复；会话仍在，无需 hook
        node.status = 'RUNNING';
        this.markLastNode(instance, node);
        node.failInfo = null;
        break;
      }
      case 'restart': {
        // 会话失败/卡住时人工重启：清失败/打回标记与兜底提醒，关闭旧会话拉起全新会话
        node.status = 'RUNNING';
        node.failInfo = null;
        node.rejectInfo = null;
        node.fallbackSent = false;
        this.markLastNode(instance, node);
        await this.hooks.onNodeRestart?.(instance, node);
        break;
      }
    }
  }

  /** 记录最后执行过的节点（实例对外状态展示用；级联转移时后调用者覆盖先调用者） */
  private markLastNode(instance: WorkflowInstanceDoc, node: WorkflowNodeDoc): void {
    instance.lastNodeName = node.name;
    instance.lastNodeStatus = node.status;
  }

  /** READY 节点的激活评估：上游全部 DONE 后按类型推进 */
  private async maybeActivate(instance: WorkflowInstanceDoc, node: WorkflowNodeDoc): Promise<void> {
    if (node.status !== 'READY') return;
    if (!this.upstreamsAllDone(instance, node)) return;

    if (node.type === 'FLAG') {
      // FLAG 节点透传：自身 DONE，不产生会话，直接接力下游
      node.status = 'DONE';
      this.markLastNode(instance, node);
      for (const downstream of this.downstreamsOf(instance, node)) {
        await this.apply(instance, downstream, 'start', {});
      }
      return;
    }

    if (node.type === 'AI') {
      await this.hooks.onNodeStart?.(instance, node);
    }
    node.status = 'RUNNING';
    node.startedAt = node.startedAt ?? new Date();
  }

  private upstreamsOf(instance: WorkflowInstanceDoc, node: WorkflowNodeDoc): WorkflowNodeDoc[] {
    const upstreamIds = new Set(node.dependsOn ?? []);
    return instance.nodes.filter((n) => upstreamIds.has(n.nodeId));
  }

  private downstreamsOf(instance: WorkflowInstanceDoc, node: WorkflowNodeDoc): WorkflowNodeDoc[] {
    return instance.nodes.filter((n) => (n.dependsOn ?? []).includes(node.nodeId));
  }

  private upstreamsAllDone(instance: WorkflowInstanceDoc, node: WorkflowNodeDoc): boolean {
    return this.upstreamsOf(instance, node).every((n) => n.status === 'DONE');
  }

  private writeArtifacts(
    instance: WorkflowInstanceDoc,
    node: WorkflowNodeDoc,
    artifacts?: { title: string; value: string }[],
  ): void {
    for (const artifact of artifacts ?? []) {
      const key = artifactKey(node.nodeId, node.name, artifact.title);
      instance.blackboard.set(key, artifact.value);
      instance.blackboardUpdatedAt.set(key, new Date());
    }
  }

  /** 实例对外状态 = 全部 RUNNING 节点名 */
  private refreshCurrentNodeNames(instance: WorkflowInstanceDoc): void {
    const names = instance.nodes.filter((n) => n.status === 'RUNNING').map((n) => n.name);
    instance.currentNodeNames.splice(0, instance.currentNodeNames.length, ...names);
  }
}

export const workflowEngine = new WorkflowEngine();
