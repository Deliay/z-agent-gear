import { TodoItem } from '../models/todo-item.js';
import { Session } from '../models/session.js';
import { User } from '../models/user.js';

interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

interface PermissionRequestData {
  requestId: string;
  controllerId: string;
  sessionId: string;
  userId: string;
  toolCall: { toolCallId: string };
  options: PermissionOption[];
}

export class TodoService {
  async createPermissionTodo(data: PermissionRequestData): Promise<InstanceType<typeof TodoItem>> {
    const todo = await TodoItem.create({
      userId: data.userId,
      type: 'permission_request',
      priority: 'immediate',
      title: 'Agent请求权限审批',
      description: `工具调用 ${data.toolCall.toolCallId} 请求权限`,
      data: {
        requestId: data.requestId,
        sessionId: data.sessionId,
        toolCallId: data.toolCall.toolCallId,
        options: data.options,
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

  async markTodoAsResponded(requestId: string): Promise<void> {
    await TodoItem.updateOne(
      { 'data.requestId': requestId },
      { $set: { isRead: true } },
    );
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
