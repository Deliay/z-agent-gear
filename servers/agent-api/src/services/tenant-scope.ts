import type mongoose from 'mongoose';

/**
 * 租户归属守卫插件（多租户一期）。
 *
 * 一期口径：带 `userId` 的集合**复制新增**同值 `tenantId`（personal 租户 `_id` 复用 userId，
 * 即 `tenantId == userId`），`userId` 字段与筛选全部保留；查询一律为 `tenantId + userId`
 * 双条件，写入同时落 `userId` 与 `tenantId`。
 *
 * 为什么用插件而不是逐个改 400+ 过滤点：一期两值恒等，插件在 Mongoose 查询编译前统一注入
 * `tenantId`，可**保证不漏点**（漏一个过滤点就是越权红线），且所有写入（save/insertMany/
 * update 的 `$set.userId`）自动补齐 `tenantId`。二期团队租户放开 userId 维度时，可在插件中
 * 改为按请求上下文 tenantId（`getTenantId()`）覆盖，不影响现有调用面。
 *
 * 约束：
 * - 只对声明了 `userId` 与 `tenantId` 的 schema 生效；
 * - 显式传入 `tenantId` 的查询/更新不覆盖（支持跨租户/运维场景）；
 * - `aggregate` 不走本插件（一期运行时无按 userId 的 aggregate，迁移脚本自行显式处理）。
 */

type AnyQuery = {
  getFilter: () => Record<string, unknown>;
  setQuery: (filter: Record<string, unknown>) => void;
  getUpdate?: () => Record<string, unknown> | undefined;
};

const QUERY_HOOKS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'replaceOne',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'countDocuments',
  'distinct',
] as const;

const WRITE_UPDATE_HOOKS = ['findOneAndUpdate', 'replaceOne', 'updateOne', 'updateMany'] as const;

/** 查询过滤条件补齐 tenantId=userId（显式 tenantId 优先）。 */
export function injectFilter(query: AnyQuery): void {
  const filter = query.getFilter?.() ?? {};
  if (!filter || typeof filter !== 'object') return;
  if (filter.userId === undefined || filter.userId === null) return;
  if (filter.tenantId !== undefined) return;
  query.setQuery({ ...filter, tenantId: filter.userId });
}

/** 更新文档补齐 tenantId（$set.userId 存在且 $set.tenantId 缺失时）。 */
export function injectUpdate(query: AnyQuery): void {
  const update = query.getUpdate?.();
  if (!update || typeof update !== 'object') return;
  const set = (update as Record<string, unknown>).$set;
  if (!set || typeof set !== 'object') return;
  const setObj = set as Record<string, unknown>;
  if (setObj.userId === undefined || setObj.tenantId !== undefined) return;
  (update as Record<string, unknown>).$set = { ...setObj, tenantId: setObj.userId };
}

// Mongoose v9 的 pre() 重载对「钩子数组」类型推断不友好，这里以结构化 any 调用。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyTenantScope(schema: any): void {
  if (!schema.path('userId') || !schema.path('tenantId')) return;

  schema.pre(QUERY_HOOKS, function tenantScopeFilter(this: unknown, next: () => void) {
    injectFilter(this as AnyQuery);
    next();
  });

  schema.pre(WRITE_UPDATE_HOOKS, function tenantScopeUpdate(this: unknown, next: () => void) {
    injectFilter(this as AnyQuery);
    injectUpdate(this as AnyQuery);
    next();
  });

  // Mongoose v9 文档中间件为同步钩子（无 next 参数）。
  schema.pre('validate', function tenantScopeValidate(this: Record<string, unknown>) {
    if (this.userId !== undefined && this.userId !== null && (this.tenantId === undefined || this.tenantId === null)) {
      this.tenantId = this.userId;
    }
  });

  // insertMany 在 v9 中为 (docs) 或 (next, docs)，两者都兼容。
  schema.pre('insertMany', function tenantScopeInsertMany(this: unknown, ...args: unknown[]) {
    const docs = (args.length > 1 ? args[1] : args[0]) as Array<Record<string, unknown>> | undefined;
    const next = args.find((arg) => typeof arg === 'function') as (() => void) | undefined;
    if (Array.isArray(docs)) {
      for (const doc of docs) {
        if (doc && doc.userId !== undefined && doc.userId !== null && (doc.tenantId === undefined || doc.tenantId === null)) {
          doc.tenantId = doc.userId;
        }
      }
    }
    next?.();
  });
}
