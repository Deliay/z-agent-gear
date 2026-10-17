/**
 * 启动计划展开纯函数（提案 §5.2 实现点 2、§计划期裁决 4~6）。
 *
 * 输入为「显式选择 + 工作负载定义快照」，不依赖 Mongoose，便于单测覆盖全分支：
 * - 后序 DFS：先访问 `dependsOnWorkloadIds` 全部依赖（按配置顺序），再输出自身，
 *   天然实现「依赖先于依赖方」「同一负载只出现一次」「多条路径去重」。
 * - 显式选择优先：显式选中的工作负载使用用户参数且 `implicit=false`，
 *   即使它是通过其它工作负载的依赖被访问到（只执行一次、显式参数优先）。
 * - 参数归一：显式参数优先、缺省字段填默认值、隐式依赖用默认值；
 *   未知参数报 `unknown parameter: <key>`，类型/取值非法报 `invalid value for parameter <key>`。
 * - 展开后条数 > 10 报 `expanded workloads exceed 10`；依赖环报 `dependency cycle detected`（含环路径）。
 */

export type WorkloadParamType = 'select' | 'multi_select' | 'text' | 'boolean';

export interface WorkloadParamFieldSnapshot {
  key: string;
  label?: string;
  type: WorkloadParamType | string;
  options?: string[];
  defaultValue?: unknown;
}

export interface WorkloadDefinitionSnapshot {
  id: string;
  paramSchema: WorkloadParamFieldSnapshot[];
  dependsOnWorkloadIds: string[];
}

export interface WorkloadSelection {
  workloadId: string;
  params?: Record<string, unknown> | null;
}

export interface WorkloadPlanItem {
  workloadId: string;
  params: Record<string, unknown>;
  implicit: boolean;
}

/** 展开后工作负载条数上限（提案 §6.2 约束「单次挂载 ≤10」） */
export const MAX_EXPANDED_WORKLOADS = 10;
/** TEXT 参数值最大字符数（裁决 6） */
export const MAX_PARAM_TEXT_LENGTH = 1024;

/** 按类型校验并归一单个参数值；非法抛 `invalid value for parameter <key>`。 */
export function normalizeParamValue(
  field: WorkloadParamFieldSnapshot,
  value: unknown,
): string | string[] | boolean {
  const type = String(field.type).toLowerCase();
  const options = field.options ?? [];
  switch (type) {
    case 'select':
      if (typeof value !== 'string' || !options.includes(value)) {
        throw new Error(`invalid value for parameter ${field.key}`);
      }
      return value;
    case 'multi_select':
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && options.includes(item))) {
        throw new Error(`invalid value for parameter ${field.key}`);
      }
      // 去重（保留首次出现顺序）；空数组合法
      return [...new Set(value as string[])];
    case 'text':
      if (typeof value !== 'string' || value.length > MAX_PARAM_TEXT_LENGTH) {
        throw new Error(`invalid value for parameter ${field.key}`);
      }
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new Error(`invalid value for parameter ${field.key}`);
      }
      return value;
    default:
      throw new Error(`invalid value for parameter ${field.key}`);
  }
}

/**
 * 归一某工作负载的参数：显式选择用用户参数（缺省字段填默认值），隐式依赖用默认值。
 * 未知参数（用户传了 schema 中不存在的键）报 `unknown parameter: <key>`。
 */
export function normalizeWorkloadParams(
  definition: WorkloadDefinitionSnapshot,
  userParams: Record<string, unknown>,
): Record<string, unknown> {
  const schema = definition.paramSchema ?? [];
  const keys = new Set(schema.map((field) => field.key));
  for (const key of Object.keys(userParams)) {
    if (!keys.has(key)) throw new Error(`unknown parameter: ${key}`);
  }

  const params: Record<string, unknown> = {};
  for (const field of schema) {
    const hasUserValue = Object.prototype.hasOwnProperty.call(userParams, field.key);
    const raw = hasUserValue ? userParams[field.key] : field.defaultValue;
    params[field.key] = normalizeParamValue(field, raw);
  }
  return params;
}

/**
 * 展开显式选择 + 隐式依赖，返回有序执行计划（顺序即执行顺序）。
 * 不依赖 Mongoose，`definitions` 为定义快照（可一次批量查询后传入）。
 */
export function resolveWorkloadPlan(
  explicitSelections: WorkloadSelection[],
  definitions: WorkloadDefinitionSnapshot[],
  options: { maxWorkloads?: number } = {},
): WorkloadPlanItem[] {
  const max = options.maxWorkloads ?? MAX_EXPANDED_WORKLOADS;
  const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));

  const explicitById = new Map<string, WorkloadSelection>();
  for (const selection of explicitSelections) {
    const id = String(selection.workloadId);
    if (explicitById.has(id)) throw new Error('duplicate workload selection');
    explicitById.set(id, selection);
  }
  if (explicitById.size > max) throw new Error(`expanded workloads exceed ${max}`);

  // 显式选择的 ID 必须存在（与「依赖不存在」区分文案）
  for (const id of explicitById.keys()) {
    if (!definitionById.has(id)) throw new Error('workload not found');
  }

  const plan: WorkloadPlanItem[] = [];
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    const cycleStart = stack.indexOf(id);
    if (cycleStart !== -1) {
      const cycle = [...stack.slice(cycleStart), id];
      throw new Error(`dependency cycle detected: ${cycle.join(' -> ')}`);
    }
    const definition = definitionById.get(id);
    if (!definition) throw new Error(`dependency workload not found: ${id}`);

    stack.push(id);
    for (const dependencyId of definition.dependsOnWorkloadIds ?? []) {
      visit(String(dependencyId));
    }
    stack.pop();
    visited.add(id);

    // 显式选择优先：无论经何路径访问到，只要在显式集合中即用用户参数且 implicit=false
    const explicit = explicitById.get(id);
    const params = normalizeWorkloadParams(definition, explicit?.params ?? {});
    plan.push({ workloadId: id, params, implicit: !explicit });
  };

  for (const selection of explicitSelections) visit(String(selection.workloadId));

  if (plan.length > max) throw new Error(`expanded workloads exceed ${max}`);

  return plan;
}
