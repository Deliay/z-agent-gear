/** 侧边栏四折叠分区的偏好项（localStorage 持久化） */

export type SidebarSectionKey = 'hosts' | 'workflows' | 'sessions' | 'gateways'

export const SIDEBAR_SECTIONS_KEY = 'sidebar-sections-expanded'

/** 默认展开「工作流」「会话」，折叠「主机」「网关」 */
export const SIDEBAR_SECTION_DEFAULTS: Record<SidebarSectionKey, boolean> = {
  hosts: false,
  workflows: true,
  sessions: true,
  gateways: false,
}

export type SidebarSections = Record<SidebarSectionKey, boolean>

export function readSidebarSections(): SidebarSections {
  try {
    const raw = localStorage.getItem(SIDEBAR_SECTIONS_KEY)
    if (!raw) return { ...SIDEBAR_SECTION_DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<SidebarSections>
    return {
      hosts: typeof parsed.hosts === 'boolean' ? parsed.hosts : SIDEBAR_SECTION_DEFAULTS.hosts,
      workflows: typeof parsed.workflows === 'boolean' ? parsed.workflows : SIDEBAR_SECTION_DEFAULTS.workflows,
      sessions: typeof parsed.sessions === 'boolean' ? parsed.sessions : SIDEBAR_SECTION_DEFAULTS.sessions,
      gateways: typeof parsed.gateways === 'boolean' ? parsed.gateways : SIDEBAR_SECTION_DEFAULTS.gateways,
    }
  } catch {
    return { ...SIDEBAR_SECTION_DEFAULTS }
  }
}

export function persistSidebarSections(state: SidebarSections): void {
  try {
    localStorage.setItem(SIDEBAR_SECTIONS_KEY, JSON.stringify(state))
  } catch {
    // localStorage 不可写时仅在本次会话生效
  }
}

/** 排序：updatedAt 倒序 + id tie-break（防 5s/15s 轮询跳动） */
export function sortByUpdatedAtDesc<T extends { id: string; updatedAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const diff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    if (diff !== 0 && Number.isFinite(diff)) return diff
    return a.id.localeCompare(b.id)
  })
}
