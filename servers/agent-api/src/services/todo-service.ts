import { TodoItem } from '../models/todo-item.js';
import { Session } from '../models/session.js';
import { User } from '../models/user.js';

interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

interface PermissionToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  locations?: Array<{ path: string; line?: number }>;
}

interface PermissionRequestData {
  requestId: string;
  controllerId: string;
  sessionId: string;
  userId: string;
  toolCall: PermissionToolCall;
  options: PermissionOption[];
}

interface ElicitationRequestData {
  requestId: string;
  controllerId: string;
  sessionId: string;
  userId: string;
  mode: 'form' | 'url';
  message: string;
  toolCallId?: string;
  requestedSchema?: { title?: string } & Record<string, unknown>;
  elicitationId?: string;
  url?: string;
}

const SUMMARY_MAX_LENGTH = 200;

export type ElicitationResolution = 'accepted' | 'declined' | 'cancelled' | 'expired' | 'failed';

/** harness 登录引导：required 事件（controller-api 经 Redis 透传，userId 已注入） */
export interface HarnessLoginRequestData {
  requestId: string;
  controllerId: string;
  userId: string;
  sessionId?: string;
  serverType: string;
  trigger: string;
  url: string;
  userCode: string;
  expiresInSeconds?: number;
}

const HARNESS_LOGIN_DEFAULT_EXPIRES_SECONDS = 1800;

/** 终态写入的归属目标：userId 必填（租户隔离），requestId 缺失时用 sessionId 会话级兜底 */
export interface ElicitationResolvedTarget {
  userId: string;
  sessionId?: string;
}

