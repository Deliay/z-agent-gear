import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetThemeForTests,
  applyTheme,
  getTheme,
  initTheme,
  resolveTheme,
  setTheme,
  subscribe,
  THEME_STORAGE_KEY,
  type Theme,
} from '../theme'

function installMatchMedia(initialDark: boolean) {
  let matches = initialDark
  const listeners = new Set<() => void>()
  const mediaQuery = {
    get matches() {
      return matches
    },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    addListener: (listener: () => void) => listeners.add(listener),
    removeListener: (listener: () => void) => listeners.delete(listener),
    dispatchEvent: () => true,
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mediaQuery),
  )
  return {
    setDark(next: boolean) {
      matches = next
      listeners.forEach((listener) => listener())
    },
  }
}

describe('主题单源 lib/theme.ts', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
    document.documentElement.style.colorScheme = ''
    __resetThemeForTests()
    vi.unstubAllGlobals()
  })

  it('T-AUI-TH1: setTheme 持久化并驱动 html.dark', () => {
    installMatchMedia(false)

    setTheme('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe('dark')

    setTheme('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    setTheme('system')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(resolveTheme('system')).toBe('light')
  })

  it('T-AUI-TH1: system 跟随 matchMedia 并监听系统主题变化', () => {
    const media = installMatchMedia(true)
    const listener = vi.fn()
    subscribe(listener)

    setTheme('system')
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    media.setDark(false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(listener).toHaveBeenLastCalledWith('system')
  })

  it('T-AUI-TH2: 初始缺省 system，非法持久值回落 system，subscribe 可取消', () => {
    installMatchMedia(false)
    expect(getTheme()).toBe('system')

    localStorage.setItem(THEME_STORAGE_KEY, 'midnight' as Theme)
    expect(getTheme()).toBe('system')

    const listener = vi.fn()
    const unsubscribe = subscribe(listener)
    setTheme('dark')
    expect(listener).toHaveBeenCalledWith('dark')
    unsubscribe()
    setTheme('light')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('T-AUI-TH2: initTheme 在渲染前同步应用已存主题', () => {
    installMatchMedia(false)
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    initTheme()
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    localStorage.setItem(THEME_STORAGE_KEY, 'system')
    installMatchMedia(true)
    applyTheme(getTheme())
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})
