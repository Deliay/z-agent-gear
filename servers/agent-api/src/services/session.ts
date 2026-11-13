import mongoose from 'mongoose';
import path from 'path';
import { GraphQLError } from 'graphql';
import { Session } from '../models/session.js';
import { AcpMessage } from '../models/acp-message.js';
import { SessionInteraction } from '../models/session-interaction.js';
import { Controller } from '../models/controller.js';
import { CloudHost } from '../models/cloud-host.js';
import { ControllerWorkspace } from '../models/controller-workspace.js';
import { getRedisClient } from '../middleware/redis.js';
import { publish } from '../middleware/publish.js';
import { logger as rootLogger } from '../observability/logger.js';
import { McpServer } from '../models/mcp-server.js';
import { CustomMcpServer } from '../models/custom-mcp-server.js';
import { mcpEndpointService, type CustomMcpSnapshotEntry } from './mcp-endpoint.js';
import { ensureCloudHostToolsServer, CLOUD_HOST_TOOLS_SERVER_NAME } from './cloud-host-tools.js';
import {
  ensureSessionPreviewToolsServer,
  SESSION_PREVIEW_TOOLS_SERVER_NAME,
} from './session-preview-tools.js';
import { sessionReviewService } from './session-review-service.js';
import { actorFilter, getWorkspaceContext } from './workspace-context.js';
import { sanitizeWorkspaceName, generateWorktreeSuffix, resolveEffectiveWorktreeDir, worktreeScopePrefix, normalizeForCompare } from './workflow/worktree-utils.js';
import {
  commitSettingsService,
  type ResolvedWorktreeCommitter,
} from './commit-settings-service.js';

const logger = rootLogger.child({ component: 'session' });

const ACP_STOP_ACK_TIMEOUT_MS = 10_000;

export interface ControllerDefaultMcpSnapshot {
  useAllEnabled?: boolean | null;
  /** Mongo lean 后可能是 ObjectId（schema 为 ObjectId[]），必须允许 toString */
  serverIds?: Array<string | { toString(): string } | null | undefined> | null;
}

/** 会话状态通用事件（`session:status` 通道原样透传；`onSessionStatus` 消费） */
export interface SessionStatusEvent {
  sessionId: string;
  status: string;
  promptCompleted?: boolean;
  /** 会话意外结束的错误码（CONTROLLER_OFFLINE / ACP_RESUME_FAILED 等） */
  error?: string;
}

/** 提示词片段（契约 PromptPartInput；type=text 时 text 必填、type=image 时 data/mimeType 必填） */
export interface PromptPartInput {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  name?: string;
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
  // N-18 联动发现：Mongoose `defaultMcp.serverIds` 是 ObjectId[]，旧实现只接受 string，
  // 导致真实 DB 路径把子集全部过滤为空（单测用 string 假数据所以未暴露）。
  const subset = (defaultMcp.serverIds ?? [])
    .filter((id): id is string | { toString(): string } => id !== null && id !== undefined)
    .map((id) => String(id))
    .filter((id) => id.length > 0 && enabledSet.has(id));
  return Array.from(new Set(subset));
}

/** 会话只读原因（契约 `SessionReadOnlyReason`；写路径与字段 resolver 共用同一判定） */
export type SessionReadOnlyReason =
  | 'WORKSPACE_MISSING'
  | 'CONTROLLER_MISSING'
  | 'CLOUD_HOST_DESTROYED';

/** 统一只读判定所需的会话上下文（原始 lean 文档与 `mapSession` 输出均满足） */
interface WritableSessionContext {
  controllerId: unknown;
  controllerWorkspaceId?: unknown;
  cwd?: unknown;
  worktreePath?: unknown;
}

/** `archiveByWorkspace` / `matchWorkspaceSessions` 的工作区入参（原始文档与 `mapWorkspace` 输出均满足） */
export interface WorkspaceMatchTarget {
  _id?: unknown;
  id?: unknown;
  controllerId: unknown;
  path?: unknown;
  name?: unknown;
}

export class SessionService {
  /** 会话进入 ended 时的回调（由工作流 Orchestrator 注册用于兜底检查，避免循环依赖） */
  private sessionEndedCallback?: (sessionId: string) => void | Promise<void>;
  /** 会话被移除（start/resume 失败清理）时的回调（由工作流 Orchestrator 注册用于节点失败升级） */
  private sessionRemovedCallback?: (sessionId: string) => void | Promise<void>;
  /** 会话 turn 结束进入空闲（promptCompleted）时的回调（由工作流 Orchestrator 注册用于停滞检测） */
  private sessionIdledCallback?: (sessionId: string) => void | Promise<void>;
  /**
   * 会话状态通用通道（`session:status` 全量透传，不经过 `handled` 过滤）。
   * 多监听者集合：中断自动重试的空闲等待器按会话订阅，注册即返回注销函数。
   */
  private sessionStatusListeners = new Set<(event: SessionStatusEvent) => void | Promise<void>>();

  onSessionEnded(callback: (sessionId: string) => void | Promise<void>): void {
    this.sessionEndedCallback = callback;
  }

  onSessionRemoved(callback: (sessionId: string) => void | Promise<void>): void {
    this.sessionRemovedCallback = callback;
  }

  onSessionIdled(callback: (sessionId: string) => void | Promise<void>): void {
    this.sessionIdledCallback = callback;
  }

  /** 订阅会话状态通用通道；返回注销函数（无监听者时静默） */
  onSessionStatus(callback: (event: SessionStatusEvent) => void | Promise<void>): () => void {
    this.sessionStatusListeners.add(callback);
    return () => {
      this.sessionStatusListeners.delete(callback);
    };
  }

