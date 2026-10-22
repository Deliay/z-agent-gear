import { useMemo } from 'react';
import type { AgentFeatureStatus, SessionData } from '../graphql/types';

export interface AgentCapabilitiesController {
  features: NonNullable<SessionData['features']>;
  hasSnapshot: boolean;
  status: (id: string) => AgentFeatureStatus;
  detail: (id: string) => string | null;
  /**
   * 只在「有快照 + 明确 unsupported」时拦截；
   * 旧会话/旧 Agent（无快照）与 partial 一律放行（零退化，裁决 R4）。
   */
  isBlocked: (id: string) => boolean;
}

const unknownStatus = (): AgentFeatureStatus => 'partial';

/**
 * 会话能力门控。UI 只做「明确的 unsupported 才禁用」，
 * 避免误伤「不广播能力但实际可用」的 Agent。
 */
export function useAgentCapabilities(session: SessionData | null | undefined): AgentCapabilitiesController {
  const features = useMemo(() => session?.features ?? [], [session?.features]);

  return useMemo(() => {
    const map = new Map(features.map((feature) => [feature.id, feature]));
    // 快照存在性以 agentCapabilities 为准（features 为空数组时也说明有快照），
    // 与 AgentCapabilityPanel 共用同一判定，避免「空数组不穿透」被数据形态绕过。
    const hasSnapshot = Boolean(session?.agentCapabilities) || features.length > 0;
    return {
      features,
      hasSnapshot,
      status: (id: string) => map.get(id)?.status ?? unknownStatus(),
      detail: (id: string) => map.get(id)?.detail ?? null,
      // 只有「有快照 + 该能力明确 unsupported」才拦截；缺失条目/partial 一律放行
      isBlocked: (id: string) => hasSnapshot && map.get(id)?.status === 'unsupported',
    };
  }, [features, session?.agentCapabilities]);
}
