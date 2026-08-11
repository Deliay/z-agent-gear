import { sessionService } from '../session.js';
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

class WorkflowOrchestrator {
  /** 注册为引擎 hook + 会话结束兜底回调（服务启动时调用一次） */
  register(): void {
    workflowEngine.registerHooks({
      onNodeStart: (instance, node) => this.startNodeSession(instance, node),
      onNodeRework: (instance, node, payload) => this.reworkNodeSession(instance, node, payload),
      onNodeResume: (instance, node) => this.resumeNodeSession(instance, node),
      onNodeDone: (instance, node) => this.endNodeSession(instance, node),
    });
    sessionService.onSessionEnded((sessionId) => this.handleSessionEnded(sessionId));
  }

  /** AI 节点 READY→RUNNING：组装提示词 → 创建打标会话（按阶段 worktree）→ 发送提示词 */
  async startNodeSession(instance: WorkflowInstanceDoc, node: WorkflowNodeDoc): Promise<void> {
    const configuredNode = await this.loadNodeConfig(instance, node);
    const agentConfig = configuredNode.agentConfig;
    if (!agentConfig) {
      throw new Error(`节点「${node.name}」（${node.nodeKey}）缺少 Agent 配置，无法拉起会话`);
    }

    const prompt = this.assemblePrompt(instance, node, configuredNode.prompts ?? []);

    // 阶段 worktree 后缀：<instance-slug>/<stage-slug>（同阶段节点会话复用同一 worktree）
    const instanceSlug = slugify(instance.name) || instance._id.toString();
    const stageSlug = slugify(node.stage) || 'stage';
    const enableWorktree = Boolean(configuredNode.requiresWorktree && agentConfig.initNewWorktree);

    const session = await sessionService.create(instance.userId.toString(), {
      controllerId: instance.controllerId.toString(),
      acpServerType: agentConfig.acpServerType,
      workspaceId: instance.workspaceId.toString(),
      enableWorktree,
      worktreeBranchSuffix: enableWorktree ? `${instanceSlug}/${stageSlug}` : undefined,
      workflowInstanceId: instance._id.toString(),
      workflowNodeId: node.nodeId,
      // 节点会话自动装配平台工作流工具服务 + 管理工作流管理工具集（AI 可通过 admin 工具集完成编排）
      mcpServerIds: [
        await this.ensureWorkflowToolsServer(instance.userId.toString()),
        await ensureAdminToolsServer(instance.userId.toString()),
      ],
    });
    node.sessionId = session.id as string;

    // 若节点配置指定了 Mode，则在会话创建后应用
    if (agentConfig.modeId && node.sessionId) {
      try {
        await sessionService.setMode(node.sessionId as string, instance.userId.toString(), agentConfig.modeId);
      } catch (err) {
        console.warn(
          `节点「${node.name}」（${node.nodeKey}）应用 Mode「${agentConfig.modeId}」失败：`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    await sessionService.addMessage(node.sessionId as string, {
      direction: 'input',
      type: 'text',
      content: prompt,
    });
  }

  /** 节点进入 REWORK：resume 原会话并发送打回原因 */
  async reworkNodeSession(
    instance: WorkflowInstanceDoc,
    node: WorkflowNodeDoc,
    payload: TransitionPayload,
  ): Promise<void> {
    if (!node.sessionId) return;
    const sessionId = node.sessionId.toString();
    await sessionService.resume(sessionId, instance.userId.toString());
    await sessionService.addMessage(sessionId, {
      direction: 'input',
      type: 'text',
      content:
        `你的工作流节点产出被下游节点打回，需要返工。打回原因：${payload.reason ?? '（未提供）'}。\n` +
        '请根据打回原因修订产出，通过工作流工具重新写入产物后调用 completeCurrentRework 完成返工。\n' +
        '若返工中发现问题根源在更上游（本节点无法独立修正），可调用 rejectCurrentNode 将本节点打回并触发上游返工。',
    });
  }

  /** REJECT→RUNNING：通知其用 MCP 工具重新获取上游产物后继续 */
  async resumeNodeSession(instance: WorkflowInstanceDoc, node: WorkflowNodeDoc): Promise<void> {
    if (!node.sessionId) return;
    await sessionService.addMessage(node.sessionId.toString(), {
      direction: 'input',
      type: 'text',
      content:
        '上游节点已完成返工，其产物已更新。请使用工作流工具重新获取最新产物后继续你的工作；' +
        '完成后调用 completeCurrentNode，仍需上游调整时调用 rejectCurrentNode。',
    });
  }

  /** 节点 DONE：结束本会话（由引擎保证在下游 start 之后调用） */
  async endNodeSession(instance: WorkflowInstanceDoc, node: WorkflowNodeDoc): Promise<void> {
    if (!node.sessionId) return;
    await sessionService.close(node.sessionId.toString(), instance.userId.toString());
  }

  /**
   * 会话兜底：会话 ended 且绑定节点仍 RUNNING（存续期内未转移）时，
   * resume 会话并发送兜底提示词。每节点仅提醒 1 次（fallbackSent）；
   * 提醒后仍停止 → 节点升级为 FAILED，阻断流程等待人工介入。
   */
  async handleSessionEnded(sessionId: string): Promise<void> {
    const instance = (await WorkflowInstance.findOne({
      'nodes.sessionId': sessionId,
      deletedAt: null,
    })) as unknown as WorkflowInstanceDoc | null;
    if (!instance) return;
    const node = instance.nodes.find((n) => n.sessionId?.toString() === sessionId);
    if (!node || node.status !== 'RUNNING') return;

    if (node.fallbackSent) {
      await workflowEngine.transition(instance._id.toString(), node.nodeId, 'fail', {
        reason: '会话在系统提醒后再次停止，节点未能推进',
        source: 'SESSION_STUCK',
      });
      return;
    }

    node.fallbackSent = true;
    await instance.save();
    await sessionService.resume(sessionId, instance.userId.toString());
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
    return parts.join('\n').trim();
  }

  /** 幂等 upsert 平台工作流工具服务（transport/source: platform），返回其 _id */
  private async ensureWorkflowToolsServer(userId: string): Promise<string> {
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