  /** 透传 `session:status`（错误只告警，不影响调用方） */
  async notifySessionStatus(event: SessionStatusEvent): Promise<void> {
    for (const listener of [...this.sessionStatusListeners]) {
      try {
        await listener(event);
      } catch (err) {
        logger.warn({ event: 'session-status-listener-failed', sessionId: event.sessionId, status: event.status, err }, 'session status listener failed');
      }
    }
  }

  /** 直读会话状态（内部只读，不经 user 作用域）：会话文档缺失返回 null */
  async getSessionStatusRaw(sessionId: string): Promise<string | null> {
    const session = await Session.findById(sessionId).select('status').lean();
    return (session as { status?: string } | null)?.status ?? null;
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
    options: { includeWorkflowSessions?: boolean; controllerId?: string; archived?: boolean } = {},
  ): Promise<Record<string, unknown>[]> {
    // 默认排除工作流节点会话（workflowInstanceId != null）
    const filter: Record<string, unknown> = options.includeWorkflowSessions
      ? { ...actorFilter(userId) }
      : { ...actorFilter(userId), workflowInstanceId: null };
    // 归档口径与节点会话排除正交：缺省/false=活跃（未归档），true=已归档
    filter.archivedAt = options.archived ? { $ne: null } : null;
    if (options.controllerId) {
      filter.controllerId = options.controllerId;
    }
    const sessions = await Session.find(filter).sort({ createdAt: -1 }).lean();
    return sessions.map(this.mapSession.bind(this));
  }

  async findById(id: string, userId: string): Promise<Record<string, unknown> | null> {
    const session = await Session.findOne({ _id: id, ...actorFilter(userId) }).lean();
    if (!session) return null;
    return this.mapSession(session);
  }

  /**
   * 归档/取消归档会话（D1：对齐工作流实例的 `archivedAt` 语义，仅分组展示差异——
   * 不终止进程、不触发任何 acp 命令、不影响 `session:status` 通道）。
   * 归属口径 `actorFilter`（他人会话 → `Session not found`）；工作流节点会话拒绝
   * `ARCHIVE_WORKFLOW_SESSION_UNSUPPORTED`（D2，且不写库）；重复操作幂等。
   */
  async setArchived(userId: string, id: string, archived: boolean): Promise<boolean> {
    const session = await Session.findOne({ _id: id, ...actorFilter(userId) }).lean();
    if (!session) {
      throw new Error('Session not found');
    }
    if (session.workflowInstanceId != null) {
      throw new Error('ARCHIVE_WORKFLOW_SESSION_UNSUPPORTED');
    }
    await Session.updateOne(
      { _id: id, ...actorFilter(userId) },
      { $set: { archivedAt: archived ? new Date() : null } },
    );
    return true;
  }

  /**
   * A-2/B15：会话写路径统一只读判定。
   * 三场景统一（会话管理优化）：
   * - 控制器缺失（unbind 删除）→ `session is ended`；
   * - 云电脑（Controller.type=cloud）缺失/软删除/非 RUNNING（STOPPING/STOPPED/FAILED）→ `session is ended`；
   * - 本地/GitHub 控制器的项目工作区缺失 → `session is ended`（精确 + cwd 回退，见 `isWorkspaceMissing`）。
   */
  async assertSessionWritable(sessionId: string, userId: string): Promise<void> {
    const session = await Session.findOne({ _id: sessionId, ...actorFilter(userId) }).lean();
    if (!session) throw new Error('Session not found');
    await this.assertControllerWritable(session, userId);
  }

  /** 写路径统一判定入口（保留函数名兼容调用点）：任一场景缺失即统一拒绝文案 `session is ended` */
  private async assertControllerWritable(session: WritableSessionContext, userId: string): Promise<void> {
    const reason = await this.resolveReadOnlyReason(session, userId);
    if (reason) throw new Error('session is ended');
  }

  /**
   * `Session.readOnlyReason` 字段 resolver 入口（D5：与写路径同一判定函数的只读版，实时计算不落库）。
   * 返回四态：null（可写）/ WORKSPACE_MISSING / CONTROLLER_MISSING / CLOUD_HOST_DESTROYED。
   */
  async resolveSessionReadOnlyReason(
    session: Record<string, unknown>,
    userId: string,
  ): Promise<SessionReadOnlyReason | null> {
    return this.resolveReadOnlyReason(
      {
        controllerId: session.controllerId,
        controllerWorkspaceId: session.controllerWorkspaceId,
        cwd: session.cwd,
        worktreePath: session.worktreePath,
      },
      userId,
    );
  }

  /** 统一只读判定核心：返回只读原因，null 表示可写 */
  private async resolveReadOnlyReason(
    session: WritableSessionContext,
    userId: string,
  ): Promise<SessionReadOnlyReason | null> {
    const controllerRef = session.controllerId as mongoose.Types.ObjectId;
    const controller = await Controller.findOne({
      _id: controllerRef,
      ...actorFilter(userId),
    }).lean();
    // 控制器缺失（已解绑）：运行环境不存在
    if (!controller) return 'CONTROLLER_MISSING';
    if (controller.type === 'cloud') {
      const host = await CloudHost.findOne({
        controllerId: controllerRef,
        ...actorFilter(userId),
        deletedAt: null,
      }).lean();
      if (
        !host ||
        host.status === 'STOPPING' ||
        host.status === 'STOPPED' ||
        host.status === 'FAILED'
      ) {
        return 'CLOUD_HOST_DESTROYED';
      }
      return null;
    }
    // 本地 / GitHub 控制器：项目工作区缺失判定
    if (await this.isWorkspaceMissing(session, controller, userId)) return 'WORKSPACE_MISSING';
    return null;
  }

