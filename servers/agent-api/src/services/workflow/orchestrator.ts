import { sessionService } from '../session.js';
import { logger as rootLogger } from '../../observability/logger.js';
import { withSpan } from '../../observability/trace.js';
import { todoService } from '../todo-service.js';
import { WorkflowInstance } from '../../models/workflow-instance.js';
import { McpServer } from '../../models/mcp-server.js';
import {
  workflowEngine,
  type WorkflowInstanceDoc,
  type WorkflowNodeDoc,
  type TransitionPayload,
} from './engine.js';
import { getArtifactKeys, getValue } from './blackboard.js';
import { PLATFORM_SERVER_NAME } from './tool-handlers.js';
import { ADMIN_PLATFORM_SERVER_NAME, ensureAdminToolsServer } from './admin-tools.js';
import { initialModeModel, loadNodeConfig } from './node-config.js';
import { scheduleInterruptionRetry } from './interrupt-retry.js';
import { isReentrantLockError } from '../keyed-mutex.js';
import { WORKFLOW_SYSTEM_PROMPT, FALLBACK_PROMPT, IDLE_NUDGE_PROMPT } from './prompts.js';

const logger = rootLogger.child({ component: 'workflow-orchestrator' });

// 提示词常量从 prompts.ts 统一导出（interrupt-retry 复用，避免循环依赖）；此处重导出保持既有引用口径
export { WORKFLOW_SYSTEM_PROMPT, FALLBACK_PROMPT, IDLE_NUDGE_PROMPT };

/** 转为 slug（小写字母/数字/连字符）；无 ASCII 字符时返回空串由调用方兜底 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** N-4：锁内兜底回环的延迟重试上限与退避基数（100ms/200ms/400ms） */
const FALLBACK_RETRY_MAX = 3;
const FALLBACK_RETRY_BASE_MS = 100;

class WorkflowOrchestrator {
  /** 注册为引擎 hook + 会话结束兜底回调（服务启动时调用一次） */
  register(): void {
    workflowEngine.registerHooks({
      onNodeStart: (instance, node) => this.startNodeSession(instance, node),
      onNodeRework: (instance, node, payload) => this.reworkNodeSession(instance, node, payload),
      onNodeResume: (instance, node) => this.resumeNodeSession(instance, node),
      onNodeDone: (instance, node) => this.endNodeSession(instance, node),
      onNodeRestart: (instance, node, payload) => this.restartNodeSession(instance, node, payload),
    });
    sessionService.onSessionEnded((sessionId) => this.handleSessionEnded(sessionId));
    sessionService.onSessionRemoved((sessionId) => this.handleSessionRemoved(sessionId));
    sessionService.onSessionIdled((sessionId) => this.handleSessionIdled(sessionId));
  }

  /**
   * 空闲停滞检测：工作流节点会话 turn 结束（promptCompleted→idling）但节点未推进时触发。
   * 典型场景：权限审批超时 → harness 取消当前 turn → 会话空闲，节点停在 RUNNING。
   * 统一走中断自动重试排期（10 次预算 + 指数退避），超限后由 retryExhausted 转 RETRY_FAILED。
   */
  async handleSessionIdled(sessionId: string, _attempt = 0): Promise<void> {
    const instance = (await WorkflowInstance.findOne({
      'nodes.sessionId': sessionId,
      deletedAt: null,
    })) as unknown as WorkflowInstanceDoc | null;
    if (!instance) return;
    const node = instance.nodes.find((n) => n.sessionId?.toString() === sessionId);
    if (!node || (node.status !== 'RUNNING' && node.status !== 'REWORK')) return;

    await scheduleInterruptionRetry({
      instanceId: instance._id.toString(),
      nodeId: node.nodeId,
      sessionId,
      trigger: 'IDLED',
    });
  }

