// 依赖展开与初始化顺序的「前端镜像」纯函数（计划期裁决 10）。
//
// 说明：本模块仅用于启动对话框的隐式依赖提示与顺序预览，**最终执行顺序以服务端
// 下发的 workloadPlan 为准**。语义与服务端（后序 DFS：先依赖、后自身，配置顺序、
// 去重、环兜底）保持一致，便于单测覆盖全分支。

/** 依赖/顺序计算所需的定义快照（收窄自 CloudWorkloadData，避免依赖 GraphQL 类型）。 */
export interface WorkloadPlanDefinition {
  id: string;
  name: string;
  dependsOnWorkloadIds: string[];
}

export interface WorkloadPlanPreviewItem {
  workloadId: string;
  name: string;
  /** 是否由隐式依赖加入（未显式选择） */
  implicit: boolean;
}

export interface WorkloadPlanPreview {
  /** 有序执行计划（依赖先于依赖方，去重） */
  items: WorkloadPlanPreviewItem[];
  /** 隐式加入的 workloadId（顺序与 items 一致） */
  implicitIds: string[];
  /** 依赖不存在的 workloadId（前端提示，服务端会拒绝启动） */
  missingDependencyIds: string[];
  /** 依赖环路径（名称，含环起点）；无环为 null */
  cycle: string[] | null;
}

/** 单次启动可挂载（展开后）的工作负载上限（契约裁决）。 */
export const MAX_PLAN_ITEMS = 10;

/** 单个工作负载可声明的依赖上限（契约裁决）。 */
export const MAX_WORKLOAD_DEPENDENCIES = 5;

/**
 * 由「显式选择顺序 + 定义快照」计算隐式依赖集合与初始化顺序预览。
 *
 * 算法：按显式选择顺序做后序 DFS（先访问 `dependsOnWorkloadIds` 全部依赖、再输出自身），
 * 天然实现「依赖先于依赖方」「同一负载只出现一次」「多条路径去重」；DFS 栈重复即依赖环。
 */
export function previewWorkloadPlan(
  selectedIds: string[],
  definitions: WorkloadPlanDefinition[],
): WorkloadPlanPreview {
  const byId = new Map(definitions.map((def) => [def.id, def]));
  const explicit = new Set(selectedIds);
  const visited = new Set<string>();
  const stack: string[] = [];
  const stackSet = new Set<string>();
  const items: WorkloadPlanPreviewItem[] = [];
  const missing = new Set<string>();
  let cycle: string[] | null = null;

  const visit = (id: string): void => {
    if (cycle) return;
    if (stackSet.has(id)) {
      const startIndex = stack.indexOf(id);
      cycle = stack.slice(startIndex).map((value) => byId.get(value)?.name ?? value);
      return;
    }
    if (visited.has(id)) return;
    const def = byId.get(id);
    if (!def) {
      missing.add(id);
      return;
    }

    stackSet.add(id);
    stack.push(id);
    for (const depId of def.dependsOnWorkloadIds) {
      visit(depId);
      if (cycle) break;
    }
    stack.pop();
    stackSet.delete(id);
    if (cycle) return;

    visited.add(id);
    items.push({ workloadId: id, name: def.name, implicit: !explicit.has(id) });
  };

  for (const id of selectedIds) {
    visit(id);
    if (cycle) break;
  }

  return {
    items,
    implicitIds: items.filter((item) => item.implicit).map((item) => item.workloadId),
    missingDependencyIds: [...missing],
    cycle,
  };
}

/**
 * 依赖环检测（编辑对话框保存前提示）。
 *
 * 将 `workloadId` 的依赖替换为 `dependsOnWorkloadIds` 后做 DFS，返回环路径名称；
 * 无环或未提供 `workloadId`（新建）返回 null。服务端仍会强制校验。
 */
export function detectDependencyCycle(
  workloadId: string | null,
  dependsOnWorkloadIds: string[],
  definitions: WorkloadPlanDefinition[],
): string[] | null {
  if (!workloadId) return null;
  const merged = definitions.map((def) =>
    def.id === workloadId ? { ...def, dependsOnWorkloadIds } : def,
  );
  if (!merged.some((def) => def.id === workloadId)) {
    merged.push({ id: workloadId, name: workloadId, dependsOnWorkloadIds });
  }
  return previewWorkloadPlan([workloadId], merged).cycle;
}
