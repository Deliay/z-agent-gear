/** 侧边栏领域聚焦与折叠偏好（localStorage 持久化） */

export type SidebarSectionKey = 'hosts' | 'workflows' | 'sessions' | 'knowledgeBases' | 'gateways'

/** 一级导航轨对应的四大聚焦工作域 */
export type ContextDomainKey = 'sessions' | 'workflows' | 'knowledgeBases' | 'hosts'

export const SIDEBAR_ACTIVE_DOMAIN_KEY = 'sidebar-active-domain'
export const SIDEBAR_COLLAPSED_KEY = 'sidebar-collapsed'
export const SIDEBAR_SECTIONS_KEY = 'sidebar-sections-expanded'

const VALID_DOMAINS: ReadonlySet<string> = new Set<ContextDomainKey>([
  'sessions',
  'workflows',
  'knowledgeBases',
  'hosts',
])

export function isContextDomainKey(value: unknown): value is ContextDomainKey {
  return typeof value === 'string' && VALID_DOMAINS.has(value)
}

export function readActiveDomain(): ContextDomainKey {
  try {
    const raw = localStorage.getItem(SIDEBAR_ACTIVE_DOMAIN_KEY)
    if (isContextDomainKey(raw)) return raw
    return 'sessions'
  } catch {
    return 'sessions'
  }
}

export function persistActiveDomain(domain: ContextDomainKey): void {
  try {
    localStorage.setItem(SIDEBAR_ACTIVE_DOMAIN_KEY, domain)
  } catch {
    // localStorage 不可写时仅在本次会话生效
  }
}

export function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

export function persistSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    // localStorage 不可写时仅在本次会话生效
  }
}

/** 根据路由前缀推导应聚焦的领域（概览/费用/设置页返回 null，保持既有领域） */
export function domainFromPathname(pathname: string): ContextDomainKey | null {
  if (pathname.startsWith('/sessions')) return 'sessions'
  if (pathname.startsWith('/workflows')) return 'workflows'
  if (pathname.startsWith('/knowledge-bases')) return 'knowledgeBases'
  return null
}

/** 默认展开「工作流」「会话」，折叠「主机」「知识库」「网关」（兼容存量偏好读写） */
export const SIDEBAR_SECTION_DEFAULTS: Record<SidebarSectionKey, boolean> = {
  hosts: false,
  workflows: true,
  sessions: true,
  knowledgeBases: false,
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
      knowledgeBases:
        typeof parsed.knowledgeBases === 'boolean'
          ? parsed.knowledgeBases
          : SIDEBAR_SECTION_DEFAULTS.knowledgeBases,
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