  /**
   * 会话被移除（start/resume 失败清理）：节点仍 RUNNING/REWORK 时升级 FAILED。
   * 会话文档已删除，兜底 resume 无意义——必须让节点可见地失败，
   * 否则节点停在 RUNNING、sessionId 悬空，流程永久卡死（人工可「重启节点」恢复）。
   */
  async handleSessionRemoved(sessionId: string, attempt = 0): Promise<void> {
    const instance = (await WorkflowInstance.findOne({
      'nodes.sessionId': sessionId,
      deletedAt: null,
    })) as unknown as WorkflowInstanceDoc | null;
    if (!instance) return;
    const node = instance.nodes.find((n) => n.sessionId?.toString() === sessionId);
    if (!node || (node.status !== 'RUNNING' && node.status !== 'REWORK')) return;

    await this.transitionOrDefer(
      'removed',
      sessionId,
      instance,
      node,
      'fail',
      {
        reason: '节点会话启动失败或运行中被移除，请人工介入后重启节点',
        source: 'SESSION_START_FAILED',
      },
      attempt,
    );
  }

  /** AI 节点 READY→RUNNING：组装提示词 → 创建打标会话（按阶段 worktree）→ 发送提示词 */
  async startNodeSession(instance: WorkflowInstanceDoc, node: WorkflowNodeDoc): Promise<void> {
    return withSpan(
      'workflow.node.advance',
      { workflowInstanceId: instance._id.toString(), nodeId: node.nodeId },
      () => this.startNodeSessionInner(instance, node),
    );
  }

  private async startNodeSessionInner(instance: WorkflowInstanceDoc, node: WorkflowNodeDoc): Promise<void> {
    const configuredNode = await loadNodeConfig(instance, node);
    const agentConfig = configuredNode.agentConfig;
    if (!agentConfig) {
      throw new Error(`节点「${node.name}」（${node.nodeKey}）缺少 Agent 配置，无法拉起会话`);
    }

    const prompt = this.assemblePrompt(instance, node, configuredNode.prompts ?? []);

    // 工作目录优先级：
    // 1. 节点 initNewWorktree && requiresWorktree → 维持现状建节点级 Worktree
    // 2. 实例存在 workflowWorktreePath → 以 existingWorktreePath 下发
    // 3. 否则工作区根目录
    const enableWorktree = Boolean(configuredNode.requiresWorktree && agentConfig.initNewWorktree);
    const existingWorktreePath = !enableWorktree && instance.workflowWorktreePath
      ? instance.workflowWorktreePath
      : undefined;

    // 阶段 worktree 后缀：<instance-slug>/<stage-slug>（同阶段节点会话复用同一 worktree）
    const instanceSlug = slugify(instance.name) || instance._id.toString();
    const stageSlug = slugify(node.stage) || 'stage';

    // 节点级 Worktree 复用实例初始化时的提交人快照（成员中途改设置不影响已建 Worktree）；
    // 快照缺失显式传 null，避免 session.create 回退到会话创建者的实时解析。
    const snapshot = instance as WorkflowInstanceDoc & {
      worktreeCommitterName?: string | null;
      worktreeCommitterEmail?: string | null;
      worktreeCoAuthorName?: string | null;
      worktreeCoAuthorEmail?: string | null;
    };
    const worktreeCommitter =
      snapshot.worktreeCommitterName && snapshot.worktreeCommitterEmail
        ? {
            name: snapshot.worktreeCommitterName,
            email: snapshot.worktreeCommitterEmail,
            ...(snapshot.worktreeCoAuthorName && snapshot.worktreeCoAuthorEmail
              ? {
                  coAuthorName: snapshot.worktreeCoAuthorName,
                  coAuthorEmail: snapshot.worktreeCoAuthorEmail,
                }
              : {}),
          }
        : null;

    const session = await sessionService.create(instance.userId.toString(), {
      controllerId: instance.controllerId.toString(),
      acpServerType: agentConfig.acpServerType,
      workspaceId: instance.workspaceId.toString(),
      enableWorktree,
      worktreeBranchSuffix: enableWorktree ? `${instanceSlug}/${stageSlug}` : undefined,
      existingWorktreePath,
      worktreeCommitter,
      workflowInstanceId: instance._id.toString(),
      workflowNodeId: node.nodeId,
      resourceWorkspaceId: instance.resourceWorkspaceId
        ? instance.resourceWorkspaceId.toString()
        : undefined,
      // 节点会话自动装配平台工作流工具服务 + 管理工作流管理工具集（AI 可通过 admin 工具集完成编排）
      mcpServerIds: [
        await this.ensureWorkflowToolsServer(instance.userId.toString()),
        await ensureAdminToolsServer(instance.userId.toString()),
      ],
      // 节点配置的 mode/model：随 acp:start 带内下发，bridge 在首条 prompt 前应用
      ...(agentConfig.modeId ? { modeId: agentConfig.modeId } : {}),
      ...(agentConfig.modelId ? { modelId: agentConfig.modelId } : {}),
    });
    node.sessionId = session.id as string;

    await sessionService.addMessage(node.sessionId as string, {
      direction: 'input',
      type: 'text',
      content: prompt,
    });
  }

