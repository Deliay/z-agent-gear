import type { WorkloadParamField } from '../models/cloud-workload.js';
import type { WorkloadPlanEntry } from '../models/cloud-container.js';

/**
 * 执行计划兜底展开（纯函数）。
 *
 * 仅当 `POST /internal/containers` 未携带 `workloadPlan`（旧版 admin-api）时使用：
 * 以 `workloadIds` + 只读工作负载定义（`paramSchema`/`dependsOnWorkloadIds`）做与
 * admin-api 同口径的**后序 DFS** 展开 + 默认参数归一（不含用户参数），输出有序、
 * 去重的 `[{ workloadId, params, implicit }]`（提案 §5.2 实现点 2/4、裁决 4/5/6）。
 *
 * 语义（与 admin-api 保持一致）：
 * - 依赖先于依赖方；同一负载只出现一次（多条路径天然去重）；
 * - DFS 栈出现重复即视为依赖环 → 抛错；
 * - 展开后条数 > 10 → 抛错（文案 `expanded workloads exceed 10`）；
 * - 显式选择 `implicit=false`，隐式依赖 `implicit=true`（显式优先于隐式）；
 * - 参数一律取定义中的默认值（兜底路径没有用户参数）。
 */

/** 单次启动可挂载的工作负载上限（契约 A.2.2 / 裁决 5）。 */
export const MAX_WORKLOAD_PLAN_ENTRIES = 10;

/** TEXT 参数值最大字符数（与 admin-api 同口径，裁决 6）。 */
export const MAX_PARAM_TEXT_LENGTH = 1024;

/** 兜底展开/校验失败：调用方映射为 400 `INVALID_WORKLOAD`。 */
export class WorkloadPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkloadPlanError';
  }
}

/** 兜底展开所需的最小工作负载定义快照。 */
export interface WorkloadPlanDefinition {
  id: string;
  paramSchema?: WorkloadParamField[];
  dependsOnWorkloadIds?: string[];
}

/** 去重且保持输入顺序（忽略空串/非字符串）。 */
function dedupePreservingOrder(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * 按 `paramSchema` 归一单个默认参数值——**镜像 admin-api `normalizeParamValue`**，
 * 类型大小写不敏感，非法默认值抛错（调用方映射 400 `INVALID_WORKLOAD`），
 * 避免兜底路径出现「`"false"` 变 `true`」「非数组静默变 `[]`」「select 不校验归属」
 * 等与 admin-api 不一致的行为（契约 A.2.2「行为与新 admin-api 一致」）。
 */
export function normalizeDefaultParamValue(field: WorkloadParamField): string | string[] | boolean {
  const type = String(field.type).toLowerCase();
  const options = field.options ?? [];
  const value = field.defaultValue;
  switch (type) {
    case 'select':
      if (typeof value !== 'string' || !options.includes(value)) {
        throw new WorkloadPlanError(`invalid value for parameter ${field.key}`);
      }
      return value;
    case 'multi_select':
      if (
        !Array.isArray(value) ||
        !value.every((item) => typeof item === 'string' && options.includes(item))
      ) {
        throw new WorkloadPlanError(`invalid value for parameter ${field.key}`);
      }
      // 去重（保留首次出现顺序）；空数组合法
      return [...new Set(value as string[])];
    case 'text':
      if (typeof value !== 'string' || value.length > MAX_PARAM_TEXT_LENGTH) {
        throw new WorkloadPlanError(`invalid value for parameter ${field.key}`);
      }
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new WorkloadPlanError(`invalid value for parameter ${field.key}`);
      }
      return value;
    default:
      throw new WorkloadPlanError(`invalid value for parameter ${field.key}`);
  }
}

/**
 * 按 `paramSchema` 归一默认参数：每个字段取 `defaultValue` 并按类型校验归一
 * （与 admin-api 同口径；非法默认值抛 `WorkloadPlanError`）。
 */
export function normalizeDefaultParams(
  paramSchema: readonly WorkloadParamField[] | undefined,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const field of paramSchema ?? []) {
    params[field.key] = normalizeDefaultParamValue(field);
  }
  return params;
}

/**
 * 兜底展开：`workloadIds`（显式选择）+ 定义快照 → 有序执行计划。
 *
 * @throws WorkloadPlanError 显式/依赖 ID 缺失、依赖环、展开条数 > 10。
 */
export function resolveFallbackWorkloadPlan(
  workloadIds: readonly string[],
  definitions: readonly WorkloadPlanDefinition[],
): WorkloadPlanEntry[] {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const explicitOrder = dedupePreservingOrder(workloadIds);
  const explicitSet = new Set(explicitOrder);

  // 'visiting' = 在当前 DFS 栈上（灰）；'done' = 已完成（黑）。
  const state = new Map<string, 'visiting' | 'done'>();
  const result: WorkloadPlanEntry[] = [];

  const visit = (id: string, path: readonly string[]): void => {
    const color = state.get(id);
    if (color === 'done') return;
    if (color === 'visiting') {
      // 与 admin-api 同口径：仅输出环路径（含环起点），不输出整条 DFS 路径。
      const cycle = [...path.slice(path.indexOf(id)), id];
      throw new WorkloadPlanError(`dependency cycle detected: ${cycle.join(' -> ')}`);
    }
    const definition = byId.get(id);
    if (!definition) {
      if (explicitSet.has(id)) throw new WorkloadPlanError('workload not found');
      throw new WorkloadPlanError(`dependency workload not found: ${id}`);
    }

    state.set(id, 'visiting');
    for (const dependencyId of definition.dependsOnWorkloadIds ?? []) {
      visit(dependencyId, [...path, id]);
    }
    state.set(id, 'done');
    result.push({
      workloadId: id,
      params: normalizeDefaultParams(definition.paramSchema),
      implicit: !explicitSet.has(id),
      // 兜底展开（仅 workloadIds 的旧请求）无 required 语义，一律 false（裁决 2）。
      required: false,
    });
  };

  for (const id of explicitOrder) visit(id, []);

  if (result.length > MAX_WORKLOAD_PLAN_ENTRIES) {
    throw new WorkloadPlanError('expanded workloads exceed 10');
  }
  return result;
}

