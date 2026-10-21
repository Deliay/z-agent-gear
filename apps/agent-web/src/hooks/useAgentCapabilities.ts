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
    return {
      features,
      hasSnapshot: features.length > 0,
      status: (id: string) => map.get(id)?.status ?? unknownStatus(),
      detail: (id: string) => map.get(id)?.detail ?? null,
      isBlocked: (id: string) => features.length > 0 && map.get(id)?.status === 'unsupported',
    };
  }, [features]);
}
