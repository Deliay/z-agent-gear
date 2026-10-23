import { sessionService } from '../session.js';
import { todoService } from '../todo-service.js';
import { ConfiguredWorkflow } from '../../models/configured-workflow.js';
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

/** 工作流系统提示（注入到每个 AI 节点会话提示词首位） */
export const WORKFLOW_SYSTEM_PROMPT =
  '你身处一个工作流系统，你需要合理使用工具拿到你需要的信息，然后在完成工作时也需要使用工具对当前节点进行操作。';

/** 会话兜底提示词（面向 LLM：会话结束但节点未转移时 resume 并发送） */
export const FALLBACK_PROMPT =
  '你身处一个自动化工作流系统，当前会话绑定到一个工作流节点。系统检测到会话已结束，但节点状态仍未推进。' +
  '你必须使用提供的工作流 MCP 工具对当前节点执行操作：工作已完成时调用 completeCurrentNode（产物通过黑板工具写入）；' +
  '需要上游返工时调用 rejectCurrentNode 并给出明确原因。不要只输出文本而不调用工具。';

/** 空闲停滞提醒：turn 结束（如权限审批超时）但节点未推进时使用（会话仍存活，无需 resume） */
export const IDLE_NUDGE_PROMPT =
  '你身处一个自动化工作流系统，当前会话绑定到一个工作流节点。系统检测到本轮执行已停止（可能因权限审批超时），但节点状态仍未推进。' +
  '你必须继续执行任务，并使用提供的工作流 MCP 工具对当前节点执行操作：工作已完成时调用 completeCurrentNode（产物通过黑板工具写入）；' +
  '需要上游返工时调用 rejectCurrentNode 并给出明确原因；确实无法继续时调用 failCurrentNode 说明原因。不要只输出文本而不调用工具。';

/** 转为 slug（小写字母/数字/连字符）；无 ASCII 字符时返回空串由调用方兜底 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

interface ConfiguredNodeLike {
  nodeKey: string;
  prompts?: string[] | null;
  requiresWorktree: boolean;
  agentConfig?: {
    acpServerType: string;
    modeId?: string | null;
    modelId?: string | null;
    initNewWorktree: boolean;
  } | null;
}

/** N-4：锁内兜底回环的延迟重试上限与退避基数（100ms/200ms/400ms） */
const FALLBACK_RETRY_MAX = 3;
const FALLBACK_RETRY_BASE_MS = 100;