  /** 节点进入 REWORK：resume 原会话（初始 mode/model 带内下发）、重发打回原因 */
  async reworkNodeSession(
    instance: WorkflowInstanceDoc,
    node: WorkflowNodeDoc,
    payload: TransitionPayload,
  ): Promise<void> {
    if (!node.sessionId) return;
    const sessionId = node.sessionId.toString();
    const configuredNode = await loadNodeConfig(instance, node);
    await sessionService.resume(
      sessionId,
      instance.userId.toString(),
      initialModeModel(configuredNode.agentConfig),
    );
    await sessionService.addMessage(sessionId, {
      direction: 'input',
      type: 'text',
      content:
        `你的工作流节点产出被下游节点打回，需要返工。打回原因：${payload.reason ?? '（未提供）'}。\n` +
        '请根据打回原因修订产出，通过工作流工具重新写入产物后调用 completeCurrentRework 完成返工。\n' +
        '若返工中发现问题根源在更上游（本节点无法独立修正），可调用 rejectCurrentNode 将本节点打回并触发上游返工。',
    });
  }

  /** REJECT→RUNNING：关闭下游 REJECT 节点阻塞期间的空闲会话，再以全新会话复工（含最新上游产物与 Mode/模型配置） */
  async resumeNodeSession(instance: WorkflowInstanceDoc, node: WorkflowNodeDoc): Promise<void> {
    // HUMAN/FLAG 节点无会话，复工仅需引擎置 RUNNING，无需拉起会话
    if (node.type !== 'AI') {
      return;
    }
    // 关闭下游 REJECT 节点原有的空闲会话，避免资源浪费
    if (node.sessionId) {
      await sessionService.close(node.sessionId.toString(), instance.userId.toString(), {
        suppressFallback: true,
        reason: 'workflow_node_resume',
      });
      node.sessionId = undefined;
    }
    await this.startNodeSession(instance, node);
  }

  /** 重启节点：关闭旧会话，以全新会话重启（可携带新 agentConfig 更新节点快照） */
  async restartNodeSession(
    instance: WorkflowInstanceDoc,
    node: WorkflowNodeDoc,
    payload: { agentConfig?: { acpServerType: string; modeId?: string | null; modelId?: string | null; initNewWorktree: boolean } | null },
  ): Promise<void> {
    // HUMAN/FLAG 节点无会话，重启仅需引擎置 RUNNING，无需拉起会话
    if (node.type !== 'AI') {
      return;
    }
    // 关闭旧会话
    if (node.sessionId) {
      await sessionService.close(node.sessionId.toString(), instance.userId.toString(), {
        suppressFallback: true,
        reason: 'workflow_node_restart',
      });
      node.sessionId = undefined;
    }
    // 注意：engine.ts 已在 restart 转移前将新 agentConfig 写入节点快照
    // 此处 startNodeSession 会读取最新的 node.agentConfig
    await this.startNodeSession(instance, node);
  }

  /** 节点 DONE：结束本会话（由引擎保证在下游 start 之后调用） */
  async endNodeSession(instance: WorkflowInstanceDoc, node: WorkflowNodeDoc): Promise<void> {
    if (!node.sessionId) return;
    await sessionService.close(node.sessionId.toString(), instance.userId.toString(), {
      suppressFallback: true,
      reason: 'workflow_node_done',
    });
  }

