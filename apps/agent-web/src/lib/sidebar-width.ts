/** 侧边栏宽度偏好：clamp 15–28rem、默认 20rem，持久化到 localStorage['sidebar-width'] */

export const SIDEBAR_WIDTH_STORAGE_KEY = 'sidebar-width'
/** 下限 15rem = 240px（保证主机树多级缩进仍可读） */
export const SIDEBAR_MIN_WIDTH = 240
/** 上限 28rem = 448px（保证主内容区不被过度挤压） */
export const SIDEBAR_MAX_WIDTH = 448
/** 默认 20rem = 320px */
export const SIDEBAR_DEFAULT_WIDTH = 320

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))
}

export function readSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
    if (!raw) return SIDEBAR_DEFAULT_WIDTH
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return SIDEBAR_DEFAULT_WIDTH
    return clampSidebarWidth(parsed)
  } catch {
    return SIDEBAR_DEFAULT_WIDTH
  }
}

export function persistSidebarWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(width)))
  } catch {
    // 隐私模式/沙箱下 localStorage 不可写：仅本次会话生效，不阻断拖拽
  }
}
