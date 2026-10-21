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

  async markTodoAsResponded(requestId: string, userId: string): Promise<boolean> {
    const result = await TodoItem.updateOne(
      {
        userId,
        $or: [{ 'data.requestId': requestId }, { 'elicitationData.requestId': requestId }],
      },
      { $set: { isRead: true } },
    );
    return (result.modifiedCount ?? 0) > 0;
  }

  async markElicitationCompleted(elicitationId: string, userId: string): Promise<boolean> {
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

    const result = await TodoItem.updateOne(
      filter,
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