  /**
   * N-4：锁内 hook 同步回环兜底时的延迟调度。
   *
   * 必须经 `runOutsideTransitionLock`（KeyedMutex.runDetached）真正脱离 ALS 上下文，
   * 否则 setImmediate/setTimeout 仍携带「key 已持有」视图，重试只会无限撞 re-entrant。
   * 有上限（3 次）+ 指数退避；超限记录结构化告警，不再热循环。
   */
  private deferSessionFallback(
    kind: 'ended' | 'idled' | 'removed',
    sessionId: string,
    instanceId: string,
    attempt: number,
  ): void {
    const nextAttempt = attempt + 1;
    if (nextAttempt > FALLBACK_RETRY_MAX) {
      logger.warn(
        { event: 'fallback-exhausted', kind, instanceId, sessionId },
        'fallback deferred retry exhausted, creating intervention todo',
      );
      // 禁止静默丢链：超限必须留下人工介入待办
      void this.notifyFallbackExhausted(kind, sessionId, instanceId);
      return;
    }
    const delay = FALLBACK_RETRY_BASE_MS * 2 ** attempt;
    setTimeout(() => {
      void workflowEngine
        .runOutsideTransitionLock(instanceId, () => {
          if (kind === 'ended') return this.handleSessionEnded(sessionId, nextAttempt);
          if (kind === 'idled') return this.handleSessionIdled(sessionId, nextAttempt);
          return this.handleSessionRemoved(sessionId, nextAttempt);
        })
        .catch((err) => {
          logger.warn(
            { event: 'fallback-retry-failed', kind, instanceId, sessionId, attempt: nextAttempt, err },
            'fallback deferred retry failed, rescheduling',
          );
          // N-10(b)：runDetached 超时/异常不能一次性丢弃兜底链，按同一 attempt 预算继续退避重排
          this.deferSessionFallback(kind, sessionId, instanceId, nextAttempt);
        });
    }, delay);
  }

  /** 兜底重试超限：创建人工介入待办（失败只告警，不影响主流程） */
  private async notifyFallbackExhausted(
    kind: 'ended' | 'idled' | 'removed',
    sessionId: string,
    instanceId: string,
  ): Promise<void> {
    try {
      const instance = (await WorkflowInstance.findOne({
        _id: instanceId,
        deletedAt: null,
      })) as unknown as WorkflowInstanceDoc | null;
      if (!instance) {
        // N-14：超限链路最后一步也不得静默——实例已删除/不可查时留下可检索告警
        logger.warn(
          { event: 'fallback-todo-instance-missing', kind, instanceId, sessionId },
          'fallback exhausted todo skipped: instance not found',
        );
        return;
      }
      const node = instance.nodes.find((n) => n.sessionId?.toString() === sessionId);
      if (!node) {
        logger.warn(
          { event: 'fallback-todo-node-missing', kind, instanceId, sessionId },
          'fallback exhausted todo skipped: node not found',
        );
        return;
      }
      await todoService.createWorkflowInterventionTodo({
        userId: instance.userId.toString(),
        instanceId: instance._id.toString(),
        instanceName: instance.name,
        nodeId: node.nodeId,
        nodeName: node.name,
        sessionId,
        reason: `会话兜底（${kind}）重试 ${FALLBACK_RETRY_MAX} 次后仍失败，请人工介入`,
      });
    } catch (err) {
      logger.warn(
        { event: 'fallback-todo-failed', kind, instanceId, sessionId, err },
        'fallback exhausted todo failed',
      );
    }
  }

  /**
   * 执行一次转移；若命中同实例锁的 re-entrant（锁内 hook 同步回环），
   * 延迟到锁外重试并返回 false（调用方应中止本轮后续动作，由重试重新走完整逻辑）。
   */
  private async transitionOrDefer(
    kind: 'ended' | 'idled' | 'removed',
    sessionId: string,
    instance: WorkflowInstanceDoc,
    node: WorkflowNodeDoc,
    event: 'fail' | 'retryExhausted',
    payload: { reason: string; source: string },
    attempt: number,
  ): Promise<boolean> {
    try {
      await workflowEngine.transition(instance._id.toString(), node.nodeId, event, payload);
      return true;
    } catch (err) {
      if (!isReentrantLockError(err)) throw err;
      this.deferSessionFallback(kind, sessionId, instance._id.toString(), attempt);
      return false;
    }
  }

