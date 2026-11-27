import { Monitor, Moon, Sun } from 'lucide-react'
import { getTheme, setTheme, subscribe, type Theme } from '@/lib/theme'
import { Button } from '@/components/ui/button'
import { useSyncExternalStore } from 'react'

const THEME_ORDER: Theme[] = ['system', 'light', 'dark']

const THEME_LABELS: Record<Theme, string> = {
  system: '跟随系统',
  light: '明亮模式',
  dark: '黑暗模式',
}

const THEME_ICONS = {
  system: Monitor,
  light: Sun,
  dark: Moon,
} as const

function subscribeTheme(listener: () => void) {
  return subscribe(listener)
}

/**
 * 亮 / 暗 / 跟随系统三态主题切换按钮。
 * 放置于 AdminLayout 底部用户栏，点击按「跟随系统 → 明亮 → 黑暗」循环。
 */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, () => 'system' as Theme)
  const Icon = THEME_ICONS[theme]
  const label = THEME_LABELS[theme]

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="w-full justify-start"
      aria-label={`切换主题（当前：${label}）`}
      title={`主题：${label}`}
      onClick={() => {
        const index = THEME_ORDER.indexOf(theme)
        setTheme(THEME_ORDER[(index + 1) % THEME_ORDER.length])
      }}
    >
      <Icon className="size-4" />
      {label}
    </Button>
  )
}

export default ThemeToggle
