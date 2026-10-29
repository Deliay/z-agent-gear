import {
  WORKSPACE_READ_ONLY_MESSAGE,
  exclusiveVisibleWorkspaceIds,
  getWorkspaceContext,
  sharedVisibleWorkspaceIds,
} from './workspace-context.js';

/**
 * 工作区归属插件（多租户二期，F7/裁决 1）。
 *
 * 对照一期 `tenant-scope.ts`：
 * - **读**：在查询编译前注入工作区可见集——独占型 `{workspaceId: {$in:[当前]}}`；
 *   共享型 `{workspaceId: {$in:[当前, 本租户全局]}}`；`builtinVisible` 额外放行 `isBuiltin:true`；
 *   `globalScopeVisible` 额外放行 `scope:'global'`（providers/models 平台内置行）。
 * - **写**：`save`/`insertMany` 强制归属当前工作区；`findOneAndUpdate`/`update*`/`delete*` 的过滤强制
 *   收敛到**当前工作区**（共享型写不放宽到全局 → 普通上下文改/删全局行匹配为空 = Not found）；
 *   upsert 时 `$setOnInsert` 补齐工作区字段。
 * - **只读拦截**：`context.readOnly === true`（全局工作区 + developer）时一切写操作拒绝
 *   `global workspace is read-only`（D12 单一拦截点）。
 * - **无 ALS store 不注入、不校验**（引擎/内部/迁移链路显式传值）。
 * - 显式传入 workspace 字段的查询不覆盖（支持服务层按目标工作区做删除保护计数等运维查询）。
 * - `tenantId` 注入由既有 `applyTenantScope` 承担（两插件共存，不冲突）。
 */

export interface WorkspaceScopeOptions {
  /** 集合上的工作区字段名（默认 workspaceId；工作流域为 resourceWorkspaceId，F1） */
  workspaceField?: string;
  /** 共享型资源：读口径 = 当前 ∪ 本租户全局（providers/models/githubaccounts） */
  shared?: boolean;
  /** 内置行例外：读口径额外放行 `{isBuiltin:true}`（workflowtemplates，F9） */
  builtinVisible?: boolean;
  /** 平台内置行例外：读口径额外放行 `{scope:'global'}`（providers/models） */
  globalScopeVisible?: boolean;
}

