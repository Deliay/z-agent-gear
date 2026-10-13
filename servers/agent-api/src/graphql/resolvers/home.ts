import { GraphQLError } from 'graphql';
import { controllerService } from '../../services/controller.js';
import { controllerWorkspaceService } from '../../services/controller-workspace.js';
import { sessionService } from '../../services/session.js';
import { workflowInstanceService } from '../../services/workflow/instance.js';
import { todoService } from '../../services/todo-service.js';
import { gatewayService } from '../../services/gateway.js';
import { worktreeService } from '../../services/worktree.js';
import { mapInstance } from './workflow.js';
import type { AuthContext } from './auth.js';

type Doc = Record<string, unknown>;

/** 单个分支失败降级为兜底值（聚合查询不因某一路失败拖垮整次查询） */
async function degrade<T>(branch: () => Promise<T>, fallback: T, label: string): Promise<T> {
  try {
    return await branch();
  } catch (err) {
    console.error(`homeOverview 分支「${label}」失败，已降级：`, err);
    return fallback;
  }
}

export const homeResolvers = {
  Query: {
    // 薄聚合 resolver：并行组合既有 service，不新增 service 层
    homeOverview: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      const userId = context.currentUser.id;
      const [controllers, sessions, workspaces, activeDocs, archivedDocs, todos, unreadTodoCount] =
        await Promise.all([
          degrade<Doc[]>(
            async () => (await controllerService.findAllByUser(userId)) as Doc[],
            [],
            'controllers',
          ),
          degrade<Doc[]>(
            async () =>
              (await sessionService.findAllByUser(userId, {
                includeWorkflowSessions: false,
              })) as Doc[],
            [],
            'sessions',
          ),
          degrade<Doc[]>(
            async () => (await controllerWorkspaceService.findAllByUser(userId)) as Doc[],
            [],
            'workspaces',
          ),
          degrade<Doc[]>(
            async () =>
              (await workflowInstanceService.list(userId, { archived: false })) as unknown as Doc[],
            [],
            'workflowInstances',
          ),
          degrade<Doc[]>(
            async () =>
              (await workflowInstanceService.list(userId, { archived: true })) as unknown as Doc[],
            [],
            'archivedWorkflowInstances',
          ),
          degrade<Doc[]>(
            async () => (await todoService.getTodoList(userId)) as unknown as Doc[],
            [],
            'todos',
          ),
          degrade<number>(
            () => todoService.getUnreadTodoCount(userId),
            0,
            'unreadTodoCount',
          ),
        ]);

      return {
        controllers,
        sessions,
        sessionTotalCount: sessions.length,
        workspaces,
        workflowInstances: activeDocs.map((doc) => mapInstance(doc)),
        archivedWorkflowInstances: archivedDocs.map((doc) => mapInstance(doc)),
        todos,
        unreadTodoCount,
      };
    },
  },
  Controller: {
    // 嵌套惰性解析：仅查询语句选择 gateways 时执行；离线或失败降级为空列表
    gateways: async (parent: Doc, _args: unknown, context: AuthContext) => {
      const userId = context.currentUser?.id;
      if (!userId) {
        return { gateways: [], total: 0, limit: 0 };
      }
      return degrade(
        () => gatewayService.findAllByController(String(parent.id), userId),
        { gateways: [], total: 0, limit: 0 },
        `Controller(${String(parent.id)}).gateways`,
      );
    },
  },
  ControllerWorkspace: {
    // 嵌套惰性解析：仅查询语句选择 worktrees 时执行；离线或失败降级为空列表
    worktrees: async (parent: Doc, _args: unknown, context: AuthContext) => {
      const userId = context.currentUser?.id;
      if (!userId) {
        return [];
      }
      return degrade(
        () => worktreeService.list(String(parent.controllerId), String(parent.id), userId),
        [],
        `ControllerWorkspace(${String(parent.id)}).worktrees`,
      );
    },
  },
};
