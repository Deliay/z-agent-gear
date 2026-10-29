import { AsyncLocalStorage } from 'node:async_hooks';

/** 租户角色（tenantmembers.role）；personal 租户唯一成员恒 admin。 */
export const TENANT_ROLES = ['admin', 'developer'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

/** 工作区类型（workspaces.type）。 */
export const WORKSPACE_TYPES = ['global', 'normal'] as const;
export type WorkspaceType = (typeof WORKSPACE_TYPES)[number];

/**
 * 请求级工作区上下文（多租户二期，F7 裁决）。
 *
 * Mongoose 插件无法直接读到 GraphQL context，因此以 `AsyncLocalStorage` 承载：
 * - `middleware/auth`（GraphQL context 工厂）解析 `x-workspace-id` 后写入；
 * - `services/workspace-scope.ts` 的查询钩子在同一个异步链上读取；
 * - 工作流引擎 / 内部端点 / 迁移脚本**没有 store**，插件不注入也不校验（显式传值）。
 */
export interface WorkspaceContext {
  /** 当前工作区 id */
  id: string;
  /** 工作区所属租户 id（计费 owner 与租户成员判定口径） */
  tenantId: string;
  type: WorkspaceType;
  /** 当前用户在该租户的角色 */
  role: TenantRole;
  /** 只读：`type='global' && role='developer'`（一次判定，插件统一写拦截） */
  readOnly: boolean;
  /** 本租户全局工作区 id（共享型资源读口径 `[当前, 全局]`） */
  globalWorkspaceId: string;
}

const storage = new AsyncLocalStorage<WorkspaceContext | undefined>();

/** 写入请求级上下文（GraphQL context 工厂调用；不改变当前异步链归属）。 */
export function enterWithWorkspace(context: WorkspaceContext | undefined): void {
  storage.enterWith(context);
}

/** `als.run` 包裹（供非 GraphQL 入口或测试使用）。 */
export function runWithWorkspace<T>(context: WorkspaceContext | undefined, fn: () => T): T {
  return storage.run(context, fn);
}

/** 读取当前请求上下文；无 store（引擎/内部/迁移）返回 undefined。 */
export function getWorkspaceContext(): WorkspaceContext | undefined {
  return storage.getStore();
}

/** 共享型资源（providers/models/githubaccounts）可见集：当前 ∪ 本租户全局。 */
export function sharedVisibleWorkspaceIds(context: WorkspaceContext): string[] {
  return context.type === 'global'
    ? [context.id]
    : [context.id, context.globalWorkspaceId];
}

/** 独占型资源可见集：仅当前工作区（admin 需切换到目标工作区上下文）。 */
export function exclusiveVisibleWorkspaceIds(context: WorkspaceContext): string[] {
  return [context.id];
}

/**
 * 可见性过滤助手（多租户二期，D5）：请求级工作区上下文存在时，服务层不再用 `userId` 过滤
 * （工作区成员可读写本工作区全部资源，含他人创建）；无上下文（引擎/内部/迁移）时保留
 * `userId` 归属校验，避免后台链路越权。
 */
export function actorFilter(userId: string): Record<string, unknown> {
  return getWorkspaceContext() ? {} : { userId };
}

/** 工作流模板等「创建者自有 ∪ 内置」查询：有上下文时交给插件 builtinVisible，无上下文回退 userId。 */
export function actorOrBuiltinFilter(userId: string): Record<string, unknown> {
  return getWorkspaceContext()
    ? {}
    : { $or: [{ userId }, { isBuiltin: true }] };
}

/**
 * 只读上下文断言（服务层辅助，插件之外的第二道防线）：
 * 全局工作区 + developer 的一切写操作拒绝。
 */
export const WORKSPACE_READ_ONLY_MESSAGE = 'global workspace is read-only';

export function assertWorkspaceWritable(context: WorkspaceContext | undefined): void {
  if (context?.readOnly) {
    throw new Error(WORKSPACE_READ_ONLY_MESSAGE);
  }
}
