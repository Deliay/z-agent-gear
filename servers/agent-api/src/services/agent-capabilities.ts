/**
 * 能力快照读取（agent-api 侧只读，不复制 FeatureId 矩阵）。
 *
 * 快照由 controller 归一化后经 controller-api 落库；本服务只负责把
 * `sessions.agentCapabilities.features` 暴露给 GraphQL。旧会话无快照时返回
 * 空数组（前端按「未知 → 全部放行」处理，裁决 R8）。
 */

export interface AgentFeatureSupportData {
  id: string;
  status: 'supported' | 'partial' | 'unsupported';
  detail: string | null;
}

export interface AgentCapabilitySnapshotLike {
  protocolVersion?: number | null;
  agentInfo?: { name: string; version?: string | null } | null;
  features?: unknown;
  raw?: unknown;
}

/**
 * 返回快照内 features 的深拷贝；快照缺失/格式异常（非数组）一律返回 []。
 * 深拷贝避免 GraphQL 层意外修改数据库读取对象。
 */
export function featuresFromSnapshot(snapshot: unknown): AgentFeatureSupportData[] {
  const features = (snapshot as AgentCapabilitySnapshotLike | null | undefined)?.features;
  if (!Array.isArray(features)) return [];

  return features.flatMap((feature) => {
    if (typeof feature !== 'object' || feature === null) return [];
    const raw = feature as Record<string, unknown>;
    if (typeof raw.id !== 'string' || typeof raw.status !== 'string') return [];
    return [{
      id: raw.id,
      status: raw.status as AgentFeatureSupportData['status'],
      detail: typeof raw.detail === 'string' ? raw.detail : null,
    }];
  });
}