export class TodoService {
  async createPermissionTodo(data: PermissionRequestData): Promise<InstanceType<typeof TodoItem>> {
    const todo = await TodoItem.create({
      userId: data.userId,
      type: 'permission_request',
      priority: 'immediate',
      title: `Agent请求权限：${data.toolCall.title || data.toolCall.toolCallId}`,
      description: this.summarizeToolCall(data.toolCall),
      data: {
        requestId: data.requestId,
        sessionId: data.sessionId,
        toolCallId: data.toolCall.toolCallId,
        toolCall: data.toolCall,
        options: data.options,
      },
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    return todo;
  }

  private summarizeToolCall(toolCall: PermissionToolCall): string {
    const rawInput = (toolCall.rawInput ?? {}) as Record<string, unknown>;
    const parts: string[] = [];

    if (toolCall.kind === 'execute' && typeof rawInput.command === 'string') {
      parts.push(`执行命令：${rawInput.command}`);
    } else if (['read', 'edit', 'write', 'delete', 'move'].includes(toolCall.kind ?? '') && typeof rawInput.path === 'string') {
      parts.push(`操作文件：${rawInput.path}`);
    }

    if (toolCall.locations && toolCall.locations.length > 0) {
      parts.push(`涉及位置：${toolCall.locations.map((loc) => loc.path).join('、')}`);
    }

    if (parts.length === 0) {
      parts.push(`工具调用 ${toolCall.title || toolCall.toolCallId} 请求权限`);
    }

    const summary = parts.join('；');
    return summary.length > SUMMARY_MAX_LENGTH
      ? `${summary.slice(0, SUMMARY_MAX_LENGTH - 3)}...`
      : summary;
  }

  /**
   * 工作流节点人工介入待办（强提醒）：节点会话停滞升级为 FAILED 时创建。
   * immediate 优先级 + 未读，待办列表与全局提醒立即可见。
   */
  async createWorkflowInterventionTodo(data: {
    userId: string;
    instanceId: string;
    instanceName: string;
    nodeId: string;
    nodeName: string;
    sessionId: string;
    reason: string;
  }): Promise<InstanceType<typeof TodoItem>> {
    const todo = await TodoItem.create({
      userId: data.userId,
      type: 'workflow_intervention',
      priority: 'immediate',
      title: `工作流节点「${data.nodeName}」需要人工介入`,
      description: `实例「${data.instanceName}」：${data.reason}。请打开工作流实例查看并处理（重启节点或在会话中给出指示）。`,
    });

    return todo;
  }

  async createElicitationTodo(data: ElicitationRequestData): Promise<InstanceType<typeof TodoItem>> {
    const todo = await TodoItem.create({
      userId: data.userId,
      type: 'elicitation_request',
      priority: 'immediate',
      title: `Agent请求输入：${data.mode === 'url' ? '打开链接授权' : (data.requestedSchema?.title || '填写信息')}`,
      description: data.message,
      elicitationData: {
        requestId: data.requestId,
        sessionId: data.sessionId,
        toolCallId: data.toolCallId,
        mode: data.mode,
        message: data.message,
        requestedSchema: data.requestedSchema,
        elicitationId: data.elicitationId,
        url: data.url,
      },
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    return todo;
  }

  /**
   * harness 登录引导待办（Kimi Code 需要登录）。
   *
   * 幂等：同一 `requestId + userId` 重复 required 不重复建（`$setOnInsert` upsert），
   * 返回值 `created=false` 时调用方不得重复推送 SSE。优先级 immediate（铃铛即时可见）。
   */
  async createHarnessLoginTodo(
    data: HarnessLoginRequestData,
  ): Promise<{ todo: InstanceType<typeof TodoItem>; created: boolean }> {
    const expiresInSeconds = Number.isFinite(data.expiresInSeconds) && (data.expiresInSeconds ?? 0) > 0
      ? (data.expiresInSeconds as number)
      : HARNESS_LOGIN_DEFAULT_EXPIRES_SECONDS;
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

    const result = await TodoItem.findOneAndUpdate(
      { userId: data.userId, 'harnessLoginData.requestId': data.requestId },
      {
        $setOnInsert: {
          userId: data.userId,
          type: 'harness_login_request',
          priority: 'immediate',
          title: 'Kimi Code 需要登录',
          description: 'Kimi Code 尚未登录，完成登录后原操作会自动继续。',
          isRead: false,
          harnessLoginData: {
            requestId: data.requestId,
            controllerId: data.controllerId,
            sessionId: data.sessionId,
            serverType: data.serverType,
            trigger: data.trigger,
            url: data.url,
            userCode: data.userCode,
            expiresAt,
          },
          expiresAt,
        },
      },
      { upsert: true, new: true, includeResultMetadata: true },
    );

    return {
      todo: result.value as InstanceType<typeof TodoItem>,
      created: !result.lastErrorObject?.updatedExisting,
    };
  }

  async getTodoList(userId: string): Promise<InstanceType<typeof TodoItem>[]> {
    return TodoItem.find({ userId })
      .sort({ priority: 1, createdAt: -1 })
      .limit(100);
  }

  async getUnreadTodoCount(userId: string): Promise<number> {
    return TodoItem.countDocuments({ userId, isRead: false });
  }

  async markTodoRead(userId: string, todoId: string): Promise<boolean> {
    const result = await TodoItem.updateOne(
      { _id: todoId, userId },
      { $set: { isRead: true } },
    );
    return result.modifiedCount > 0;
  }

  async markAllTodoRead(userId: string): Promise<boolean> {
    const result = await TodoItem.updateMany(
      { userId, isRead: false },
      { $set: { isRead: true } },
    );
    return result.modifiedCount > 0;
  }

  /**
   * 响应前置归属校验：确认 requestId 属于该用户且仍可响应。
   * 权限待办无 resolution 字段，只校验归属；问询必须仍未终结。
   */
  async isRespondableTodo(
    userId: string,
    requestId: string,
    type: 'permission_request' | 'elicitation_request' | 'harness_login_request',
  ): Promise<boolean> {
    if (!userId || !requestId) return false;
    let filter: Record<string, unknown>;
    if (type === 'elicitation_request') {
      filter = { userId, 'elicitationData.requestId': requestId, resolution: null };
    } else if (type === 'harness_login_request') {
      filter = { userId, 'harnessLoginData.requestId': requestId, resolution: null };
    } else {
      filter = { userId, 'data.requestId': requestId };
    }
    return (await TodoItem.countDocuments(filter)) > 0;
  }

  async markTodoAsResponded(requestId: string, userId: string): Promise<boolean> {
    // 缺 userId 时直接拒绝：Mongoose 会剥离 undefined 条件，静默退化为「匹配任意租户」
    if (!userId) return false;
    const result = await TodoItem.updateOne(
      {
        userId,
        $or: [
          { 'data.requestId': requestId },
          { 'elicitationData.requestId': requestId },
          { 'harnessLoginData.requestId': requestId },
        ],
      },
      { $set: { isRead: true } },
    );
    return (result.modifiedCount ?? 0) > 0;
  }

  async markElicitationCompleted(elicitationId: string, userId: string): Promise<boolean> {
    if (!userId) return false;
    const result = await TodoItem.updateOne(
      { 'elicitationData.elicitationId': elicitationId, userId },
      { $set: { isRead: true } },
    );
    return (result.modifiedCount ?? 0) > 0;
  }

  /**
   * 写入问询终态（用户响应 / 超时 / 取消 / 链路不支持）。
   *
   * 数据层强制两个不变量：
   * 1. 归属：必须带 userId，缺失直接拒绝写入（防止持有他人 requestId 的调用方越权改写）；
   * 2. 单调：条件 `resolution: null` 只允许「待处理 → 终态」，accepted/declined/cancelled
   *    不会被迟到的 timeout/unsupported 事件覆盖。
   *
   * requestId 缺失（旧 controller / 模式不支持的早期事件）时按 sessionId + userId 做会话级兜底收敛。
   * 找不到待办（如已被 TTL 清理）时 modifiedCount=0，幂等不抛错。
   */
  async markElicitationResolved(
    requestId: string | undefined,
    resolution: ElicitationResolution,
    target: ElicitationResolvedTarget,
  ): Promise<number> {
    if (!target.userId) return 0;

    const filter: Record<string, unknown> = {
      userId: target.userId,
      resolution: null,
    };
    if (requestId) {
      filter['elicitationData.requestId'] = requestId;
    } else if (target.sessionId) {
      filter['elicitationData.sessionId'] = target.sessionId;
    } else {
      return 0;
    }

    // 会话级兜底可能同时存在多条未终结问询：用 updateMany 全部收敛，而非只命中第一条
    const result = requestId
      ? await TodoItem.updateOne(filter, { $set: { resolution, resolvedAt: new Date(), isRead: true } })
      : await TodoItem.updateMany(filter, { $set: { resolution, resolvedAt: new Date(), isRead: true } });
    return result.modifiedCount ?? 0;
  }

  /**
   * 写入 harness 登录引导终态（登录成功 / 取消 / 超时 / 检查失败）。
   *
   * 与问询终态同口径：filter 必须同时含 `userId`（租户隔离）与 `resolution: null`（单调），
   * 迟到的 resolved 不会覆盖已终结状态；收敛时置 `isRead=true`（铃铛计数归零）。
   */
  async markHarnessLoginResolved(
    requestId: string,
    resolution: ElicitationResolution,
    target: { userId: string },
  ): Promise<number> {
    if (!target.userId || !requestId) return 0;
    const result = await TodoItem.updateOne(
      { userId: target.userId, 'harnessLoginData.requestId': requestId, resolution: null },
      { $set: { resolution, resolvedAt: new Date(), isRead: true } },
    );
    return result.modifiedCount ?? 0;
  }

  async getTimeoutAction(userId: string, sessionId?: string | null): Promise<string> {
    if (sessionId) {
      const session = await Session.findById(sessionId);
      if (session?.permissionTimeoutAction && session.permissionTimeoutAction !== 'use_global') {
        return session.permissionTimeoutAction;
      }
    }

    const user = await User.findById(userId);
    if (user?.globalPermissionTimeoutAction) {
      return user.globalPermissionTimeoutAction;
    }

    return 'allow_once';
  }

  async updatePermissionTimeout(userId: string, sessionId: string | null, timeoutAction: string): Promise<boolean> {
    if (sessionId) {
      const result = await Session.updateOne(
        { _id: sessionId, userId },
        { $set: { permissionTimeoutAction: timeoutAction } },
      );
      return result.modifiedCount > 0;
    }
    return false;
  }

  async updateGlobalPermissionTimeout(userId: string, timeoutAction: string): Promise<boolean> {
    const result = await User.updateOne(
      { _id: userId },
      { $set: { globalPermissionTimeoutAction: timeoutAction } },
    );
    return result.modifiedCount > 0;
  }
}

export const todoService = new TodoService();
