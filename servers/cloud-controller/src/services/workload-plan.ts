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
 * 按 `paramSchema` 归一默认参数：每个字段取 `defaultValue`，并按类型做轻量归一
 * （`multi_select` 去重为字符串数组、`boolean` 保证布尔、其余保证字符串）。
 */
export function normalizeDefaultParams(
  paramSchema: readonly WorkloadParamField[] | undefined,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const field of paramSchema ?? []) {
    switch (field.type) {
      case 'multi_select': {
        const value = Array.isArray(field.defaultValue)
          ? field.defaultValue.filter((item): item is string => typeof item === 'string')
          : [];
        params[field.key] = [...new Set(value)];
        break;
      }
      case 'boolean':
        params[field.key] =
          typeof field.defaultValue === 'boolean'
            ? field.defaultValue
            : Boolean(field.defaultValue);
        break;
      default:
        params[field.key] =
          typeof field.defaultValue === 'string'
            ? field.defaultValue
            : field.defaultValue === undefined || field.defaultValue === null
              ? ''
              : String(field.defaultValue);
        break;
    }
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
      throw new WorkloadPlanError(`dependency cycle detected: ${[...path, id].join(' -> ')}`);
    }
    const definition = byId.get(id);
    if (!definition) {
      if (explicitSet.has(id)) throw new WorkloadPlanError(`workload not found: ${id}`);
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
    });
  };

  for (const id of explicitOrder) visit(id, []);

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
