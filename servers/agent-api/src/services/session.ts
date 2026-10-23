import mongoose from 'mongoose';
import path from 'path';
import { GraphQLError } from 'graphql';
import { Session } from '../models/session.js';
import { AcpMessage } from '../models/acp-message.js';
import { Controller } from '../models/controller.js';
import { CloudHost } from '../models/cloud-host.js';
import { ControllerWorkspace } from '../models/controller-workspace.js';
import { getRedisClient } from '../middleware/redis.js';
import { McpServer } from '../models/mcp-server.js';
import { mcpEndpointService } from './mcp-endpoint.js';
import { ensureCloudHostToolsServer, CLOUD_HOST_TOOLS_SERVER_NAME } from './cloud-host-tools.js';
import { sanitizeWorkspaceName, generateWorktreeSuffix, resolveEffectiveWorktreeDir, worktreeScopePrefix, normalizeForCompare } from './workflow/worktree-utils.js';

const ACP_STOP_ACK_TIMEOUT_MS = 10_000;

export interface ControllerDefaultMcpSnapshot {
  useAllEnabled?: boolean | null;
  serverIds?: Array<string | null | undefined> | null;
}

/**
 * 解析新建会话的初始 MCP 集合（纯函数，便于单测）：
 * - explicitIds !== undefined（含 []）：以调用方为准，原样返回；
 * - 未传 + useAllEnabled !== false（缺省视为 true）：注入全部已启用 MCP（动态语义，不物化 id 列表）；
 * - 未传 + useAllEnabled === false：仅注入 serverIds 中仍存在且 enabled 的子集。
 * 云会话的 agent-cloud-host-tools 由调用方在解析后并入并去重。
 */
export function resolveInitialMcpServerIds(
  defaultMcp: ControllerDefaultMcpSnapshot | null | undefined,
  explicitIds: string[] | undefined,
  enabledServerIds: string[],
): string[] {
  if (explicitIds !== undefined) {
    return [...explicitIds];
  }
  const enabled = enabledServerIds.map(String);
  if (defaultMcp?.useAllEnabled !== false) {
    return enabled;
  }
  const enabledSet = new Set(enabled);
  const subset = (defaultMcp.serverIds ?? [])
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .map((id) => String(id))
    .filter((id) => enabledSet.has(id));
  return Array.from(new Set(subset));
}

export class SessionService {
  /** 会话进入 ended 时的回调（由工作流 Orchestrator 注册用于兜底检查，避免循环依赖） */
  private sessionEndedCallback?: (sessionId: string) => void | Promise<void>;
  /** 会话被移除（start/resume 失败清理）时的回调（由工作流 Orchestrator 注册用于节点失败升级） */
  private sessionRemovedCallback?: (sessionId: string) => void | Promise<void>;
  /** 会话 turn 结束进入空闲（promptCompleted）时的回调（由工作流 Orchestrator 注册用于停滞检测） */
  private sessionIdledCallback?: (sessionId: string) => void | Promise<void>;

  onSessionEnded(callback: (sessionId: string) => void | Promise<void>): void {
    this.sessionEndedCallback = callback;
  }

  onSessionRemoved(callback: (sessionId: string) => void | Promise<void>): void {
    this.sessionRemovedCallback = callback;
  }

  onSessionIdled(callback: (sessionId: string) => void | Promise<void>): void {
    this.sessionIdledCallback = callback;
  }

  /** controller-api 清理失败会话（publish removed）后由 SSE 订阅层触发 */
  async notifySessionRemoved(sessionId: string): Promise<void> {
    await this.sessionRemovedCallback?.(sessionId);
  }

  /** prompt 完成（running→idling 且带 promptCompleted 标记）后由 SSE 订阅层触发 */
  async notifySessionIdled(sessionId: string): Promise<void> {
    await this.sessionIdledCallback?.(sessionId);
  }

  async findAllByUser(
    userId: string,
    options: { includeWorkflowSessions?: boolean; controllerId?: string } = {},
  ): Promise<Record<string, unknown>[]> {
    // 默认排除工作流节点会话（workflowInstanceId != null）
    const filter: Record<string, unknown> = options.includeWorkflowSessions
      ? { userId }
      : { userId, workflowInstanceId: null };
    if (options.controllerId) {
      filter.controllerId = options.controllerId;
    }
    const sessions = await Session.find(filter).sort({ createdAt: -1 }).lean();
    return sessions.map(this.mapSession.bind(this));
  }