/**
 * 归一用户显式参数：以默认值为底，逐项覆盖并按 `paramSchema` 校验。
 * 未知参数 / 类型不符 / select 不在 options / text 超长均抛 `WorkloadPlanError`。
 */
export function normalizeProvidedParams(
  paramSchema: readonly WorkloadParamField[] | undefined,
  provided: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const params = normalizeDefaultParams(paramSchema);
  if (!provided) return params;
  const fields = new Map((paramSchema ?? []).map((field) => [field.key, field]));
  for (const [key, raw] of Object.entries(provided)) {
    const field = fields.get(key);
    if (!field) throw new WorkloadPlanError(`unknown parameter: ${key}`);
    const type = String(field.type).toLowerCase();
    const options = field.options ?? [];
    switch (type) {
      case 'select':
        if (typeof raw !== 'string' || !options.includes(raw)) {
          throw new WorkloadPlanError(`invalid value for parameter ${key}`);
        }
        params[key] = raw;
        break;
      case 'multi_select':
        if (
          !Array.isArray(raw) ||
          !raw.every((item) => typeof item === 'string' && options.includes(item))
        ) {
          throw new WorkloadPlanError(`invalid value for parameter ${key}`);
        }
        params[key] = [...new Set(raw as string[])];
        break;
      case 'text':
        if (typeof raw !== 'string' || raw.length > MAX_PARAM_TEXT_LENGTH) {
          throw new WorkloadPlanError(`invalid value for parameter ${key}`);
        }
        params[key] = raw;
        break;
      case 'boolean':
        if (typeof raw !== 'boolean') {
          throw new WorkloadPlanError(`invalid value for parameter ${key}`);
        }
        params[key] = raw;
        break;
      default:
        throw new WorkloadPlanError(`invalid value for parameter ${key}`);
    }
  }
  return params;
}

/**
 * runtime 安装计划：显式工作负载合并用户参数 + 后序 DFS 展开隐式依赖（默认参数）。
 *
 * @throws WorkloadPlanError 工作负载缺失、参数非法、依赖环、展开条数 > 10。
 */
export function resolveRuntimeWorkloadPlan(input: {
  workloadId: string;
  params?: Record<string, unknown>;
  definitions: readonly WorkloadPlanDefinition[];
}): WorkloadPlanEntry[] {
  const byId = new Map(input.definitions.map((definition) => [definition.id, definition]));
  if (!byId.has(input.workloadId)) {
    throw new WorkloadPlanError('workload not found');
  }

  const state = new Map<string, 'visiting' | 'done'>();
  const result: WorkloadPlanEntry[] = [];

  const visit = (id: string, path: readonly string[], explicit: boolean): void => {
    const color = state.get(id);
    if (color === 'done') return;
    if (color === 'visiting') {
      const cycle = [...path.slice(path.indexOf(id)), id];
      throw new WorkloadPlanError(`dependency cycle detected: ${cycle.join(' -> ')}`);
    }
    const definition = byId.get(id);
    if (!definition) {
      throw new WorkloadPlanError(`dependency workload not found: ${id}`);
    }
    state.set(id, 'visiting');
    for (const dependencyId of definition.dependsOnWorkloadIds ?? []) {
      visit(dependencyId, [...path, id], false);
    }
    state.set(id, 'done');
    result.push({
      workloadId: id,
      params: explicit
        ? normalizeProvidedParams(definition.paramSchema, input.params)
        : normalizeDefaultParams(definition.paramSchema),
      implicit: !explicit,
      required: false,
    });
  };

  visit(input.workloadId, [], true);

  if (result.length > MAX_WORKLOAD_PLAN_ENTRIES) {
    throw new WorkloadPlanError('expanded workloads exceed 10');
  }
  return result;
}

/**
 * 按需（含传递依赖）批量加载定义快照：从 `ids` 出发 BFS `dependsOnWorkloadIds`，
 * 使纯函数 `resolveFallbackWorkloadPlan` 拿到完整定义。缺失的依赖不会出现在结果里，
 * 由纯函数负责报错（`dependency workload not found`）。
 */
export async function collectWorkloadDefinitions(
  ids: readonly string[],
  lookup: (ids: string[]) => Promise<WorkloadPlanDefinition[]>,
): Promise<WorkloadPlanDefinition[]> {
  const collected = new Map<string, WorkloadPlanDefinition>();
  let frontier = dedupePreservingOrder(ids);

  while (frontier.length > 0) {
    const found = await lookup(frontier);
    const next: string[] = [];
    for (const definition of found) {
      if (collected.has(definition.id)) continue;
      const normalized: WorkloadPlanDefinition = {
        id: definition.id,
        paramSchema: definition.paramSchema ?? [],
        dependsOnWorkloadIds: definition.dependsOnWorkloadIds ?? [],
      };
      collected.set(definition.id, normalized);
      for (const dependencyId of normalized.dependsOnWorkloadIds ?? []) {
        if (!collected.has(dependencyId)) next.push(dependencyId);
      }
    }
    frontier = dedupePreservingOrder(next);
  }

  return [...collected.values()];
}