  /**
   * 项目工作区缺失判定（只对非 cloud 控制器生效）：
   * - `controllerWorkspaceId` 非空：`ControllerWorkspace.exists({_id})` 不存在即缺失；
   * - 为空（存量旧数据）回退：根目录会话按 `cwd == ws.path` 或前缀 `ws.path + '/'` 匹配
   *   该控制器任一工作区，匹配不到即缺失；
   * - worktree 会话（`worktreePath != null`）与无 cwd 会话无法可靠判定 → 放行（D8：误伤代价高于漏判）。
   */
  private async isWorkspaceMissing(
    session: WritableSessionContext,
    controller: Record<string, unknown>,
    userId: string,
  ): Promise<boolean> {
    const workspaceId = session.controllerWorkspaceId;
    if (workspaceId) {
      const exists = await ControllerWorkspace.exists({ _id: workspaceId, ...actorFilter(userId) });
      return !exists;
    }
    if (session.worktreePath != null) return false;
    const cwd = session.cwd as string | null | undefined;
    if (!cwd) return false;
    const workspaces = (await ControllerWorkspace.find({
      controllerId: session.controllerId as mongoose.Types.ObjectId,
      ...actorFilter(userId),
    }).lean()) as Array<{ path: string }>;
    const platform = (controller.platform as string | null | undefined) ?? null;
    const normalizedCwd = normalizeForCompare(cwd, platform);
    return !workspaces.some((workspace) => {
      const wsPath = normalizeForCompare(String(workspace.path), platform);
      return normalizedCwd === wsPath || normalizedCwd.startsWith(`${wsPath}/`);
    });
  }