function isReentrantLockError(err: unknown): boolean {
  return (err as Error)?.message?.includes('KeyedMutex re-entrant lock detected') === true;
}

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
   * 首次补发提醒提示词让 AI 继续（若卡在权限，重试会再次弹出审批待办，即现场提醒）；
   * 再次停滞（与 handleSessionEnded 共享 fallbackSent 计数）→ 升级 FAILED 并创建
   * immediate 优先级「人工介入」待办（强提醒）。
   */
  async handleSessionIdled(sessionId: string, attempt = 0): Promise<void> {
    const instance = (await WorkflowInstance.findOne({
      'nodes.sessionId': sessionId,
      deletedAt: null,
    })) as unknown as WorkflowInstanceDoc | null;
    if (!instance) return;
    const node = instance.nodes.find((n) => n.sessionId?.toString() === sessionId);
    if (!node || (node.status !== 'RUNNING' && node.status !== 'REWORK')) return;

    if (node.fallbackSent) {
      const transitioned = await this.transitionOrDefer(
        'idled',
        sessionId,
        instance,
        node,
        'fail',
        {
          reason: '会话再次进入空闲且节点未推进（可能因权限审批超时等原因停止），需要人工介入',
          source: 'SESSION_STUCK',
        },
        attempt,
      );
      if (!transitioned) return;
      await todoService.createWorkflowInterventionTodo({
        userId: instance.userId.toString(),
        instanceId: instance._id.toString(),
        instanceName: instance.name,
        nodeId: node.nodeId,
        nodeName: node.name,
        sessionId,
        reason: '会话再次进入空闲且节点未推进（可能因权限审批超时等原因停止）',
      });
      return;
    }

    // N-5：与 handleSessionEnded 共享 fallbackSent 计数，必须同样使用字段级条件更新，
    // 避免整文档 save() 覆盖并发转移（idled 分支允许 RUNNING/REWORK）。
    const updated = await WorkflowInstance.updateOne(
      {
        _id: instance._id,
        deletedAt: null,
        nodes: {
          $elemMatch: {
            nodeId: node.nodeId,
            sessionId: node.sessionId,
            status: { $in: ['RUNNING', 'REWORK'] },
          },
        },
      },
      { $set: { 'nodes.$.fallbackSent': true } },
    );
    if (!updated?.modifiedCount) return;
    node.fallbackSent = true;
    // 会话仍存活（idling，映射仍在）：直接补发提醒提示词即可，无需 resume
    await sessionService.addMessage(sessionId, {
      direction: 'input',
      type: 'text',
      content: IDLE_NUDGE_PROMPT,
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
    const configuredNode = await this.loadNodeConfig(instance, node);
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

    const session = await sessionService.create(instance.userId.toString(), {
      controllerId: instance.controllerId.toString(),
      acpServerType: agentConfig.acpServerType,
      workspaceId: instance.workspaceId.toString(),
      enableWorktree,
      worktreeBranchSuffix: enableWorktree ? `${instanceSlug}/${stageSlug}` : undefined,
      existingWorktreePath,
      workflowInstanceId: instance._id.toString(),
      workflowNodeId: node.nodeId,
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

  /** 提取节点配置的初始 mode/model（随 acp:start/acp:resume 带内下发）；无配置返回 undefined */
  private initialModeModel(agentConfig?: ConfiguredNodeLike['agentConfig']): { modeId?: string; modelId?: string } | undefined {
    if (!agentConfig || (!agentConfig.modeId && !agentConfig.modelId)) return undefined;
    return {
      ...(agentConfig.modeId ? { modeId: agentConfig.modeId } : {}),
      ...(agentConfig.modelId ? { modelId: agentConfig.modelId } : {}),
    };
  }

  /** 节点进入 REWORK：resume 原会话（初始 mode/model 带内下发）、重发打回原因 */
  async reworkNodeSession(
    instance: WorkflowInstanceDoc,
    node: WorkflowNodeDoc,
    payload: TransitionPayload,
  ): Promise<void> {
    if (!node.sessionId) return;
    const sessionId = node.sessionId.toString();
    const configuredNode = await this.loadNodeConfig(instance, node);
    await sessionService.resume(
      sessionId,
      instance.userId.toString(),
      this.initialModeModel(configuredNode.agentConfig),
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
      console.warn(
        `[workflow] ${kind} fallback deferred retry exhausted after ${FALLBACK_RETRY_MAX} attempts ` +
          `(instance=${instanceId}, session=${sessionId}); creating intervention todo`,
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
          console.warn(
            `[workflow] ${kind} fallback deferred retry failed ` +
              `(instance=${instanceId}, session=${sessionId}, attempt=${nextAttempt}), rescheduling:`,
            (err as Error).message,
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
      const node = instance?.nodes.find((n) => n.sessionId?.toString() === sessionId);
      if (!instance || !node) return;
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
      console.warn(
        `[workflow] ${kind} fallback exhausted todo failed (instance=${instanceId}, session=${sessionId}):`,
        (err as Error).message,
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
    event: 'fail',
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
   * resume 会话并发送兜底提示词。每节点仅提醒 1 次（fallbackSent）；
   * 提醒后仍停止 → 节点升级为 FAILED，阻断流程等待人工介入。
   */
  async handleSessionEnded(sessionId: string, attempt = 0): Promise<void> {
    const instance = (await WorkflowInstance.findOne({
      'nodes.sessionId': sessionId,
      deletedAt: null,
    })) as unknown as WorkflowInstanceDoc | null;
    if (!instance) return;
    const node = instance.nodes.find((n) => n.sessionId?.toString() === sessionId);
    if (!node || node.status !== 'RUNNING') return;

    if (node.fallbackSent) {
      await this.transitionOrDefer(
        'ended',
        sessionId,
        instance,
        node,
        'fail',
        {
          reason: '会话在系统提醒后再次停止，节点未能推进',
          source: 'SESSION_STUCK',
        },
        attempt,
      );
      return;
    }

    // N-1④：只做字段级更新，避免整文档 save() 与并发转移互覆
    const updated = await WorkflowInstance.updateOne(
      {
        _id: instance._id,
        deletedAt: null,
        nodes: {
          $elemMatch: {
            nodeId: node.nodeId,
            sessionId: node.sessionId,
            status: 'RUNNING',
          },
        },
      },
      { $set: { 'nodes.$.fallbackSent': true } },
    );
    if (!updated?.modifiedCount) return;
    node.fallbackSent = true;
    // 兜底 resume 同样带内下发节点配置的初始 mode/model；
    // 配置读取失败不阻断兜底（仍以默认配置 resume）
    let initial: { modeId?: string; modelId?: string } | undefined;
    try {
      const configuredNode = await this.loadNodeConfig(instance, node);
      initial = this.initialModeModel(configuredNode.agentConfig);
    } catch { /* ignore — fallback resume must not be blocked by config lookup */ }
    await sessionService.resume(sessionId, instance.userId.toString(), initial);
    await sessionService.addMessage(sessionId, {
      direction: 'input',
      type: 'text',
      content: FALLBACK_PROMPT,
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
        { upsert: true, new: true },
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

  /**
   * 读取节点配置：优先使用实例节点快照（prompts/agentConfig/requiresWorktree）；
   * 快照字段缺失（一期旧实例）时回退 loadConfiguredNode 按 nodeKey 回查配置。
   */
  private async loadNodeConfig(
    instance: WorkflowInstanceDoc,
    node: WorkflowNodeDoc,
  ): Promise<ConfiguredNodeLike> {
    const nodeWithSnapshot = node as unknown as {
      prompts?: string[] | null;
      requiresWorktree?: boolean;
      agentConfig?: ConfiguredNodeLike['agentConfig'];
    };
    if (nodeWithSnapshot.prompts !== undefined || nodeWithSnapshot.agentConfig !== undefined) {
      return {
        nodeKey: node.nodeKey,
        prompts: nodeWithSnapshot.prompts ?? null,
        requiresWorktree: nodeWithSnapshot.requiresWorktree ?? false,
        agentConfig: nodeWithSnapshot.agentConfig ?? null,
      };
    }
    return this.loadConfiguredNode(instance, node);
  }

  private async loadConfiguredNode(
    instance: WorkflowInstanceDoc,
    node: WorkflowNodeDoc,
  ): Promise<ConfiguredNodeLike> {
    const configured = await ConfiguredWorkflow.findById(instance.configuredWorkflowId.toString()).lean();
    if (!configured) {
      throw new Error(`实例引用的已配置工作流不存在：${instance.configuredWorkflowId.toString()}`);
    }
    const configuredNode = (configured.nodes as ConfiguredNodeLike[]).find((n) => n.nodeKey === node.nodeKey);
    if (!configuredNode) {
      throw new Error(`已配置工作流中不存在节点「${node.name}」（${node.nodeKey}）`);
    }
    return configuredNode;
  }
}

export const workflowOrchestrator = new WorkflowOrchestrator();
