import { GraphQLError } from 'graphql';
import {
  cloudControllerClient,
  ControlPlaneUnavailableError,
  CONTROL_PLANE_UNAVAILABLE,
} from '../../services/cloud-controller-client.js';
import {
  cloudWorkloadService,
  mapWorkloadLog,
  type CreateCloudWorkloadInput,
  type UpdateCloudWorkloadInput,
} from '../../services/cloud-workload.js';
import { assertAdmin } from './guard.js';
import type { AdminAuthContext } from './auth.js';

/** 控制面离线提示文案（与容器列表降级口径一致） */
const CONTROL_PLANE_OFFLINE_HINT = '控制面离线';

function isDuplicateKeyError(err: unknown): boolean {
  return (err as Error).message.includes('E11000');
}

function isControlPlaneUnavailable(err: unknown): boolean {
  return (
    err instanceof ControlPlaneUnavailableError ||
    (err as { code?: string } | null)?.code === CONTROL_PLANE_UNAVAILABLE
  );
}

export const cloudWorkloadResolvers = {
  Query: {
    adminCloudWorkloads: async (_parent: unknown, _args: unknown, context: AdminAuthContext) => {
      assertAdmin(context);
      return cloudWorkloadService.list();
    },
    adminCloudContainerWorkloadLogs: async (
      _parent: unknown,
      args: { containerId: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      try {
        // 优先经 cloud-controller 内部 API（单一事实源）
        const raw = await cloudControllerClient.listWorkloadLogs(args.containerId);
        return raw.map((record) => mapWorkloadLog(record));
      } catch (err) {
        if (!isControlPlaneUnavailable(err)) {
          throw new GraphQLError((err as Error).message);
        }
        // 降级直读 Mongo 只读模型（与容器列表降级同口径，裁决 14）
        console.warn(
          `[admin-api] cloud-controller 不可达，降级直读 Mongo 工作负载日志（${CONTROL_PLANE_OFFLINE_HINT}）`,
        );
        return cloudWorkloadService.listByContainerLogs(args.containerId);
      }
    },
  },
  Mutation: {
    adminCreateCloudWorkload: async (
      _parent: unknown,
      args: { input: CreateCloudWorkloadInput },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      try {
        return await cloudWorkloadService.create(args.input);
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          throw new GraphQLError('Workload name already exists');
        }
        throw new GraphQLError((err as Error).message);
      }
    },
    adminUpdateCloudWorkload: async (
      _parent: unknown,
      args: { id: string; input: UpdateCloudWorkloadInput },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      try {
        const result = await cloudWorkloadService.update(args.id, args.input);
        if (!result) {
          throw new GraphQLError('Workload not found');
        }
        return result;
      } catch (err) {
        if (err instanceof GraphQLError) throw err;
        if (isDuplicateKeyError(err)) {
          throw new GraphQLError('Workload name already exists');
        }
        throw new GraphQLError((err as Error).message);
      }
    },
    adminDeleteCloudWorkload: async (
      _parent: unknown,
      args: { id: string },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      return cloudWorkloadService.delete(args.id);
    },
  },
};