type AnyQuery = {
  getFilter: () => Record<string, unknown>;
  setQuery: (filter: Record<string, unknown>) => void;
  getUpdate?: () => Record<string, unknown> | undefined;
  getOptions?: () => Record<string, unknown> | undefined;
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

const WRITE_UPDATE_HOOKS = [
  'findOneAndUpdate',
  'replaceOne',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const;

const UPDATE_HOOKS = ['findOneAndUpdate', 'replaceOne', 'updateOne', 'updateMany'] as const;

function isOperatorValue(value: unknown): boolean {
  if (!value || typeof value !== 'object' || typeof (value as { equals?: unknown }).equals === 'function') {
    return false;
  }
  return Object.keys(value as Record<string, unknown>).some((key) => key.startsWith('$'));
}

function visibleConstraint(options: WorkspaceScopeOptions, visibleIds: string[]): Record<string, unknown> {
  const field = options.workspaceField ?? 'workspaceId';
  const visible = { [field]: { $in: visibleIds } };
  if (options.builtinVisible) {
    return { $or: [visible, { isBuiltin: true }] };
  }
  if (options.globalScopeVisible) {
    return { $or: [visible, { scope: 'global' }] };
  }
  return visible;
}

/** 读过滤注入（显式 workspace 字段优先，不覆盖）。 */
export function injectWorkspaceFilter(
  query: AnyQuery,
  options: WorkspaceScopeOptions,
  forWrite = false,
): void {
  const context = getWorkspaceContext();
  if (!context) return;
  const filter = query.getFilter?.() ?? {};
  const field = options.workspaceField ?? 'workspaceId';
  if (filter[field] !== undefined && filter[field] !== null && !isOperatorValue(filter[field])) {
    return;
  }
  // 写操作只允许当前工作区自身行（共享型也不放宽到全局）
  const visibleIds =
    !forWrite && options.shared
      ? sharedVisibleWorkspaceIds(context)
      : exclusiveVisibleWorkspaceIds(context);
  const constraint = forWrite ? { [field]: { $in: visibleIds } } : visibleConstraint(options, visibleIds);
  query.setQuery({ $and: [filter, constraint] });
}

/** upsert 时补齐工作区字段；显式改动到其它工作区拒绝。 */
export function injectWorkspaceUpsert(query: AnyQuery, options: WorkspaceScopeOptions): void {
  const context = getWorkspaceContext();
  if (!context) return;
  const field = options.workspaceField ?? 'workspaceId';
  const update = query.getUpdate?.();
  if (!update || typeof update !== 'object') return;
  const doc = update as Record<string, unknown>;
  const set = doc.$set && typeof doc.$set === 'object' ? (doc.$set as Record<string, unknown>) : undefined;
  const setOnInsert =
    doc.$setOnInsert && typeof doc.$setOnInsert === 'object'
      ? (doc.$setOnInsert as Record<string, unknown>)
      : undefined;

  const explicit = set?.[field] ?? doc[field];
  if (explicit !== undefined && explicit !== null && String(explicit) !== context.id) {
    throw new Error('workspace not found');
  }
  const options_ = query.getOptions?.() ?? {};
  if (options_.upsert && set?.[field] === undefined) {
    doc.$setOnInsert = { ...(setOnInsert ?? {}), [field]: context.id };
  }
}

function assertWritable(): void {
  const context = getWorkspaceContext();
  if (context?.readOnly) {
    throw new Error(WORKSPACE_READ_ONLY_MESSAGE);
  }
}

// Mongoose v9 的 pre() 对「钩子数组」类型推断不友好，这里以结构化 any 调用（与 tenant-scope 同款）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyWorkspaceScope(schema: any, options: WorkspaceScopeOptions = {}): void {
  const field = options.workspaceField ?? 'workspaceId';
  if (!schema.path(field)) return;

  schema.pre(QUERY_HOOKS, function workspaceScopeFilter(this: unknown) {
    injectWorkspaceFilter(this as AnyQuery, options, false);
  });

  schema.pre(WRITE_UPDATE_HOOKS, function workspaceScopeWrite(this: unknown) {
    assertWritable();
    injectWorkspaceFilter(this as AnyQuery, options, true);
  });

  schema.pre(UPDATE_HOOKS, function workspaceScopeUpsert(this: unknown) {
    injectWorkspaceUpsert(this as AnyQuery, options);
  });

  // Mongoose v9 文档中间件为同步钩子（无 next 参数）。
  schema.pre('validate', function workspaceScopeValidate(this: Record<string, unknown>) {
    assertWritable();
    const context = getWorkspaceContext();
    if (!context) return;
    const current = this[field];
    if (current === undefined || current === null) {
      this[field] = context.id;
      return;
    }
    // save() 路径强制归属当前工作区（共享读允许加载全局行，但写必须回到当前工作区）
    if (String(current) !== context.id) {
      throw new Error('workspace not found');
    }
  });

  schema.pre('insertMany', function workspaceScopeInsertMany(this: unknown, ...args: unknown[]) {
    assertWritable();
    const context = getWorkspaceContext();
    const docs = (args.length > 1 ? args[1] : args[0]) as Array<Record<string, unknown>> | undefined;
    const next = args.find((arg) => typeof arg === 'function') as (() => void) | undefined;
    if (context && Array.isArray(docs)) {
      for (const doc of docs) {
        if (!doc) continue;
        if (doc[field] === undefined || doc[field] === null) {
          doc[field] = context.id;
        } else if (String(doc[field]) !== context.id) {
          throw new Error('workspace not found');
        }
      }
    }
    next?.();
  });
}
