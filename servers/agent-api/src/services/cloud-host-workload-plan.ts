import type { CloudWorkloadCatalogItem, WorkloadParamField } from './cloud-workload-catalog.js';

/**
 * 创建云电脑时的 workloadPlan 展开（纯函数，无 IO）。
 *
 * 与 cloud-controller 的 `resolveFallbackWorkloadPlan` / admin-api 的 `buildWorkloadPlan` 同口径
 * （后序 DFS、依赖先行、去重、环检测、显式优先于隐式、默认参数按类型归一），
 * 但本函数不跨服务 import：agent-api 在创建前一次性算出显式 plan 并随 `startHarness` 下发
 * （cloud-controller 对 harness 请求要求显式非空 workloadPlan）。
 */

/** 单次创建可显式勾选的 standard 负载上限（与 `dependsOnWorkloadIds` 上限一致）。 */
export const MAX_CREATE_WORKLOADS = 5;
/** 展开后 plan 总条数上限（与 cloud-controller `MAX_WORKLOAD_PLAN_ENTRIES` 同口径）。 */
export const MAX_PLAN_ENTRIES = 10;
/** TEXT 参数默认值最大字符数（与 admin-api / cloud-controller 同口径）。 */
export const MAX_PARAM_TEXT_LENGTH = 1024;

export interface CreateWorkloadPlanEntry {
  workloadId: string;
  params: Record<string, unknown>;
  implicit: boolean;
  required: boolean;
}

export interface CreateWorkloadPlanInput {
  /** harness 预制项（固定安装，required=true）。 */
  harnessPresets: Array<{ id: string }>;
  /** 创建时显式勾选的 standard 负载 ID（去重后 ≤5）。 */
  selectedIds: string[];
  /** standard 负载目录（`catalog.listStandard()`）。 */
  standardCatalog: CloudWorkloadCatalogItem[];
}

function normalizeType(field: WorkloadParamField): string {
  return String(field.type ?? '').toLowerCase();
}

function paramError(field: WorkloadParamField): Error {
  return new Error(`invalid workload parameter: ${field.key}`);
}

/**
 * 按 `paramSchema` 归一单个默认值，与 cloud-controller `normalizeDefaultParamValue` 同口径：
 * - SELECT 必须属于 options；
 * - MULTI_SELECT 必须是 options 子集，重复项去重保留首序（空数组合法）；
 * - TEXT 必须是 ≤1024 字符的字符串；
 * - BOOLEAN 必须是布尔值；
 * - 未知类型一律拒绝（不静默按 TEXT 处理）。
 *
 * 非法默认值抛 `invalid workload parameter: <key>`。
 */
export function resolveDefaultParamValue(
  field: WorkloadParamField,
): string | string[] | boolean {
  const value = field.defaultValue;
  const options = Array.isArray(field.options) ? field.options.map(String) : [];
  switch (normalizeType(field)) {
    case 'select':
      if (typeof value !== 'string' || !options.includes(value)) throw paramError(field);
      return value;
    case 'multi_select':
      if (
        !Array.isArray(value) ||
        !value.every((item) => typeof item === 'string' && options.includes(item))
      ) {
        throw paramError(field);
      }
      return [...new Set(value as string[])];
    case 'text':
      if (typeof value !== 'string' || value.length > MAX_PARAM_TEXT_LENGTH) {
        throw paramError(field);
      }
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') throw paramError(field);
      return value;
    default:
      throw paramError(field);
  }
}

/** 按 `paramSchema` 归一全部默认值；非法默认值抛 `invalid workload parameter: <key>`。 */
export function resolveDefaultParams(workload: {
  paramSchema: WorkloadParamField[];
}): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const field of workload.paramSchema ?? []) {
    params[field.key] = resolveDefaultParamValue(field);
  }
  return params;
}

/**
 * 展开创建期 workload plan：
 * - harness presets 在前（`required=true`，与现有硬失败语义一致）；
 * - 显式选中项按选择顺序后序 DFS，依赖先行、去重；
 * - `implicit` 由「是否在显式集合中」决定（显式优先于隐式，与 cloud-controller 一致）；
 * - 全部 standard 项 `required=false`（安装失败不阻断容器）。
 */
export function resolveCreateWorkloadPlan(
  input: CreateWorkloadPlanInput,
): CreateWorkloadPlanEntry[] {
  const selected = Array.from(new Set((input.selectedIds ?? []).map(String).filter(Boolean)));
  if (selected.length > MAX_CREATE_WORKLOADS) {
    throw new Error(`too many workloads (max ${MAX_CREATE_WORKLOADS})`);
  }

  const explicitSet = new Set(selected);
  const byId = new Map(input.standardCatalog.map((item) => [item.id, item]));
  for (const id of selected) {
    if (!byId.has(id)) throw new Error(`invalid workload: ${id}`);
  }

  const entries: CreateWorkloadPlanEntry[] = [];
  const emitted = new Set<string>();
  const visiting = new Set<string>();

  const plan: CreateWorkloadPlanEntry[] = [];
  for (const preset of input.harnessPresets ?? []) {
    const workloadId = String(preset.id);
    // harness 固定在前，required=true（保持现有硬失败语义）；重复项按已出现去重。
    if (emitted.has(workloadId)) continue;
    emitted.add(workloadId);
    plan.push({ workloadId, params: {}, implicit: false, required: true });
  }

  const visit = (item: CloudWorkloadCatalogItem): void => {
    if (emitted.has(item.id)) return;
    if (visiting.has(item.id)) throw new Error('dependency cycle detected');
    visiting.add(item.id);
    for (const depId of item.dependsOnWorkloadIds ?? []) {
      const dep = byId.get(depId);
      if (!dep) throw new Error(`dependency workload not found: ${depId}`);
      visit(dep);
    }
    visiting.delete(item.id);
    emitted.add(item.id);
    entries.push({
      workloadId: item.id,
      params: resolveDefaultParams(item),
      // 显式优先于隐式：即使先以依赖身份被访问，只要在显式集合中就不是隐式。
      implicit: !explicitSet.has(item.id),
      required: false,
    });
  };

  for (const id of selected) {
    visit(byId.get(id)!);
  }

  plan.push(...entries);

  if (plan.length > MAX_PLAN_ENTRIES) {
    throw new Error(`workloads exceed ${MAX_PLAN_ENTRIES}`);
  }
  return plan;
}
