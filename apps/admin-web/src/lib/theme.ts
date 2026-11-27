/**
 * 管理后台主题单源模块。
 *
 * 三态主题：`light` / `dark` / `system`，持久化在 `localStorage('theme')`。
 * - `system` 通过 `matchMedia('(prefers-color-scheme: dark)')` 跟随系统并监听变化；
 * - 所有主题变化统一驱动 `document.documentElement.classList.toggle('dark')`；
 * - 模块不依赖 React，`main.tsx` 可在渲染前同步应用主题，避免亮→暗闪烁。
 */

export type Theme = 'light' | 'dark' | 'system'

export const THEME_STORAGE_KEY = 'theme'

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

type ThemeListener = (theme: Theme) => void

const listeners = new Set<ThemeListener>()
let mediaQuery: MediaQueryList | null = null
let mediaListenerAttached = false

export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system'
}

/** 读取持久化主题，缺省/非法值回落 `system`。 */
export function getTheme(): Theme {
  if (typeof window === 'undefined') return 'system'
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  return isTheme(stored) ? stored : 'system'
}

/** 将三态主题解析为实际生效的亮/暗主题。 */
export function resolveTheme(theme: Theme = getTheme()): 'light' | 'dark' {
  if (theme !== 'system') return theme
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'
  return window.matchMedia(SYSTEM_DARK_QUERY).matches ? 'dark' : 'light'
}

/** 将主题应用到 documentElement（含 color-scheme，保证原生控件配色一致）。 */
export function applyTheme(theme: Theme = getTheme()): void {
  if (typeof document === 'undefined') return
  const resolved = resolveTheme(theme)
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.style.colorScheme = resolved
}

/** 设置并持久化主题，同时通知订阅者。 */
export function setTheme(theme: Theme): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  }
  applyTheme(theme)
  listeners.forEach((listener) => listener(theme))
}

/** 订阅主题变化；返回取消订阅函数。 */
export function subscribe(listener: ThemeListener): () => void {
  listeners.add(listener)
  ensureMediaListener()
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 启动时接线：同步应用已存主题并监听系统主题变化。
 * 多次调用幂等，适合在 `main.tsx` 渲染前执行。
 */
export function initTheme(): void {
  applyTheme(getTheme())
  ensureMediaListener()
}

function ensureMediaListener(): void {
  if (mediaListenerAttached) return
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
  mediaQuery = window.matchMedia(SYSTEM_DARK_QUERY)
  if (typeof mediaQuery.addEventListener !== 'function') return
  mediaQuery.addEventListener('change', handleSystemThemeChange)
  mediaListenerAttached = true
}

function handleSystemThemeChange(): void {
  const theme = getTheme()
  if (theme !== 'system') return
  applyTheme(theme)
  listeners.forEach((listener) => listener(theme))
}

/** 仅供测试：重置模块内部监听状态（不改变已应用主题）。 */
export function __resetThemeForTests(): void {
  if (mediaQuery && typeof mediaQuery.removeEventListener === 'function') {
    mediaQuery.removeEventListener('change', handleSystemThemeChange)
  }
  mediaQuery = null
  mediaListenerAttached = false
  listeners.clear()
}