  async findById(id: string, userId: string): Promise<Record<string, unknown> | null> {
    const session = await Session.findOne({ _id: id, userId }).lean();
    if (!session) return null;
    return this.mapSession(session);
  }

  /**
   * A-2/B15：会话写路径统一只读判定。
   * 云电脑（Controller.type=cloud）缺失/软删除/非 RUNNING（STOPPING/STOPPED/FAILED）→ `session is ended`；
   * 普通本地/GitHub 会话不受影响。
   */
  async assertSessionWritable(sessionId: string, userId: string): Promise<void> {
    const session = await Session.findOne({ _id: sessionId, userId }).lean();
    if (!session) throw new Error('Session not found');
    await this.assertControllerWritable(session.controllerId, userId);
  }

  private async assertControllerWritable(controllerId: unknown, userId: string): Promise<void> {
    const controllerRef = controllerId as mongoose.Types.ObjectId;
    const controller = await Controller.findOne({
      _id: controllerRef,
      userId,
    }).lean();
    if (controller?.type !== 'cloud') return;
    const host = await CloudHost.findOne({
      controllerId: controllerRef,
      userId,
      deletedAt: null,
    }).lean();
    if (
      !host ||
      host.status === 'STOPPING' ||
      host.status === 'STOPPED' ||
      host.status === 'FAILED'
    ) {
      throw new Error('session is ended');
    }
  }

