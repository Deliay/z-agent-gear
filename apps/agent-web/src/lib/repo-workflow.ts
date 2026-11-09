/**
 * 项目（仓库）工作流模板扫描的版本判定（仅用于前端提示文案展示，权威判定在服务端）。
 * agent-gear 2.18.0 起支持 workflow-templates:scan。
 */
export const REPO_TEMPLATE_MIN_AGENT_GEAR_VERSION = '2.18.0'

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(pa.length, pb.length)
  for (let i = 0; i < length; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 控制器版本是否支持项目模板扫描（缺失/非法/低版本均为 false） */
export function isRepoTemplateScanSupported(version?: string | null): boolean {
  if (typeof version !== 'string' || version.trim() === '') return false
  return compareVersions(version, REPO_TEMPLATE_MIN_AGENT_GEAR_VERSION) >= 0
}
