import { GraphQLError } from 'graphql';
import mongoose from 'mongoose';
import { Session } from '../../models/session.js';
import { logger as rootLogger } from '../../observability/logger.js';
import { controllerService } from '../../services/controller.js';
import { controllerWorkspaceService } from '../../services/controller-workspace.js';
import { sessionService } from '../../services/session.js';
import { workflowInstanceService } from '../../services/workflow/instance.js';
import { todoService } from '../../services/todo-service.js';
import { sessionReviewService } from '../../services/session-review-service.js';
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
    rootLogger.error({ component: 'home', branch: label, err }, 'homeOverview branch degraded');
    return fallback;
  }
}

const WORKTREE_FANOUT_TIMEOUT_MS = 5000;

/** 为可能长时间等待 Redis relay 的扇出加超时兜底，避免拖垮首页首屏 */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export const homeResolvers = {
  Query: {
    // 薄聚合 resolver：并行组合既有 service，不新增 service 层
    homeOverview: async (_parent: unknown, _args: unknown, context: AuthContext) => {
      if (!context.currentUser) {
        throw new GraphQLError('Not authenticated');
      }
      const userId = context.currentUser.id;
      const [
        controllers,
        sessions,
        archivedSessionDocs,
        workspaces,
        activeDocs,
        archivedDocs,
        todos,
        unreadTodoCount,
        sessionReviews,
      ] = await Promise.all([
        degrade<Doc[]>(
          async () => (await controllerService.findAllByUser(userId)) as Doc[],
          [],
          'controllers',
        ),
        degrade<Doc[]>(
          async () =>
            (await sessionService.findAllByUser(userId, {
              includeWorkflowSessions: false,
              archived: false,
            })) as Doc[],
          [],
          'sessions',
        ),
        // 侧边栏「已归档」分组：与活跃 sessions 口径互补，单分支失败降级 []
        degrade<Doc[]>(
          async () =>
            (await sessionService.findAllByUser(userId, {
              includeWorkflowSessions: false,
              archived: true,
            })) as Doc[],
          [],
          'archivedSessions',
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
        // Review 列表（PENDING 在前、终态 resolvedAt 倒序、上限 20）；单分支失败降级 []；
        // B3：批量补齐 sessionTitle（侧边栏辨识来源会话）
        degrade<Doc[]>(
          async () => {
            const reviews = (await sessionReviewService.listByUser(userId)) as unknown as Doc[];
            const sessionIds = [
              ...new Set(reviews.map((review) => String(review.sessionId)).filter((value) => mongoose.isValidObjectId(value))),
            ];
            const sessions = await Session.find({ _id: { $in: sessionIds } })
              .select('title')
              .lean();
            const titleById = new Map(sessions.map((session) => [String(session._id), (session as Doc).title ?? null]));
            return reviews.map((review) => ({
              ...review,
              sessionTitle: titleById.get(String(review.sessionId)) ?? null,
            }));
          },
          [],
          'sessionReviews',
        ),
      ]);

      return {
        controllers,
        sessions,
        sessionTotalCount: sessions.length,
        archivedSessions: archivedSessionDocs,
        workspaces,
        workflowInstances: activeDocs.map((doc) => mapInstance(doc)),
        archivedWorkflowInstances: archivedDocs.map((doc) => mapInstance(doc)),
        todos,
        unreadTodoCount,
        sessionReviews,
      };
    },
  },
  Controller: {
    // 嵌套惰性解析：仅查询语句选择 gateways 时执行（纯 DB 查询，不随控制器在线状态降级）；失败降级为空列表
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
        () =>
          withTimeout(
            worktreeService.list(String(parent.controllerId), String(parent.id), userId),
            WORKTREE_FANOUT_TIMEOUT_MS,
            [],
          ),
        [],
        `ControllerWorkspace(${String(parent.id)}).worktrees`,
      );
    },
  },
};
