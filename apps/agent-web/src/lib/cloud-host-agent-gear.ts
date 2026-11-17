import type { CloudHostData } from '../graphql/types'

/** 升级结果轮询周期（D14：2s） */
export const AGENT_GEAR_UPGRADE_POLL_INTERVAL_MS = 2000

/** 升级结果等待上限（D14：3 分钟） */
export const AGENT_GEAR_UPGRADE_TIMEOUT_MS = 3 * 60 * 1000

/** 超时提示（可重试或等待 worker 周期自动升级收敛） */
export const AGENT_GEAR_UPGRADE_TIMEOUT_MESSAGE = '升级超时，可重试或等待自动升级'

/**
 * 云电脑工作组件升级错误文案中文映射（单一来源，对齐 contracts/cloud-host.graphql
 * `upgradeCloudHostAgentGear` 六条错误白名单 + `internal error` 兜底）。
 * 未命中的文案原样展示。
 */
export const CLOUD_HOST_AGENT_GEAR_ERROR_MESSAGES: Record<string, string> = {
  'Not authenticated': '登录状态已失效，请重新登录',
  'Cloud host not found': '云电脑不存在或无权访问',
  'cloud host is not running': '云电脑未在运行，无法升级工作组件',
  'container is not online': '云电脑未在线，请稍后重试或等待自动升级',
  'agent-gear upgrade is not supported by the current version':
    '当前工作组件版本不支持立即升级，请等待自动升级或重建云电脑',
  'agent-gear upgrade already in progress': '工作组件升级已在进行中，请稍候',
  'internal error': '工作组件升级失败，请稍后重试',
}

/** 升级错误文案（契约白名单 → 中文；未命中/非 Error 原样/缺省兜底） */
export function agentGearUpgradeErrorMessage(
  error: unknown,
  fallback = '工作组件升级失败，请稍后重试',
): string {
  if (error instanceof Error && error.message) {
    const message = error.message.trim()
    return CLOUD_HOST_AGENT_GEAR_ERROR_MESSAGES[message] ?? message
  }
  return fallback
}

/**
 * 「立即升级」可见性门（服务端仍为权威）：
 * 版本不一致 + 云电脑 RUNNING + 未软删除。
 */
export function isAgentGearUpgradeAvailable(
  host?: Pick<CloudHostData, 'status' | 'deletedAt' | 'agentGearVersion'> | null,
): boolean {
  if (!host) return false
  if (host.deletedAt) return false
  if (host.status !== 'RUNNING') return false
  return host.agentGearVersion?.upgradeAvailable === true
}
