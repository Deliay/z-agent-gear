import { GraphQLError } from 'graphql';
import {
  cloudControllerClient,
  mapCloudContainer,
  ControlPlaneUnavailableError,
  CONTROL_PLANE_UNAVAILABLE,
  type CloudContainerDTO,
} from '../../services/cloud-controller-client.js';
import { findStoredCloudContainers } from '../../models/cloud-container.js';
import { cloudWorkloadService, type CloudWorkloadDTO } from '../../services/cloud-workload.js';
import { resolveWorkloadPlan } from '../../services/workload-plan.js';
import { accountService } from '../../services/billing/account-service.js';
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
export interface ContainersLoad {
  containers: CloudContainerDTO[];
  degraded: boolean;
}

export type CloudContainerContext = AdminAuthContext & {
  __containersLoad?: Promise<ContainersLoad>;
  __workloadsLoad?: Promise<Map<string, CloudWorkloadDTO>>;
};

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

/**
 * 请求级共享加载：一次查询内所有 `CloudContainer.workloads` 字段共用同一 Promise，
 * 收集本批容器的全部 `workloadIds` 后**只查一次** `cloudworkloads`（裁决 13，避免 N+1）。
 * 已删除的工作负载不在 Map 中，由字段 resolver 按 `workloadIds` 顺序过滤省略。
 */
function loadWorkloads(context: CloudContainerContext): Promise<Map<string, CloudWorkloadDTO>> {
  if (context.__workloadsLoad) return context.__workloadsLoad;

  const load = (async (): Promise<Map<string, CloudWorkloadDTO>> => {
    const { containers } = await loadContainers(context);
    const ids = new Set<string>();
    for (const container of containers) {
      for (const id of container.workloadIds ?? []) ids.add(id);
    }
    if (ids.size === 0) return new Map();
    const workloads = await cloudWorkloadService.getByIds([...ids]);
    return new Map(workloads.map((workload) => [workload.id, workload]));
  })();

  context.__workloadsLoad = load;
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
      args: {
        purpose: string;
        workloadIds?: string[];
        workloads?: Array<{ workloadId: string; params?: unknown; required?: boolean }>;
        billingAccountId?: string;
      },
      context: AdminAuthContext,
    ) => {
      assertAdmin(context);
      // 本期仅支持 IDLE（裁决 10）；契约字段保留供后续迭代
      if (args.purpose !== 'IDLE') {
        throw new GraphQLError('该任务类型暂未开放');
      }

      // 计费归属（裁决 8）：未显式传入时缺省为当前管理员账户（get-or-create）
      const admin = context.currentAdmin!;
      const defaultAccount = await accountService.getOrCreate(
        'admin_user',
        admin.id,
        admin.username,
      );
      let billingAccountId = defaultAccount.id;
      let billingStatus = defaultAccount.status;
      if (args.billingAccountId) {
        const explicit = await accountService.getById(args.billingAccountId);
        if (!explicit) throw new GraphQLError('计费账户不存在');
        billingAccountId = explicit.id;
        billingStatus = explicit.status;
      }
      // PRD §3.5：账户被冻结 → 拒绝新的容器启动（已运行容器按欠费规则处理）
      if (billingStatus === 'frozen') {
        throw new GraphQLError('账户已冻结，无法启动容器；请先充值或联系管理员处理', {
          extensions: { code: 'ACCOUNT_FROZEN' },
        });
      }

      const workloadIds = args.workloadIds ?? [];
      const workloads = args.workloads ?? [];
      // workloadIds 与 workloads 二选一（裁决 13）
      if (workloadIds.length > 0 && workloads.length > 0) {
        throw new GraphQLError('workloadIds and workloads cannot both be provided');
      }

      try {
        if (workloads.length > 0) {
          const selectedIds = workloads.map((selection) => String(selection.workloadId));
          const seen = new Set<string>();
          for (const id of selectedIds) {
            if (seen.has(id)) throw new GraphQLError('duplicate workload selection');
            seen.add(id);
          }

          // 一次批量查询全部定义快照（含依赖链目标）→ 纯函数展开
          // （显式参数优先、隐式依赖用默认值、去重、拓扑排序）
          const definitions = await cloudWorkloadService.list();
          const plan = resolveWorkloadPlan(
            workloads.map((selection) => ({
              workloadId: String(selection.workloadId),
              params:
                selection.params && typeof selection.params === 'object' && !Array.isArray(selection.params)
                  ? (selection.params as Record<string, unknown>)
                  : {},
              // required 唯一语义（裁决 1）：仅显式 `=== true` 生效，非布尔/缺省按 false。
              required: selection.required === true,
            })),
            definitions.map((definition) => ({
              id: definition.id,
              paramSchema: definition.paramSchema,
              dependsOnWorkloadIds: definition.dependsOnWorkloadIds,
            })),
          );
          const derivedIds = plan.map((item) => item.workloadId);
          return await cloudControllerClient.start(args.purpose, plan, derivedIds, billingAccountId);
        }

        // 兼容旧调用：仅传 workloadIds，不携带 workloadPlan，由 cloud-controller 兜底展开；
        // 缺省/空数组行为与现状完全一致（裁决 20）
        return await cloudControllerClient.start(
          args.purpose,
          undefined,
          workloadIds,
          billingAccountId,
        );
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
  CloudContainer: {
    // 批量按 `workloadIds` 顺序解析（请求级只查一次库）；已删除的工作负载省略
    workloads: async (
      parent: CloudContainerDTO,
      _args: unknown,
      context: CloudContainerContext,
    ): Promise<CloudWorkloadDTO[]> => {
      const ids = parent.workloadIds ?? [];
      if (ids.length === 0) return [];
      const byId = await loadWorkloads(context);
      return ids
        .map((id) => byId.get(id))
        .filter((workload): workload is CloudWorkloadDTO => workload !== undefined);
    },
  },
};
