import { GraphQLError } from 'graphql';
import {
  cloudControllerClient,
  mapCloudContainer,
  ControlPlaneUnavailableError,
  CONTROL_PLANE_UNAVAILABLE,
} from '../../services/cloud-controller-client.js';
import { findStoredCloudContainers } from '../../models/cloud-container.js';
import { assertAdmin } from './guard.js';
import type { AdminAuthContext } from './auth.js';

/** 控制面离线提示：契约不新增字段，只能经服务端日志透出（前端按数据自行判断） */
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

export const cloudContainerResolvers = {
  Query: {
    adminCloudContainers: async (_parent: unknown, _args: unknown, context: AdminAuthContext) => {
      assertAdmin(context);
      try {
        return await cloudControllerClient.list();
      } catch (err) {
        // 列表读操作降级：控制面不可达时直读 Mongo 落库状态（裁决 12），仅只读、不双写
        if (!isControlPlaneUnavailable(err)) throw toGraphQLError(err);
        console.warn(`[admin-api] cloud-controller 不可达，降级读取 Mongo 落库状态（${CONTROL_PLANE_OFFLINE_HINT}）`);
        const docs = await findStoredCloudContainers();
        return docs.map((doc) => mapCloudContainer(doc));
      }
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
