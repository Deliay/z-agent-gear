import { GraphQLError } from 'graphql';
import {
  cloudControllerClient,
  mapCloudContainer,
  ControlPlaneUnavailableError,
  CONTROL_PLANE_UNAVAILABLE,
  type CloudContainerDTO,
} from '../../services/cloud-controller-client.js';
import { findStoredCloudContainers } from '../../models/cloud-container.js';
import { assertAdmin } from './guard.js';
import type { AdminAuthContext } from './auth.js';

/** 控制面离线提示文案；经 CloudContainerControlPlane.message 下发给前端。 */
const CONTROL_PLANE_OFFLINE_HINT = '控制面离线';

function isControlPlaneUnavailable(err: unknown): boolean {
  return (
    err instanceof ControlPlaneUnavailableError ||
    (err as { code?: string } | null)?.code === CONTROL_PLANE_UNAVAILABLE
  );
}

function toGraphQLError(err: unknown): GraphQLError {
  if (err instanceof GraphQLError) return err;
  if (isControlPlaneUnavailable(err)) {
    return new GraphQLError('控制面不可用，请稍后重试', {
      extensions: { code: CONTROL_PLANE_UNAVAILABLE },
    });
  }
  return new GraphQLError((err as Error).message);
}

/**
 * 一次查询共享的列表加载结果。`degraded=true` 表示本次列表确因控制面不可达降级读落库数据。
 */
interface ContainersLoad {
  containers: CloudContainerDTO[];
  degraded: boolean;
}

type CloudContainerContext = AdminAuthContext & { __containersLoad?: Promise<ContainersLoad> };

/**
 * 请求级共享加载：`adminCloudContainers` 与 `adminCloudContainerControlPlane` 复用同一 Promise，
 * 保证「本次列表降级 ⇒ 同一次查询的 online=false」硬耦合，不存在「降级但 online 仍为 true」的窗口。
 * 由于 GraphQL 两个字段的执行顺序不保证，这里用 memoized Promise 而非先后写标记。
 */
function loadContainers(context: CloudContainerContext): Promise<ContainersLoad> {
  if (context.__containersLoad) return context.__containersLoad;

  const load = (async (): Promise<ContainersLoad> => {
    try {
      return { containers: await cloudControllerClient.list(), degraded: false };
    } catch (err) {
      if (!isControlPlaneUnavailable(err)) throw toGraphQLError(err);
      // 列表读操作降级：控制面不可达时直读 Mongo 落库状态（裁决 12），仅只读、不双写
      console.warn(`[admin-api] cloud-controller 不可达，降级读取 Mongo 落库状态（${CONTROL_PLANE_OFFLINE_HINT}）`);
      const docs = await findStoredCloudContainers();
      return { containers: docs.map((doc) => mapCloudContainer(doc)), degraded: true };
    }
  })();

  context.__containersLoad = load;
  return load;
}

export const cloudContainerResolvers = {
  Query: {
    adminCloudContainers: async (_parent: unknown, _args: unknown, context: AdminAuthContext) => {
      assertAdmin(context);
      return (await loadContainers(context)).containers;
    },
    adminCloudContainerControlPlane: async (
      _parent: unknown,
      _args: unknown,
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      // 与列表共用同一次加载：online 直接由「本次是否降级」决定，避免与降级事件脱钩
      const { degraded } = await loadContainers(context);
      return { online: !degraded, message: degraded ? CONTROL_PLANE_OFFLINE_HINT : null };
    },
  },
  Mutation: {
    adminStartCloudContainer: async (
      _parent: unknown,
      args: { purpose: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      // 本期仅支持 IDLE（裁决 10）；契约字段保留供后续迭代
      if (args.purpose !== 'IDLE') {
        throw new GraphQLError('该任务类型暂未开放');
      }
      try {
        return await cloudControllerClient.start(args.purpose);
      } catch (err) {
        throw toGraphQLError(err);
      }
    },
    adminDestroyCloudContainer: async (
      _parent: unknown,
      args: { id: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      try {
        return await cloudControllerClient.destroy(args.id);
      } catch (err) {
        throw toGraphQLError(err);
      }
    },
  },
};