  /**
   * 会话兜底：会话 ended 且绑定节点仍 RUNNING（存续期内未转移）时，
   * 进入中断自动重试排期（close→resume→等待空闲→重发兜底提示词）。
   * 第 N 次失败按退避重排；10 次用尽 → retryExhausted（RETRY_FAILED）+ 人工介入待办。
   */
  async handleSessionEnded(sessionId: string, _attempt = 0): Promise<void> {
    const instance = (await WorkflowInstance.findOne({
      'nodes.sessionId': sessionId,
      deletedAt: null,
    })) as unknown as WorkflowInstanceDoc | null;
    if (!instance) return;
    const node = instance.nodes.find((n) => n.sessionId?.toString() === sessionId);
    if (!node || node.status !== 'RUNNING') return;

    await scheduleInterruptionRetry({
      instanceId: instance._id.toString(),
      nodeId: node.nodeId,
      sessionId,
      trigger: 'ENDED',
    });
  }

  /** 提示词组装：工作流系统提示 + 节点提示词数组 + 全部上游产物 */
  assemblePrompt(instance: WorkflowInstanceDoc, node: WorkflowNodeDoc, prompts: string[]): string {
    const parts: string[] = [WORKFLOW_SYSTEM_PROMPT, '', `## 当前节点：${node.name}`, ''];
    if (node.description) {
      parts.push(node.description, '');
    }
    for (const prompt of prompts) {
      parts.push(`- ${prompt}`);
    }

    const upstreamIds = new Set(node.dependsOn ?? []);
    const artifactLines: string[] = [];
    for (const upstream of instance.nodes.filter((n) => upstreamIds.has(n.nodeId))) {
      for (const key of getArtifactKeys(instance, upstream.nodeId, upstream.name)) {
        artifactLines.push(`### ${key}`, getValue(instance, key) ?? '', '');
      }
    }
    if (artifactLines.length > 0) {
      parts.push('', '## 上游产物', '', ...artifactLines);
    }

    // 工作流追加提示词：按 key 升序、每个 key 一段（Map 天然去重，同 key 只插入一次）
    const promptsMap = this.readAdditionalPrompts(instance);
    const keys = [...promptsMap.keys()].sort();
    if (keys.length > 0) {
      parts.push('', '## 追加提示词');
      for (const key of keys) {
        parts.push('', `### ${key}`, promptsMap.get(key) ?? '');
      }
    }
    return parts.join('\n').trim();
  }

  /** 追加提示词归一化：兼容 Mongoose Map 与 lean 普通对象 */
  private readAdditionalPrompts(instance: WorkflowInstanceDoc): Map<string, string> {
    const raw = instance.additionalPrompts;
    if (!raw) return new Map();
    if (raw instanceof Map) {
      const result = new Map<string, string>();
      for (const [key, value] of raw.entries()) {
        if (typeof value === 'string') result.set(key, value);
      }
      return result;
    }
    const result = new Map<string, string>();
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') result.set(key, value);
    }
    return result;
  }

  /** 幂等 upsert 平台工作流工具服务（transport/source: platform），返回其 _id */
  private async ensureWorkflowToolsServer(userId: string): Promise<string> {
    try {
      const server = await McpServer.findOneAndUpdate(
        { userId, name: PLATFORM_SERVER_NAME },
        {
          $setOnInsert: {
            userId,
            name: PLATFORM_SERVER_NAME,
            transport: 'platform',
            source: 'platform',
            enabled: true,
          },
        },
        { upsert: true, returnDocument: 'after' },
      );
      return server._id.toString();
    } catch (err: unknown) {
      // E11000 duplicate key error — race condition: another request inserted first
      if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
        const existing = await McpServer.findOne({ userId, name: PLATFORM_SERVER_NAME }).lean();
        if (existing) return existing._id.toString();
      }
      throw err;
    }
  }
}

export const workflowOrchestrator = new WorkflowOrchestrator();
