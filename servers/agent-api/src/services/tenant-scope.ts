import type mongoose from 'mongoose';
import { getWorkspaceContext } from './workspace-context.js';

/** 注入用 tenantId：有请求工作区上下文时用工作区所属租户（团队租户不再恒等 userId）。 */
function resolveTenantId(userId: unknown): unknown {
  if (userId === undefined || userId === null) return userId;
  const context = getWorkspaceContext();
  return context?.tenantId ?? userId;
}

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

/**
 * 递归补齐 `tenantId=userId`：同时处理 `$or` / `$and` / `$nor` 内的 userId 分支
 * （如工作流模板 `$or: [{ userId }, { isBuiltin: true }]`），避免二期放开 userId
 * 维度后出现静默漏点；显式 tenantId 优先，不覆盖。
 */
function isOperatorValue(value: unknown): boolean {
  // `{ userId: { $in: [...] } }` 等操作符对象不能直接复制为 tenantId（值语义不同）。
  // ObjectId 等带 equals 的对象视为标量。
  if (!value || typeof value !== 'object' || typeof (value as { equals?: unknown }).equals === 'function') {
    return false;
  }
  return Object.keys(value as Record<string, unknown>).some((key) => key.startsWith('$'));
}

function injectFilterObject(filter: Record<string, unknown>): Record<string, unknown> {
  if (!filter || typeof filter !== 'object') return filter;
  let next = filter;
  if (
    filter.userId !== undefined &&
    filter.userId !== null &&
    !isOperatorValue(filter.userId) &&
    filter.tenantId === undefined
  ) {
    next = { ...filter, tenantId: resolveTenantId(filter.userId) };
  }
  for (const operator of ['$or', '$and', '$nor'] as const) {
    const branches = next[operator];
    if (!Array.isArray(branches)) continue;
    next = {
      ...next,
      [operator]: branches.map((branch) =>
        branch && typeof branch === 'object'
          ? injectFilterObject(branch as Record<string, unknown>)
          : branch,
      ),
    };
  }
  return next;
}

/** 查询过滤条件补齐 tenantId=userId（显式 tenantId 优先；递归处理逻辑组合子）。 */
export function injectFilter(query: AnyQuery): void {
  const filter = query.getFilter?.() ?? {};
  if (!filter || typeof filter !== 'object') return;
  const next = injectFilterObject(filter as Record<string, unknown>);
  if (next !== filter) query.setQuery(next);
}

/**
 * 更新文档补齐 tenantId：
 * - `$set.userId` / `$setOnInsert.userId` 存在且对应 tenantId 缺失；
 * - 顶层 `userId`（Mongoose 会把顶层字段归一为 $set，但 pre hook 里仍可能是原形态）。
 */
export function injectUpdate(query: AnyQuery): void {
  const update = query.getUpdate?.();
  if (!update || typeof update !== 'object') return;
  const doc = update as Record<string, unknown>;

  const set = doc.$set;
  const setObj = set && typeof set === 'object' ? (set as Record<string, unknown>) : undefined;
  // Mongoose 可能同时保留顶层 userId 与 $set（timestamps）；两者都要识别。
  const userId = setObj?.userId !== undefined ? setObj.userId : doc.userId;
  if (userId !== undefined && userId !== null) {
    if (setObj) {
      if (setObj.tenantId === undefined) doc.$set = { ...setObj, tenantId: resolveTenantId(userId) };
    } else if (doc.tenantId === undefined) {
      doc.tenantId = resolveTenantId(userId);
    }
  }

  const setOnInsert = doc.$setOnInsert;
  if (setOnInsert && typeof setOnInsert === 'object') {
    const insertObj = setOnInsert as Record<string, unknown>;
    // `$set` / 顶层 / `$setOnInsert` 已显式写 tenantId 时不得再注入，
    // 否则同一路径出现在两个操作符里会触发 MongoDB ConflictingUpdateOperators（code 40），
    // 例如 GitHub 绑定：$set.tenantId + $setOnInsert.userId。
    const tenantIdAlreadySet =
      setObj?.tenantId !== undefined ||
      doc.tenantId !== undefined ||
      insertObj.tenantId !== undefined;
    if (
      insertObj.userId !== undefined &&
      insertObj.userId !== null &&
      !tenantIdAlreadySet
    ) {
      doc.$setOnInsert = { ...insertObj, tenantId: resolveTenantId(insertObj.userId) };
    }
  }
}


// Mongoose v9 的 pre() 重载对「钩子数组」类型推断不友好，这里以结构化 any 调用。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyTenantScope(schema: any): void {
  if (!schema.path('userId') || !schema.path('tenantId')) return;

  // Mongoose v9 的 query 中间件也是同步钩子（无 next 参数）；写成 promise/next 形式会抛
  // `next is not a function`（T-ISO 真执行用例覆盖）。
  schema.pre(QUERY_HOOKS, function tenantScopeFilter(this: unknown) {
    injectFilter(this as AnyQuery);
  });

  schema.pre(WRITE_UPDATE_HOOKS, function tenantScopeUpdate(this: unknown) {
    injectFilter(this as AnyQuery);
    injectUpdate(this as AnyQuery);
  });

  // Mongoose v9 文档中间件为同步钩子（无 next 参数）。
  schema.pre('validate', function tenantScopeValidate(this: Record<string, unknown>) {
    if (this.userId !== undefined && this.userId !== null && (this.tenantId === undefined || this.tenantId === null)) {
      this.tenantId = resolveTenantId(this.userId);
    }
  });

  // insertMany 在 v9 中为 (docs) 或 (next, docs)，两者都兼容。
  schema.pre('insertMany', function tenantScopeInsertMany(this: unknown, ...args: unknown[]) {
    const docs = (args.length > 1 ? args[1] : args[0]) as Array<Record<string, unknown>> | undefined;
    const next = args.find((arg) => typeof arg === 'function') as (() => void) | undefined;
    if (Array.isArray(docs)) {
      for (const doc of docs) {
        if (doc && doc.userId !== undefined && doc.userId !== null && (doc.tenantId === undefined || doc.tenantId === null)) {
          doc.tenantId = resolveTenantId(doc.userId);
        }
      }
    }
    next?.();
  });
}