  async create(userId: string, input: {
    controllerId: string;
    acpServerType: string;
    workspaceId: string;
    enableWorktree?: boolean;
    worktreeBranchSuffix?: string;
    existingWorktreePath?: string;
    mcpServerIds?: string[];
    /** 工作流内部打标（引擎编排节点会话时使用，不暴露到 GraphQL CreateSessionInput） */
    workflowInstanceId?: string;
    workflowNodeId?: string;
    /** 初始工作模式/模型（工作流节点配置，harness 会话启动时应用） */
    modeId?: string;
    modelId?: string;
    /** 内部编排：允许在云电脑 STARTING 窗口创建默认会话（ready 回调原子写 RUNNING+defaultSessionId） */
    allowStartingCloudHost?: boolean;
  }): Promise<Record<string, unknown>> {
    const controller = await Controller.findOne({ _id: input.controllerId, userId }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }
    const cloudHostRunning = (host: { status?: string } | null): boolean =>
      host?.status === 'RUNNING' ||
      (input.allowStartingCloudHost === true && host?.status === 'STARTING');
    if (controller.type === 'cloud') {
      const host = await CloudHost.findOne({
        controllerId: input.controllerId,
        userId,
        deletedAt: null,
      }).lean();
      if (!host || !cloudHostRunning(host as { status?: string })) {
        throw new Error('cloud host is not running');
      }
      // A-11：会话 ACP 工具必须落在云电脑已启用的 harnessTypes 映射内。
      const harnessAcpTypes: Record<string, string> = { OPENCODE: 'opencode' };
      const allowed = ((host.harnessTypes ?? []) as string[])
        .map((type) => harnessAcpTypes[type])
        .filter((type): type is string => Boolean(type));
      if (allowed.length > 0 && !allowed.includes(input.acpServerType)) {
        throw new Error(`unsupported harness type: ${input.acpServerType}`);
      }
    }

    // 未显式指定（含 undefined）时按控制器 defaultMcp 解析；显式空数组表示不注入。
    let mcpServerIds = input.mcpServerIds;
    if (mcpServerIds === undefined) {
      // 平台内置 agent-cloud-host-tools 仅由云会话自动并入（与前端可选列表口径一致），
      // 不作为「默认 MCP」候选，避免非云会话被注入云主机工具。
      const enabledServers = await McpServer.find({
        userId,
        enabled: true,
        name: { $ne: CLOUD_HOST_TOOLS_SERVER_NAME },
      })
        .select('_id')
        .lean();
      mcpServerIds = resolveInitialMcpServerIds(
        (controller as unknown as { defaultMcp?: ControllerDefaultMcpSnapshot }).defaultMcp,
        undefined,
        enabledServers.map((server) => String(server._id)),
      );
    }

    // 云会话自动装配云主机平台 MCP 工具（workload_list/workload_install）；非云会话不装配。
    if (controller.type === 'cloud') {
      const cloudToolsId = await ensureCloudHostToolsServer(userId);
      mcpServerIds = Array.from(new Set([...(mcpServerIds ?? []), cloudToolsId]));
    }

    const workspace = await ControllerWorkspace.findOne({ _id: input.workspaceId, userId, controllerId: input.controllerId }).lean();
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    if (input.existingWorktreePath && input.enableWorktree) {
      throw new GraphQLError('existingWorktreePath and enableWorktree are mutually exclusive', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    let cwd = workspace.path;
    let worktreePath: string | undefined;
    let worktreeBranch: string | undefined;
    const redis = getRedisClient();

    if (input.existingWorktreePath) {
      // Reuse an existing worktree (no git:worktree:add needed).
      // The path must belong to this workspace's worktree scope, and the
      // session must NOT record worktreeBranch — that field marks ownership
      // and would make delete() run git cleanup on a shared worktree.
      const effectiveDir = resolveEffectiveWorktreeDir(controller as { worktreeDir?: string | null } | null);
      if ((effectiveDir.startsWith('~/') || effectiveDir === '~') && !(controller as any).homeDir) {
        // 旧版控制器不上报 homeDir，且生效目录含 `~`：无法可靠展开，明确报错引导升级/配置绝对路径，不静默放行
        throw new GraphQLError(
          'Worktree 目录包含 `~` 但控制器未上报 homeDir，无法校验路径归属。请升级控制器，或在设置页将「Git Worktree 工作目录」配置为绝对路径。',
          { extensions: { code: 'BAD_USER_INPUT' } },
        );
      }
      // 使用共享工具构造校验前缀，与 createWorkflowWorktree 的路径生成口径一致（展开 `~` + 清洗工作区名 + 归一化）
      const scopePrefix = normalizeForCompare(
        worktreeScopePrefix(effectiveDir, workspace.name, (controller as any).homeDir),
        (controller as any).platform,
      );
      if (!normalizeForCompare(input.existingWorktreePath, (controller as any).platform).startsWith(scopePrefix)) {
        throw new GraphQLError('existingWorktreePath does not belong to this workspace', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      cwd = input.existingWorktreePath;
      worktreePath = input.existingWorktreePath;
    } else if (input.enableWorktree && input.worktreeBranchSuffix && workspace.name) {
      // Create a new worktree via controller git:worktree:add
      // 使用随机后缀天然去重，避免多实例/多节点并发碰撞
      const worktreeDir = resolveEffectiveWorktreeDir(controller as { worktreeDir?: string | null } | null);
      const safeName = sanitizeWorkspaceName(workspace.name);
      const uniqueSuffix = generateWorktreeSuffix();
      const branch = `${safeName}/${input.worktreeBranchSuffix}-${uniqueSuffix}`;
      const wtPath = path.join(worktreeDir, safeName, `${input.worktreeBranchSuffix}-${uniqueSuffix}`);

      const requestId = `wt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await redis.publish('session:command', JSON.stringify({
        type: 'git:worktree:add',
        requestId,
        controllerId: input.controllerId,
        repoPath: workspace.path,
        worktreePath: wtPath,
        branch,
      }));

      let added = false;
      for (let i = 0; i < 30; i++) {
        const result = await redis.get(`git:worktree:add:${requestId}`);
        if (result) {
          const parsed = JSON.parse(result);
          await redis.del(`git:worktree:add:${requestId}`);

          if (!parsed.success) {
            throw new Error(`WORKTREE_ADD_FAILED: ${parsed.error}`);
          }

          const resolvedPath = parsed.worktreePath || wtPath;
          cwd = resolvedPath;
          worktreePath = resolvedPath;
          worktreeBranch = branch;
          added = true;
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
      }

      if (!added) {
        throw new Error('WORKTREE_ADD_FAILED: 等待 git worktree add 超时');
      }
    }

    // Validate selected MCP servers up front so an invalid selection fails the
    // mutation instead of silently creating a session without MCP.
    if (mcpServerIds && mcpServerIds.length > 0) {
      const selectable = await McpServer.countDocuments({
        _id: { $in: mcpServerIds },
        userId,
        enabled: true,
      });
      if (selectable !== mcpServerIds.length) {
        throw new Error('MCP_SERVER_NOT_FOUND: some selected MCP servers are invalid or disabled');
      }
    }

    // A-3：创建会话与 stop/terminal 无原子性——长耗时 worktree/MCP 流程结束后、
    // 落库前复查云电脑仍在允许状态，缩小「终态后残留 creating 幽灵会话」窗口。
    if (controller.type === 'cloud') {
      const stillRunning = await CloudHost.findOne({
        controllerId: input.controllerId,
        userId,
        deletedAt: null,
        ...(input.allowStartingCloudHost === true
          ? { status: { $in: ['STARTING', 'RUNNING'] } }
          : { status: 'RUNNING' }),
      }).lean();
      if (!stillRunning) {
        throw new Error('cloud host is not running');
      }
    }

    const session = await Session.create({
      userId,
      controllerId: input.controllerId,
      controllerName: controller.name,
      acpServerType: input.acpServerType as 'opencode',
      status: 'creating',
      cwd,
      worktreePath,
      worktreeBranch,
      ...(input.workflowInstanceId ? { workflowInstanceId: input.workflowInstanceId } : {}),
      ...(input.workflowNodeId ? { workflowNodeId: input.workflowNodeId } : {}),
    });

    // A-3 残留窗口（毫秒级）：insert 之后立即回查；若 stop/terminal 已在复查与 insert 之间收口，
    // 将刚创建的会话置 ENDED 并拒绝，避免 creating 幽灵会话。
    if (controller.type === 'cloud') {
      const afterInsert = await CloudHost.findOne({
        controllerId: input.controllerId,
        userId,
        deletedAt: null,
        ...(input.allowStartingCloudHost === true
          ? { status: { $in: ['STARTING', 'RUNNING'] } }
          : { status: 'RUNNING' }),
      }).lean();
      if (!afterInsert) {
        await Session.updateOne(
          { _id: session._id },
          { $set: { status: 'ended', endedAt: new Date() } },
        );
        throw new Error('cloud host is not running');
      }
    }

    // Create MCP endpoint if mcpServerIds provided (user explicitly selected MCP servers)
    let mcpEndpoint: { token: string; serverNames: string[] } | undefined;
    if (mcpServerIds && mcpServerIds.length > 0) {
      try {
        mcpEndpoint = await mcpEndpointService.createEndpoint(
          session._id.toString(),
          userId,
          mcpServerIds,
          // 工作流节点会话：token 扩展节点作用域
          input.workflowInstanceId && input.workflowNodeId
            ? { instanceId: input.workflowInstanceId, nodeId: input.workflowNodeId }
            : undefined,
        );
      } catch (err) {
        // 当会话显式携带 mcpServerIds 时 fail-fast：删除已创建的会话并抛错
        await Session.deleteOne({ _id: session._id });
        throw new Error(
          `MCP endpoint 创建失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Notify controller-api to start ACP session via Redis Pub/Sub
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:start',
      sessionId: session._id.toString(),
      controllerId: input.controllerId,
      serverType: input.acpServerType,
      cwd,
      mcpEndpoint,
      ...(input.modeId ? { modeId: input.modeId } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
    }));

    return this.mapSession(session.toObject());
  }

  /** 云电脑停止/终态：该主机下所有非 ENDED 会话批量结束（只读，消息保留）。 */
  async endByController(controllerId: string, userId: string): Promise<number> {
    const result = await Session.updateMany(
      { controllerId, userId, status: { $ne: 'ended' } },
      { $set: { status: 'ended', endedAt: new Date() } },
    );
    return result.modifiedCount ?? 0;
  }

  async updateStatus(id: string, userId: string, status: string, externalSessionId?: string): Promise<boolean> {
    const updateData: Record<string, unknown> = { status };
    if (externalSessionId) {
      updateData.externalSessionId = externalSessionId;
    }
    if (status === 'ended') {
      updateData.endedAt = new Date();
    }

    const result = await Session.findOneAndUpdate(
      { _id: id, userId },
      updateData,
      { new: true },
    );

    if (result) {
      // Update Redis cache
      const redis = getRedisClient();
      await redis.set(`session:${id}:status`, status);
      if (status === 'ended') {
        await redis.del(`session:${id}:status`);
        // 工作流兜底检查（节点仍 RUNNING 且未转移时 resume 并发送兜底提示词）
        await this.sessionEndedCallback?.(id);
      }
    }

    return !!result;
  }

  async setMode(sessionId: string, userId: string, modeId: string): Promise<boolean> {
    const session = await Session.findOne({ _id: sessionId, userId }).lean();
    if (!session) return false;
    if (session.status !== 'idling') return false;

    const redis = getRedisClient();
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:set-mode',
      sessionId,
      modeId,
    }));
    // 同步更新 Session 文档缓存，保证前端查询为最新值
    await Session.updateOne({ _id: sessionId, userId }, { currentModeId: modeId });
    return true;
  }