  async create(userId: string, input: {
    controllerId: string;
    acpServerType: string;
    workspaceId: string;
    enableWorktree?: boolean;
    worktreeBranchSuffix?: string;
    existingWorktreePath?: string;
    mcpServerIds?: string[];
    /**
     * 自定义 MCP（工作区级，Phase 3 / D2）：与 `mcpServerIds` 正交可叠加；
     * 缺省 / 显式 `[]` 均不注入。签发期校验条目存在且当前工作区可见。
     */
    customMcpServerIds?: string[];
    /** 工作流内部打标（引擎编排节点会话时使用，不暴露到 GraphQL CreateSessionInput） */
    workflowInstanceId?: string;
    workflowNodeId?: string;
    /** 租户工作区归属（引擎内部链路显式传值；GraphQL 链路由 workspace-scope 插件写入） */
    resourceWorkspaceId?: string;
    /** 初始工作模式/模型（工作流节点配置，harness 会话启动时应用） */
    modeId?: string;
    modelId?: string;
    /**
     * Worktree 提交人：`undefined` = 按会话创建者实时解析；显式 `null` = 不下发（bot）；
     * 工作流节点场景由调用方显式传入实例快照（复用同一身份）。
     */
    worktreeCommitter?: ResolvedWorktreeCommitter | null;
    /** 内部编排：允许在云电脑 STARTING 窗口创建默认会话（ready 回调原子写 RUNNING+defaultSessionId） */
    allowStartingCloudHost?: boolean;
  }): Promise<Record<string, unknown>> {
    const controller = await Controller.findOne({ _id: input.controllerId, ...actorFilter(userId) }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }
    // 租户工作区归属（对齐计划「sessions.workspaceId = 其控制器/云电脑」）：
    // 优先调用方显式传值（工作流节点继承实例）→ 请求上下文 → 控制器归属。
    // 后台链路（云电脑 ready / Git 项目设置）没有 ALS 上下文，但控制器仍带工作区，
    // 必须在此补齐，否则会话及其后续 MCP 工具调用会落到个人租户、团队工作区不可见。
    const workspaceContext = getWorkspaceContext();
    const targetWorkspaceId =
      input.resourceWorkspaceId ??
      workspaceContext?.id ??
      (controller.workspaceId ? String(controller.workspaceId) : undefined);
    const targetTenantId =
      workspaceContext?.tenantId ??
      (controller.tenantId ? String(controller.tenantId) : undefined);
    const cloudHostRunning = (host: { status?: string } | null): boolean =>
      host?.status === 'RUNNING' ||
      (input.allowStartingCloudHost === true && host?.status === 'STARTING');
    if (controller.type === 'cloud') {
      const host = await CloudHost.findOne({
        controllerId: input.controllerId,
        ...actorFilter(userId),
        deletedAt: null,
      }).lean();
      if (!host || !cloudHostRunning(host as { status?: string })) {
        throw new Error('cloud host is not running');
      }
      // A-11：会话 ACP 工具必须落在云电脑已启用的 harnessTypes 映射内。
      const harnessAcpTypes: Record<string, string> = { OPENCODE: 'opencode', KIMI_CODE: 'kimi_code', DEEPSEEK_HARNESS: 'deepseek_harness' };
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
      // 平台内置服务（agent-cloud-host-tools / agent-session-preview-tools）仅由会话创建时自动并入
      // （与前端可选列表口径一致），不作为「默认 MCP」候选（裁决 5：排除口径 $ne → $nin）。
      const enabledServers = await McpServer.find({
        userId,
        enabled: true,
        name: { $nin: [CLOUD_HOST_TOOLS_SERVER_NAME, SESSION_PREVIEW_TOOLS_SERVER_NAME] },
      })
        .select('_id')
        .lean();
      mcpServerIds = resolveInitialMcpServerIds(
        (controller as unknown as { defaultMcp?: ControllerDefaultMcpSnapshot }).defaultMcp,
        undefined,
        enabledServers.map((server) => String(server._id)),
      );
    }

    // 平台内置服务（agent-cloud-host-tools / agent-session-preview-tools）在下方自动并入，
    // 不参与「用户所选 MCP 有效性」前置校验（平台 id 由装配点保证存在且启用）。
    const userSelectedMcpIds = mcpServerIds ?? [];

    // 云会话自动装配云主机平台 MCP 工具（workload_list/workload_install）；非云会话不装配。
    if (controller.type === 'cloud') {
      const cloudToolsId = await ensureCloudHostToolsServer(userId);
      mcpServerIds = Array.from(new Set([...(mcpServerIds ?? []), cloudToolsId]));
    }

    // 会话预览平台 MCP 工具（agent-session-preview-tools.review）：全部类型会话
    // （普通/云/工作流节点会话）公共路径装配并去重（裁决 5 / D7）。
    {
      const previewToolsId = await ensureSessionPreviewToolsServer(userId);
      mcpServerIds = Array.from(new Set([...(mcpServerIds ?? []), previewToolsId]));
    }

    const workspace = await ControllerWorkspace.findOne(
      getWorkspaceContext()
        ? { _id: input.workspaceId, controllerId: input.controllerId }
        : { _id: input.workspaceId, userId, controllerId: input.controllerId },
    ).lean();
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

      // 已有 Worktree 不会重新走 git:worktree:add，共同作者配置只在创建时写入一次；
      // 成员在创建后勾选/取消「与 bot 共同提交」时，需在新建会话时重新同步一次。
      const existingCommitter =
        input.worktreeCommitter !== undefined
          ? input.worktreeCommitter
          : await this.resolveWorktreeCommitter(userId);
      await this.syncWorktreeCoAuthor(input.controllerId, worktreePath, existingCommitter);
    } else if (input.enableWorktree && input.worktreeBranchSuffix && workspace.name) {
      // Create a new worktree via controller git:worktree:add
      // 使用随机后缀天然去重，避免多实例/多节点并发碰撞
      const worktreeDir = resolveEffectiveWorktreeDir(controller as { worktreeDir?: string | null } | null);
      const safeName = sanitizeWorkspaceName(workspace.name);
      const uniqueSuffix = generateWorktreeSuffix();
      const branch = `${safeName}/${input.worktreeBranchSuffix}-${uniqueSuffix}`;
      const wtPath = path.join(worktreeDir, safeName, `${input.worktreeBranchSuffix}-${uniqueSuffix}`);

      const requestId = `wt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      // Worktree 提交人：调用方显式传入优先（工作流节点复用实例快照）；
      // 未传时按会话创建者实时解析；解析失败降级 null（沿用容器级 bot）。
      const worktreeCommitter =
        input.worktreeCommitter !== undefined
          ? input.worktreeCommitter
          : await this.resolveWorktreeCommitter(userId);
      await publish('session:command', {
        type: 'git:worktree:add',
        requestId,
        controllerId: input.controllerId,
        repoPath: workspace.path,
        worktreePath: wtPath,
        branch,
        ...(worktreeCommitter ? { committer: worktreeCommitter } : {}),
      });

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
    if (userSelectedMcpIds.length > 0) {
      const selectable = await McpServer.countDocuments({
        _id: { $in: userSelectedMcpIds },
        userId,
        enabled: true,
      });
      if (selectable !== userSelectedMcpIds.length) {
        throw new Error('MCP_SERVER_NOT_FOUND: some selected MCP servers are invalid or disabled');
      }
    }

    // 自定义 MCP 签发校验（Phase 3 / T-CF1）：条目存在且当前工作区可见——可见集由
    // workspace-scope 独占型插件注入（无 ALS 上下文的内部链路不注入，与既有口径一致）。
    // 不可见 / 不存在 / 非法 id 统一 `custom mcp server not found`，且必须在建会话前拒绝。
    const requestedCustomIds = Array.from(new Set((input.customMcpServerIds ?? []).map(String)));
    let customMcpServers: CustomMcpSnapshotEntry[] = [];
    if (requestedCustomIds.length > 0) {
      if (!requestedCustomIds.every((id) => mongoose.isValidObjectId(id))) {
        throw new Error('custom mcp server not found');
      }
      const rows = (await CustomMcpServer.find({ _id: { $in: requestedCustomIds } })
        .select('name')
        .lean()) as unknown as Array<{ _id: unknown; name?: unknown }>;
      if (rows.length !== requestedCustomIds.length) {
        throw new Error('custom mcp server not found');
      }
      const names = new Map(rows.map((row) => [String(row._id), row.name === undefined ? null : String(row.name)]));
      customMcpServers = requestedCustomIds.map((id) => {
        const name = names.get(id);
        if (name === null || name === undefined) throw new Error('custom mcp server not found');
        // 快照：name 供 loopback 路由、id 供转发器每次请求实时加载配置（提案 D10）
        return { id, name };
      });
    }

    // A-3：创建会话与 stop/terminal 无原子性——长耗时 worktree/MCP 流程结束后、
    // 落库前复查云电脑仍在允许状态，缩小「终态后残留 creating 幽灵会话」窗口。
    if (controller.type === 'cloud') {
      const stillRunning = await CloudHost.findOne({
        controllerId: input.controllerId,
        ...actorFilter(userId),
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
      // 项目工作区归属（D3：仅 create/import 3 处落库，存量不回填，旧数据走回退匹配）
      controllerWorkspaceId: input.workspaceId,
      // 租户工作区/租户归属显式落库（后台链路无 ALS 上下文时由控制器继承，见上）
      ...(targetTenantId ? { tenantId: targetTenantId } : {}),
      ...(targetWorkspaceId ? { workspaceId: targetWorkspaceId } : {}),
      ...(input.workflowInstanceId ? { workflowInstanceId: input.workflowInstanceId } : {}),
      ...(input.workflowNodeId ? { workflowNodeId: input.workflowNodeId } : {}),
    });

    // A-3 残留窗口（毫秒级）：insert 之后立即回查；若 stop/terminal 已在复查与 insert 之间收口，
    // 将刚创建的会话置 ENDED 并拒绝，避免 creating 幽灵会话。
    if (controller.type === 'cloud') {
      const afterInsert = await CloudHost.findOne({
        controllerId: input.controllerId,
        ...actorFilter(userId),
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

    // Create MCP endpoint when either personal MCP servers or custom MCP servers were
    // selected (D2：custom-only 会话同样要拿到代理地址；触发条件两份选择正交可叠加)
    let mcpEndpoint: { token: string; serverNames: string[] } | undefined;
    if ((mcpServerIds && mcpServerIds.length > 0) || customMcpServers.length > 0) {
      try {
        mcpEndpoint = await mcpEndpointService.createEndpoint(
          session._id.toString(),
          userId,
          mcpServerIds ?? [],
          // 工作流节点会话：token 扩展节点作用域
          input.workflowInstanceId && input.workflowNodeId
            ? { instanceId: input.workflowInstanceId, nodeId: input.workflowNodeId }
            : undefined,
          customMcpServers,
        );
      } catch (err) {
        // 当会话显式携带 MCP 选择时 fail-fast：删除已创建的会话并抛错
        await Session.deleteOne({ _id: session._id });
        throw new Error(
          `MCP endpoint 创建失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Notify controller-api to start ACP session via Redis Pub/Sub
    await publish('session:command', {
      type: 'acp:start',
      sessionId: session._id.toString(),
      controllerId: input.controllerId,
      serverType: input.acpServerType,
      cwd,
      mcpEndpoint,
      ...(input.modeId ? { modeId: input.modeId } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
    });

    return this.mapSession(session.toObject());
  }

  /** Worktree 提交人实时解析（独立会话）：失败降级 null（沿用容器级 bot），不阻断建会话。 */
  private async resolveWorktreeCommitter(
    userId: string,
  ): Promise<ResolvedWorktreeCommitter | null> {
    try {
      return await commitSettingsService.resolveWorktreeCommitter(userId);
    } catch (err) {
      logger.warn({ event: 'resolve-committer-failed', err }, 'resolve worktree committer failed');
      return null;
    }
  }

  /**
   * 同步已有 Worktree 的共同作者配置（仅 trailer，不改变作者身份）。
   *
   * 共同作者是附加信息：控制器离线 / 旧 worker 忽略 / 超时均只告警，不阻断建会话。
   * 等待 worker ack 是为了保证后续 `acp:start` 启动 Agent 前配置已落盘。
   */
  private async syncWorktreeCoAuthor(
    controllerId: string,
    worktreePath: string,
    committer: ResolvedWorktreeCommitter | null | undefined,
  ): Promise<void> {
    const coAuthor =
      committer?.coAuthorName && committer.coAuthorEmail
        ? { name: committer.coAuthorName, email: committer.coAuthorEmail }
        : undefined;
    const requestId = `wtc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      await publish('session:command', {
        type: 'git:worktree:coauthor',
        requestId,
        controllerId,
        worktreePath,
        ...(coAuthor ? { coAuthor } : {}),
      });
      // 关闭共同作者只需尽力下发清理，不必等待 ack（避免未开启成员承担额外延迟）；
      // 启用时等待 ack，确保后续 acp:start 启动 Agent 前 hook 已就绪。
      if (!coAuthor) return;
      const redis = getRedisClient();
      for (let i = 0; i < 20; i++) {
        const result = await redis.get(`git:worktree:coauthor:${requestId}`);
        if (result) {
          await redis.del(`git:worktree:coauthor:${requestId}`);
          const parsed = JSON.parse(result) as { success?: boolean };
          if (parsed.success === false) {
            logger.warn(
              { event: 'worktree-coauthor-sync-failed', worktreePath },
              'worktree co-author sync failed',
            );
          }
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      logger.warn(
        { event: 'worktree-coauthor-sync-timeout', worktreePath },
        'worktree co-author sync timed out',
      );
    } catch (err) {
      logger.warn({ event: 'worktree-coauthor-sync-error', err }, 'worktree co-author sync failed');
    }
  }

  /** 云电脑停止/终态：该主机下所有非 ENDED 会话批量结束（只读，消息保留）。 */
  async endByController(controllerId: string, userId: string): Promise<number> {
    const result = await Session.updateMany(
      { controllerId, ...actorFilter(userId), status: { $ne: 'ended' } },
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
      { _id: id, ...actorFilter(userId) },
      updateData,
      { returnDocument: 'after' },
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
    const session = await Session.findOne({ _id: sessionId, ...actorFilter(userId) }).lean();
    if (!session) return false;
    if (session.status !== 'idling') return false;

    const redis = getRedisClient();
    await publish('session:command', {
      type: 'acp:set-mode',
      sessionId,
      modeId,
    });
    // 同步更新 Session 文档缓存，保证前端查询为最新值
    await Session.updateOne({ _id: sessionId, ...actorFilter(userId) }, { currentModeId: modeId });
    return true;
  }

  async setModel(sessionId: string, userId: string, modelId: string): Promise<boolean> {
    const session = await Session.findOne({ _id: sessionId, ...actorFilter(userId) }).lean();
    if (!session) return false;
    if (session.status !== 'idling') return false;

    const redis = getRedisClient();
    await publish('session:command', {
      type: 'acp:set-model',
      sessionId,
      modelId,
    });
    // 同步更新 Session 文档缓存，保证前端查询为最新值
    await Session.updateOne({ _id: sessionId, ...actorFilter(userId) }, { currentModelId: modelId });
    return true;
  }

  async setConfigOption(sessionId: string, userId: string, configId: string, value: string): Promise<boolean> {
    const session = await Session.findOne({ _id: sessionId, ...actorFilter(userId) }).lean();
    if (!session) return false;
    if (session.status !== 'idling') return false;
    const configOptions = (session as Record<string, unknown>).configOptions as unknown[] | undefined;
    if (!configOptions || configOptions.length === 0) return false;

    const redis = getRedisClient();
    await publish('session:command', {
      type: 'acp:set-config-option',
      sessionId,
      configId,
      value,
    });
    return true;
  }

  async cancelGeneration(sessionId: string, userId: string): Promise<boolean> {
    const session = await Session.findOne({ _id: sessionId, ...actorFilter(userId) }).lean();
    if (!session) return false;

    // A-2：只读留档会话不得继续（cancel 亦属于 session:command 写路径）。
    await this.assertControllerWritable(session, userId);

    const redis = getRedisClient();
    await publish('session:command', {
      type: 'acp:cancel',
      sessionId,
    });
    return true;
  }

  async resume(id: string, userId: string, initial?: { modeId?: string; modelId?: string }): Promise<{ success: boolean; status: string; error?: string }> {
    const session = await Session.findOne({ _id: id, ...actorFilter(userId) }).lean();
    if (!session) {
      return { success: false, status: 'ended', error: 'Session not found' };
    }
    // ended/disconnected 均可恢复（disconnected 为 Controller 临时断连，重连后可 resume）
    if (session.status !== 'ended' && session.status !== 'disconnected') {
      return { success: false, status: session.status, error: 'Session is not ended' };
    }

    // 统一只读判定（F6：删除 resume 内重复的云电脑判定，收敛为与写路径同一判定函数）：
    // 控制器缺失 / 工作区缺失 / 云电脑终态三场景一律只读，拒绝文案统一 `session is ended`。
    const readOnlyReason = await this.resolveReadOnlyReason(session, userId);
    if (readOnlyReason) {
      return { success: false, status: 'ended', error: 'session is ended' };
    }

    // Re-issue a fresh MCP endpoint (do not reuse the revoked token)
    let mcpEndpoint: { token: string; serverNames: string[] } | undefined;
    try {
      const reissued = await mcpEndpointService.reissueEndpoint(id, userId);
      if (reissued) mcpEndpoint = reissued;
    } catch (err) {
      logger.error({ event: 'reissue-endpoint-failed', err }, 'failed to reissue MCP endpoint on resume');
    }

    const redis = getRedisClient();
    await publish('session:command', {
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
    });
    return { success: true, status: 'connecting' };
  }

  /**
   * 关闭会话。
   *
   * `suppressFallback`：主动/受控关闭（工作流节点完成、重启、复工替换会话）时置 true，
   * 跳过 `sessionEndedCallback`，避免在引擎转移尚未落库时把「人为关闭」误判为会话意外终止，
   * 也避免在同一实例锁内同步嵌套 `workflowEngine.transition`（N-1）。
   */
  async close(
    id: string,
    userId: string,
    opts?: { suppressFallback?: boolean; reason?: string },
  ): Promise<boolean> {
    const session = await Session.findOne({ _id: id, ...actorFilter(userId) }).lean();
    const result = await Session.findOneAndUpdate(
      { _id: id, ...actorFilter(userId) },
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
      await publish('session:command', {
        type: 'acp:stop',
        sessionId: id,
        reason: opts?.reason ?? 'user_close',
      });
      // 工作流兜底检查：受控关闭（节点完成/重启/复工）不触发
      if (!opts?.suppressFallback) {
        await this.sessionEndedCallback?.(id);
      }
      return true;
    }
    return false;
  }

  /**
   * 匹配工作区下的普通会话——`archiveByWorkspace` 与 resolver 的 `workspaceArchiveImpact`
   * **共用同一匹配函数**，保证删除确认提示数量 = 实际归档数量。口径：
   * 1. 精确：`{ controllerId, controllerWorkspaceId }`（新数据主口径）；
   * 2. 回退（`controllerWorkspaceId == null` 的旧数据）：根目录会话按 `cwd` 等值/前缀匹配，
   *    worktree 会话按 worktree scope 前缀匹配（复用 worktree-utils，含 homeDir 缺失退化规则，F13）；
   * 3. 两类均排除工作流节点会话（`workflowInstanceId != null`，D2）。
   */
  async matchWorkspaceSessions(
    workspace: WorkspaceMatchTarget,
    userId: string,
  ): Promise<Record<string, unknown>[]> {
    const workspaceId = workspace._id ?? workspace.id;
    const baseFilter: Record<string, unknown> = {
      controllerId: workspace.controllerId,
      workflowInstanceId: null,
      ...actorFilter(userId),
    };
    const exact: Record<string, unknown>[] = workspaceId
      ? await Session.find({ ...baseFilter, controllerWorkspaceId: workspaceId }).lean()
      : [];
    const wsPath = workspace.path == null ? null : String(workspace.path);
    const legacy: Record<string, unknown>[] = wsPath
      ? await Session.find({ ...baseFilter, controllerWorkspaceId: null }).lean()
      : [];
    if (legacy.length === 0) return exact;

    const controller = (await Controller.findOne({
      _id: workspace.controllerId,
      ...actorFilter(userId),
    }).lean()) as {
      worktreeDir?: string | null;
      homeDir?: string | null;
      platform?: string | null;
    } | null;
    const platform = controller?.platform ?? null;
    const homeDir = controller?.homeDir ?? null;
    const effectiveDir = resolveEffectiveWorktreeDir(controller);
    // 旧控制器未上报 homeDir 且生效目录含 `~`：无法可靠展开 → scope 退化为 null
    // （不按 scope 归组），与 `worktreeService.list` 的退化规则同源（F13/D8）
    const scopePrefix =
      (effectiveDir.startsWith('~/') || effectiveDir === '~') && !homeDir
        ? null
        : normalizeForCompare(
            worktreeScopePrefix(effectiveDir, String(workspace.name ?? ''), homeDir),
            platform,
          );
    const normalizedWsPath = normalizeForCompare(wsPath!, platform);
    const matched = legacy.filter((doc) => {
      const worktreePath = doc.worktreePath as string | null | undefined;
      if (worktreePath != null) {
        if (!scopePrefix) return false;
        return normalizeForCompare(worktreePath, platform).startsWith(scopePrefix);
      }
      const cwd = doc.cwd as string | null | undefined;
      if (!cwd) return false;
      const normalizedCwd = normalizeForCompare(cwd, platform);
      return (
        normalizedCwd === normalizedWsPath || normalizedCwd.startsWith(`${normalizedWsPath}/`)
      );
    });
    return [...exact, ...matched];
  }

  /**
   * 删除/清空工作区连带归档（D7「先结束后归档」）：
   * 1. 匹配其下普通会话（共用 `matchWorkspaceSessions`）；
   * 2. 非 ended 会话逐个 `close(suppressFallback, reason='workspace_deleted')`——
   *    单会话 close 失败仅记日志不阻断（对齐 `deleteInstance` 口径）；
   * 3. `updateMany({_id:{$in}, archivedAt:null})` 幂等归档，返回本次实际归档数量。
   * 第 3 步失败会抛错：调用方必须中止工作区删除，避免「工作区没了、会话未归档」中间态。
   */
  async archiveByWorkspace(userId: string, workspace: WorkspaceMatchTarget): Promise<number> {
    const matched = await this.matchWorkspaceSessions(workspace, userId);
    if (matched.length === 0) return 0;

    for (const doc of matched) {
      if (doc.status === 'ended') continue;
      try {
        await this.close(String(doc._id), userId, {
          suppressFallback: true,
          reason: 'workspace_deleted',
        });
      } catch (err) {
        logger.error(
          { event: 'close-session-before-archive-failed', sessionId: String(doc._id), err },
          'close session before workspace archive failed',
        );
      }
    }

    const result = await Session.updateMany(
      { _id: { $in: matched.map((doc) => doc._id) }, archivedAt: null, ...actorFilter(userId) },
      { $set: { archivedAt: new Date() } },
    );
    return result.modifiedCount ?? 0;
  }

  async delete(id: string, userId: string, opts?: { skipAckWait?: boolean }): Promise<boolean> {
    const redis = getRedisClient();
    const session = await Session.findOne({ _id: id, ...actorFilter(userId) }).lean();
    if (!session) return false;

    // Stop ACP session first, then do worktree cleanup.
    // creating/connecting sessions also get acp:stop: the controller may be
    // about to spawn the ACP process, and skipping stop would orphan it.
    const needsStop = ['creating', 'connecting', 'running', 'idling'].includes(session.status);
    if (needsStop) {
      // Drop any stale ack (e.g. written by a user_close acp:stopped) so
      // waitForStopAck only consumes an ack produced after this stop request.
      await redis.del(`acp:stop:ack:${id}`);
      await publish('session:command', {
        type: 'acp:stop',
        sessionId: id,
        reason: 'user_delete',
      });
      if (!opts?.skipAckWait) {
        const stopAckReceived = await this.waitForStopAck(redis, id);
        if (!stopAckReceived) {
          logger.warn({ event: 'stop-ack-timeout', sessionId: id }, 'ACP stop ack timeout, proceeding with cleanup');
        }
      }
    }

    // Worktree cleanup if applicable
    if ((session as any).worktreePath && (session as any).worktreeBranch) {
      const sessionWorkspaceId = (session as any).controllerWorkspaceId;
      const workspace = sessionWorkspaceId
        ? await ControllerWorkspace.findOne({
            _id: sessionWorkspaceId,
            controllerId: session.controllerId,
          }).lean()
        : await ControllerWorkspace.findOne({
            controllerId: session.controllerId,
            ...actorFilter(userId),
          }).lean();
      const repoPath = workspace?.path || session.cwd || '';

      // 1. git:status — detect if clean
      const statusReqId = `gs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await publish('session:command', {
        type: 'git:status',
        requestId: statusReqId,
        controllerId: session.controllerId.toString(),
        path: (session as any).worktreePath,
      });

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
        await publish('session:command', {
          type: 'git:commit',
          requestId: commitReqId,
          controllerId: session.controllerId.toString(),
          path: (session as any).worktreePath,
          message: 'chore: workspace cleanup code stash',
        });
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
      await publish('session:command', {
        type: 'git:worktree:remove',
        requestId: rmReqId,
        controllerId: session.controllerId.toString(),
        repoPath,
        worktreePath: (session as any).worktreePath,
      });

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
    const result = await Session.findOneAndDelete({ _id: id, ...actorFilter(userId) });
    if (result) {
      await AcpMessage.deleteMany({ sessionId: id });
      await SessionInteraction.deleteMany({ sessionId: id });
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
    const session = await Session.findOne({ _id: sessionId, ...actorFilter(userId) }).lean();
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

  async addMessage(sessionId: string, message: { direction: string; type: string; content: unknown; metadata?: string; parts?: PromptPartInput[] }): Promise<Record<string, unknown>> {
    let contentValue = message.content;
    let metadata = message.metadata;
    let keptParts: PromptPartInput[] | undefined;
    if (message.parts !== undefined) {
      // 多片段输入（裁决 6/8）：服务端再过滤 trim 空文本片段 / 无 data 图片；
      // 过滤后全空抛 BAD_USER_INPUT('empty prompt')；合并文本写 content（标题取自合并文本）；
      // metadata = {parts}（全量含图片）；体积 >12MB 拒绝（Mongo 16MB 文档上限安全余量）。
      const kept = message.parts.filter((part) =>
        part.type === 'image'
          ? typeof part.data === 'string' && part.data.length > 0
          : typeof part.text === 'string' && part.text.trim() !== '',
      );
      if (kept.length === 0) {
        throw new GraphQLError('empty prompt', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      keptParts = kept;
      const sizeBytes = Buffer.byteLength(JSON.stringify(kept), 'utf8');
      if (sizeBytes > 12 * 1024 * 1024) {
        throw new GraphQLError('prompt parts too large', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      contentValue = kept
        .filter((part) => part.type === 'text')
        .map((part) => (part.text ?? '').trim())
        .join('\n\n');
      metadata = JSON.stringify({ parts: kept });
    }
    const acpMessage = await AcpMessage.create({
      sessionId,
      direction: message.direction as 'input' | 'output',
      type: message.type as 'text' | 'image' | 'tool_call' | 'tool_result' | 'plan' | 'error',
      content: typeof contentValue === 'string'
        ? (() => { try { return JSON.parse(contentValue); } catch { return { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: contentValue } }; } })()
        : contentValue,
      metadata,
    });

    // Set session title from first user message
    if (message.direction === 'input') {
      const messageCount = await AcpMessage.countDocuments({ sessionId, direction: 'input' });
      if (messageCount === 1) {
        // First user message - extract text content as title
        let title = contentValue as string;
        let parsedContent: Record<string, unknown> | null = null;
        if (typeof contentValue === 'string') {
          try {
            parsedContent = JSON.parse(contentValue);
          } catch { /* use raw content */ }
        } else {
          parsedContent = contentValue as Record<string, unknown>;
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

    // Publish to Redis for SSE（多片段输入时载荷携带 parts，controller-api 透传 acp:message）
    const redis = getRedisClient();
    publish('session:message', {
      sessionId,
      message: {
        ...mappedMessage,
        ...(keptParts && keptParts.length > 0 ? { parts: keptParts } : {}),
      },
    });

    return mappedMessage;
  }

  async getAcpCapabilities(controllerId: string, userId: string): Promise<Record<string, unknown>[]> {
    // Verify controller belongs to user
    const controller = await Controller.findOne({ _id: controllerId, ...actorFilter(userId) }).lean();
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
    await publish('session:command', {
      type: 'acp:check',
      requestId,
      controllerId,
    });

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
    opts?: { minProbedAt?: number },
  ): Promise<Record<string, unknown>> {
    const controller = await Controller.findOne({ _id: controllerId, ...actorFilter(userId) }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }

    const redis = getRedisClient();
    const cacheKey = `acp:options:${controllerId}:${acpServerType}`;
    // C-9：刷新时只接受「本次删除之后」的探测结果，避免并发探测把旧结果写回后立即被读走。
    // 允许 5s 时钟偏差（controller-api 与 agent-api 可能不同宿主）。
    const isFresh = (payload: Record<string, unknown>): boolean => {
      if (!opts?.minProbedAt) return true;
      const probedAt = Date.parse(String(payload.probedAt ?? ''));
      return Number.isFinite(probedAt) && probedAt >= opts.minProbedAt - 5_000;
    };

    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as Record<string, unknown>;
      if (isFresh(parsed)) return parsed;
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await publish('session:command', {
      type: 'acp:probe-options',
      requestId,
      controllerId,
      serverType: acpServerType,
    });

    for (let i = 0; i < 70; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const result = await redis.get(cacheKey);
      if (result) {
        const parsed = JSON.parse(result) as Record<string, unknown>;
        if (isFresh(parsed)) return parsed;
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
    const controller = await Controller.findOne({ _id: controllerId, ...actorFilter(userId) }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }
    const startedAt = Date.now();
    try {
      await getRedisClient().del(`acp:options:${controllerId}:${acpServerType}`);
    } catch (err) {
      // C-9：删除失败不能静默回退到旧缓存（用户点「刷新」却看到陈旧结果）
      logger.warn(
        { event: 'delete-acp-options-failed', controllerId, err },
        'delete acp options cache failed',
      );
      throw new Error('刷新失败，请重试');
    }
    return this.getAcpServerOptions(controllerId, acpServerType, userId, {
      minProbedAt: startedAt,
    });
  }

  async refreshAcpCapabilities(controllerId: string, userId: string): Promise<Record<string, unknown>[]> {
    const controller = await Controller.findOne({ _id: controllerId, ...actorFilter(userId) }).lean();
    if (!controller) {
      throw new Error('Controller not found');
    }

    const redis = getRedisClient();

    // Delete Redis cache
    await redis.del(`acp:capability:${controllerId}`);

    // Notify controller-api to invalidate its in-memory cache
    await publish('session:command', {
      type: 'acp:cache:invalidate',
      controllerId,
    });

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
      // 归档状态（契约 `Session.archived`；不透出 archivedAt 原文）
      archived: Boolean(session.archivedAt),
      // 项目工作区归属（契约外内部字段：`readOnlyReason` 字段 resolver 实时判定用，GraphQL 不会返回）
      controllerWorkspaceId: session.controllerWorkspaceId
        ? String(session.controllerWorkspaceId)
        : null,
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