  async setModel(sessionId: string, userId: string, modelId: string): Promise<boolean> {
    const session = await Session.findOne({ _id: sessionId, userId }).lean();
    if (!session) return false;
    if (session.status !== 'idling') return false;

    const redis = getRedisClient();
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:set-model',
      sessionId,
      modelId,
    }));
    // 同步更新 Session 文档缓存，保证前端查询为最新值
    await Session.updateOne({ _id: sessionId, userId }, { currentModelId: modelId });
    return true;
  }

  async setConfigOption(sessionId: string, userId: string, configId: string, value: string): Promise<boolean> {
    const session = await Session.findOne({ _id: sessionId, userId }).lean();
    if (!session) return false;
    if (session.status !== 'idling') return false;
    const configOptions = (session as Record<string, unknown>).configOptions as unknown[] | undefined;
    if (!configOptions || configOptions.length === 0) return false;

    const redis = getRedisClient();
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:set-config-option',
      sessionId,
      configId,
      value,
    }));
    return true;
  }

  async cancelGeneration(sessionId: string, userId: string): Promise<boolean> {
    const session = await Session.findOne({ _id: sessionId, userId }).lean();
    if (!session) return false;

    // A-2：只读留档会话不得继续（cancel 亦属于 session:command 写路径）。
    await this.assertControllerWritable(session.controllerId, userId);

    const redis = getRedisClient();
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:cancel',
      sessionId,
    }));
    return true;
  }

  async resume(id: string, userId: string, initial?: { modeId?: string; modelId?: string }): Promise<{ success: boolean; status: string; error?: string }> {
    const session = await Session.findOne({ _id: id, userId }).lean();
    if (!session) {
      return { success: false, status: 'ended', error: 'Session not found' };
    }
    // ended/disconnected 均可恢复（disconnected 为 Controller 临时断连，重连后可 resume）
    if (session.status !== 'ended' && session.status !== 'disconnected') {
      return { success: false, status: session.status, error: 'Session is not ended' };
    }

    // 云电脑终态后会话只读：历史消息保留，但不允许继续（不新增 Session 字段）。
    const controller = await Controller.findOne({
      _id: session.controllerId,
      userId,
    }).lean();
    if (controller?.type === 'cloud') {
      const host = await CloudHost.findOne({
        controllerId: session.controllerId,
        userId,
        deletedAt: null,
      }).lean();
      if (
        !host ||
        host.status === 'STOPPING' ||
        host.status === 'STOPPED' ||
        host.status === 'FAILED'
      ) {
        return { success: false, status: 'ended', error: 'session is ended' };
      }
    }

    // Re-issue a fresh MCP endpoint (do not reuse the revoked token)
    let mcpEndpoint: { token: string; serverNames: string[] } | undefined;
    try {
      const reissued = await mcpEndpointService.reissueEndpoint(id, userId);
      if (reissued) mcpEndpoint = reissued;
    } catch (err) {
      console.error('Failed to reissue MCP endpoint on resume:', err instanceof Error ? err.message : err);
    }

    const redis = getRedisClient();
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:resume',
      sessionId: id,
      controllerId: session.controllerId.toString(),
      externalSessionId: session.externalSessionId || '',
      cwd: session.cwd || '',
      mcpEndpoint,
      // 初始 mode/model 带内下发（bridge 在首条 prompt 前应用）；
      // setMode/setModel 的 idling 守卫在 resume 阶段恒丢弃，不能作为应用通道
      ...(initial?.modeId ? { modeId: initial.modeId } : {}),
      ...(initial?.modelId ? { modelId: initial.modelId } : {}),
    }));
    return { success: true, status: 'connecting' };
  }

  async close(id: string, userId: string): Promise<boolean> {
    const session = await Session.findOne({ _id: id, userId }).lean();
    const result = await Session.findOneAndUpdate(
      { _id: id, userId },
      { status: 'ended', endedAt: new Date() },
    );
    if (result) {
      const redis = getRedisClient();
      await redis.del(`session:${id}:status`);
      // 工作流节点会话：MCP endpoint 有效性跟随工作流实例（不因会话关闭而失效）；
      // 普通会话：关闭即撤销 endpoint（token 立即失效）
      if (!session?.workflowInstanceId) {
        await mcpEndpointService.revokeEndpoint(id);
      }
      // Notify controller-api to stop ACP session
      await redis.publish('session:command', JSON.stringify({
        type: 'acp:stop',
        sessionId: id,
        reason: 'user_close',
      }));
      // 工作流兜底检查
      await this.sessionEndedCallback?.(id);
      return true;
    }
    return false;
  }

  async delete(id: string, userId: string, opts?: { skipAckWait?: boolean }): Promise<boolean> {
    const redis = getRedisClient();
    const session = await Session.findOne({ _id: id, userId }).lean();
    if (!session) return false;

    // Stop ACP session first, then do worktree cleanup.
    // creating/connecting sessions also get acp:stop: the controller may be
    // about to spawn the ACP process, and skipping stop would orphan it.
    const needsStop = ['creating', 'connecting', 'running', 'idling'].includes(session.status);
    if (needsStop) {
      // Drop any stale ack (e.g. written by a user_close acp:stopped) so
      // waitForStopAck only consumes an ack produced after this stop request.
      await redis.del(`acp:stop:ack:${id}`);
      await redis.publish('session:command', JSON.stringify({
        type: 'acp:stop',
        sessionId: id,
        reason: 'user_delete',
      }));
      if (!opts?.skipAckWait) {
        const stopAckReceived = await this.waitForStopAck(redis, id);
        if (!stopAckReceived) {
          console.warn('ACP stop ack timeout, proceeding with cleanup', { sessionId: id });
        }
      }
    }

    // Worktree cleanup if applicable
    if ((session as any).worktreePath && (session as any).worktreeBranch) {
      const workspace = await ControllerWorkspace.findOne({
        controllerId: session.controllerId,
        userId,
      }).lean();
      const repoPath = workspace?.path || session.cwd || '';

      // 1. git:status — detect if clean
      const statusReqId = `gs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await redis.publish('session:command', JSON.stringify({
        type: 'git:status',
        requestId: statusReqId,
        controllerId: session.controllerId.toString(),
        path: (session as any).worktreePath,
      }));

      let isClean = false;
      for (let i = 0; i < 30; i++) {
        const result = await redis.get(`git:status:${statusReqId}`);
        if (result) {
          const parsed = JSON.parse(result);
          isClean = parsed.isClean === true;
          await redis.del(`git:status:${statusReqId}`);
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
      }

      // 2. non-clean → git:commit
      if (!isClean) {
        const commitReqId = `gc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await redis.publish('session:command', JSON.stringify({
          type: 'git:commit',
          requestId: commitReqId,
          controllerId: session.controllerId.toString(),
          path: (session as any).worktreePath,
          message: 'chore: workspace cleanup code stash',
        }));
        for (let i = 0; i < 30; i++) {
          const result = await redis.get(`git:commit:${commitReqId}`);
          if (result) {
            await redis.del(`git:commit:${commitReqId}`);
            break;
          }
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      // 3. git:worktree:remove
      const rmReqId = `wr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await redis.publish('session:command', JSON.stringify({
        type: 'git:worktree:remove',
        requestId: rmReqId,
        controllerId: session.controllerId.toString(),
        repoPath,
        worktreePath: (session as any).worktreePath,
      }));

      for (let i = 0; i < 30; i++) {
        const result = await redis.get(`git:worktree:remove:${rmReqId}`);
        if (result) {
          const parsed = JSON.parse(result);
          await redis.del(`git:worktree:remove:${rmReqId}`);
          if (!parsed.success && !(parsed.error?.includes('is not a working tree'))) {
            throw new Error(`WORKTREE_REMOVE_FAILED: ${parsed.error}`);
          }
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // Revoke MCP endpoint
    await mcpEndpointService.revokeEndpoint(id);

    // Delete from DB
    const result = await Session.findOneAndDelete({ _id: id, userId });
    if (result) {
      await AcpMessage.deleteMany({ sessionId: id });
      await redis.del(`session:${id}:status`);
      return true;
    }
    return false;
  }

  private async waitForStopAck(redis: ReturnType<typeof getRedisClient>, sessionId: string): Promise<boolean> {
    const key = `acp:stop:ack:${sessionId}`;
    const deadline = Date.now() + ACP_STOP_ACK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await redis.get(key)) {
        await redis.del(key);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  async getMessages(sessionId: string, userId: string, options: { before?: string; limit?: number } = {}): Promise<Record<string, unknown>[]> {
    const session = await Session.findOne({ _id: sessionId, userId }).lean();
    if (!session) {
      throw new Error('Session not found');
    }

    const { before, limit: rawLimit = 25 } = options;
    const limit = Math.min(Math.max(rawLimit, 1), 100);

    const filter: Record<string, unknown> = { sessionId };
    if (before && mongoose.Types.ObjectId.isValid(before)) {
      filter._id = { $lt: new mongoose.Types.ObjectId(before) };
    }

    const messages = await AcpMessage.find(filter)
      .sort({ _id: -1 })
      .limit(limit)
      .lean();

    return messages.reverse().map(this.mapMessage.bind(this));
  }

  async addMessage(sessionId: string, message: { direction: string; type: string; content: unknown; metadata?: string }): Promise<Record<string, unknown>> {
    const acpMessage = await AcpMessage.create({
      sessionId,
      direction: message.direction as 'input' | 'output',
      type: message.type as 'text' | 'image' | 'tool_call' | 'tool_result' | 'plan' | 'error',
      content: typeof message.content === 'string'
        ? (() => { try { return JSON.parse(message.content); } catch { return { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: message.content } }; } })()
        : message.content,
      metadata: message.metadata,
    });

    // Set session title from first user message
    if (message.direction === 'input') {
      const messageCount = await AcpMessage.countDocuments({ sessionId, direction: 'input' });
      if (messageCount === 1) {
        // First user message - extract text content as title
        let title = message.content as string;
        let parsedContent: Record<string, unknown> | null = null;
        if (typeof message.content === 'string') {
          try {
            parsedContent = JSON.parse(message.content);
          } catch { /* use raw content */ }
        } else {
          parsedContent = message.content as Record<string, unknown>;
        }
        if (parsedContent?.sessionUpdate === 'user_message_chunk' && (parsedContent.content as Record<string, unknown>)?.text) {
          title = (parsedContent.content as Record<string, unknown>).text as string;
        }
        // Truncate to 50 chars
        if (title.length > 50) {
          title = title.slice(0, 50) + '...';
        }
        await Session.findByIdAndUpdate(sessionId, { title });
      }
    }

    const mappedMessage = this.mapMessage(acpMessage.toObject());

    // Publish to Redis for SSE
    const redis = getRedisClient();
    redis.publish('session:message', JSON.stringify({
      sessionId,
      message: mappedMessage,
    }));

    return mappedMessage;
  }

  async getAcpCapabilities(controllerId: string, userId: string): Promise<Record<string, unknown>[]> {
    // Verify controller belongs to user
    const controller = await Controller.findOne({ _id: controllerId, userId }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }

    const redis = getRedisClient();

    // Check Redis cache first
    const cached = await redis.get(`acp:capability:${controllerId}`);
    if (cached) {
      return this.parseCapabilitiesWithCheckedAt(cached);
    }

    // Trigger ACP capability detection via Redis Pub/Sub
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:check',
      requestId,
      controllerId,
    }));

    // Poll Redis cache for result (controller-api will cache it after detection)
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const result = await redis.get(`acp:capability:${controllerId}`);
      if (result) {
        return this.parseCapabilitiesWithCheckedAt(result);
      }
    }

    // Timeout — return empty
    return [];
  }

  private parseCapabilitiesWithCheckedAt(cached: string): Record<string, unknown>[] {
    const parsed = JSON.parse(cached);
    return (parsed.servers as Record<string, unknown>[]).map((s) => ({
      ...s,
      checkedAt: parsed.checkedAt || null,
    }));
  }

  /**
   * 探测指定 ACP 工具的 Mode/模型选项（controller 拉起空实例获得）。
   * 缓存优先（acp:options:<controllerId>:<serverType>，由 controller-api 写入）；
   * 未命中时发布 acp:probe-options 命令并轮询等待结果（最长 35s，覆盖 30s 探测超时）。
   * 探测失败返回空选项（probedAt=null），由前端回退手动输入。
   */
  async getAcpServerOptions(
    controllerId: string,
    acpServerType: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const controller = await Controller.findOne({ _id: controllerId, userId }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }

    const redis = getRedisClient();
    const cacheKey = `acp:options:${controllerId}:${acpServerType}`;

    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as Record<string, unknown>;
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:probe-options',
      requestId,
      controllerId,
      serverType: acpServerType,
    }));

    for (let i = 0; i < 70; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const result = await redis.get(cacheKey);
      if (result) {
        return JSON.parse(result) as Record<string, unknown>;
      }
    }

    // 超时 — 返回空选项
    return { modes: [], models: [], currentModeId: null, currentModelId: null, probedAt: null };
  }

  /**
   * 删除该控制器+工具类型的选项缓存并立即重新探测（失败/超时返回空选项，不抛错）。
   * 与 getAcpServerOptions 共用同一条探测链路，供前端「刷新」按钮使用。
   */
  async refreshAcpServerOptions(
    controllerId: string,
    acpServerType: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const controller = await Controller.findOne({ _id: controllerId, userId }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }
    try {
      await getRedisClient().del(`acp:options:${controllerId}:${acpServerType}`);
    } catch (err) {
      console.warn(
        `[session] delete acp options cache failed for ${controllerId}:`,
        (err as Error).message,
      );
    }
    return this.getAcpServerOptions(controllerId, acpServerType, userId);
  }

  async refreshAcpCapabilities(controllerId: string, userId: string): Promise<Record<string, unknown>[]> {
    const controller = await Controller.findOne({ _id: controllerId, userId }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }

    const redis = getRedisClient();

    // Delete Redis cache
    await redis.del(`acp:capability:${controllerId}`);

    // Notify controller-api to invalidate its in-memory cache
    await redis.publish('session:command', JSON.stringify({
      type: 'acp:cache:invalidate',
      controllerId,
    }));

    // Trigger fresh detection and return result
    return this.getAcpCapabilities(controllerId, userId);
  }

  mapSession(session: Record<string, unknown>): Record<string, unknown> {
    return {
      id: (session._id as mongoose.Types.ObjectId).toString(),
      userId: (session.userId as mongoose.Types.ObjectId).toString(),
      controllerId: (session.controllerId as mongoose.Types.ObjectId).toString(),
      controllerName: session.controllerName,
      acpServerType: session.acpServerType,
      status: session.status,
      title: session.title || 'New Session',
      externalSessionId: session.externalSessionId || null,
      cwd: session.cwd || null,
      worktreePath: (session as any).worktreePath || null,
      worktreeBranch: (session as any).worktreeBranch || null,
      modes: session.modes || [],
      currentModeId: session.currentModeId || null,
      currentModel: session.currentModel || null,
      currentModelId: session.currentModelId || null,
      availableModels: session.availableModels || [],
      configOptions: (session as any).configOptions || [],
      promptCapabilities: (session as any).promptCapabilities || null,
      agentInfo: (session as any).agentInfo || null,
      authRequired: (session as any).authRequired || false,
      authMethods: this.mapAuthMethods((session as any).authMethods),
      supportsAdditionalDirectories: (session as any).supportsAdditionalDirectories || false,
      agentCapabilities: (session as any).agentCapabilities ?? null,
      permissionTimeoutAction: (session as any).permissionTimeoutAction || null,
      workflowInstanceId: (session as any).workflowInstanceId
        ? (session as any).workflowInstanceId.toString()
        : null,
      workflowNodeId: (session as any).workflowNodeId || null,
      createdAt: (session.createdAt as Date).toISOString(),
      updatedAt: (session.updatedAt as Date).toISOString(),
      endedAt: session.endedAt ? (session.endedAt as Date).toISOString() : null,
    };
  }

  private mapAuthMethods(authMethods: unknown): Record<string, unknown>[] {
    if (!Array.isArray(authMethods)) return [];
    const validKinds = new Set(['env_var', 'terminal', 'agent']);
    return authMethods.map((method) => {
      const m = method as Record<string, unknown>;
      return {
        ...m,
        kind: typeof m.kind === 'string' && validKinds.has(m.kind) ? m.kind : null,
      };
    });
  }

  private mapMessage(message: Record<string, unknown>): Record<string, unknown> {
    return {
      id: (message._id as mongoose.Types.ObjectId).toString(),
      sessionId: (message.sessionId as mongoose.Types.ObjectId).toString(),
      direction: message.direction,
      type: message.type,
      content: message.content,
      metadata: message.metadata || null,
      messageId: (message as any).messageId || null,
      createdAt: (message.createdAt as Date).toISOString(),
    };
  }
}

export const sessionService = new SessionService();
