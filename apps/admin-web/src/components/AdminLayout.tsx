import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  Boxes,
  Building2,
  Cloud,
  Cpu,
  CreditCard,
  KeyRound,
  LogOut,
  Menu,
  Package,
  Scale,
  Server,
  ShieldCheck,
  Wrench,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAuth } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { ThemeToggle } from '@/components/ThemeToggle'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

interface NavGroup {
  title: string
  items: NavItem[]
}

/**
 * 2-Tier Admin Shell 的分组导航（规范 §3.2）：
 * 左侧固定宽分组导航 + 右侧自适应数据工作台。
 */
const NAV_GROUPS: NavGroup[] = [
  {
    title: '云资源管理',
    items: [
      { to: '/cloud-containers', label: '云端容器', icon: Cloud },
      { to: '/cloud-host-specs', label: '容器规格', icon: Cpu },
      { to: '/cloud-workloads', label: '工作负载', icon: Package },
      { to: '/base-images', label: '基础镜像', icon: Boxes },
    ],
  },
  {
    title: '模型与 Harness',
    items: [
      { to: '/models', label: '模型配置', icon: Server },
      { to: '/harness-configs', label: 'Harness 配置', icon: Wrench },
    ],
  },
  {
    title: '租户与计费',
    items: [
      { to: '/tenants', label: '租户管理', icon: Building2 },
      { to: '/billing', label: '费用中心', icon: CreditCard },
      { to: '/reconciliation', label: '对账中心', icon: Scale },
    ],
  },
  {
    title: '系统安全',
    items: [
      { to: '/auth-providers', label: '登录认证', icon: KeyRound },
      { to: '/settings/security', label: '账号安全', icon: ShieldCheck },
    ],
  },
]

export default function AdminLayout() {
  const { admin, logout } = useAuth()
  const navigate = useNavigate()
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  const handleLogout = () => {
    setMobileNavOpen(false)
    logout()
    navigate('/login', { replace: true })
  }

  const renderSidebarContent = (onNavigate?: () => void) => (
    <>
      <div className="shrink-0 border-b border-sidebar-border px-4 py-3.5">
        <div className="font-heading text-base font-semibold">管理后台</div>
        <div className="mt-0.5 text-xs text-muted-foreground">Agent Gear</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {NAV_GROUPS.map((group) => (
          <section key={group.title} aria-label={group.title} className="mb-4 last:mb-0">
            <h2 className="px-3 pb-1.5 text-xs font-medium tracking-wide text-muted-foreground">
              {group.title}
            </h2>
            <ul className="space-y-1">
              {group.items.map(({ to, label, icon: Icon }) => (
                <li key={to}>
                  <NavLink
                    to={to}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none ${
                        isActive
                          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                          : 'text-sidebar-foreground hover:bg-sidebar-accent'
                      }`
                    }
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">{label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="shrink-0 space-y-2 border-t border-sidebar-border p-3">
        <div className="truncate px-1 text-xs text-muted-foreground">
          {admin?.username ?? ''}
        </div>
        <ThemeToggle />
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          onClick={handleLogout}
        >
          <LogOut className="size-4" />
          退出登录
        </Button>
      </div>
    </>
  )

  return (
    <div className="flex h-screen flex-col md:grid md:grid-cols-[260px_1fr]">
      <a
        href="#main-content"
        className="sr-only z-[60] rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        跳到主要内容
      </a>
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-sidebar-border bg-sidebar px-3 text-sidebar-foreground md:hidden">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="打开导航菜单"
            onClick={() => setMobileNavOpen(true)}
          >
            <Menu className="size-4" aria-hidden="true" />
          </Button>
          <span className="font-heading text-sm font-semibold">管理后台</span>
        </div>
        <span className="truncate text-xs text-muted-foreground">{admin?.username ?? ''}</span>
      </header>
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent
          side="left"
          className="w-[260px] gap-0 bg-sidebar p-0 text-sidebar-foreground sm:max-w-[260px]"
        >
          <SheetTitle className="sr-only">后台导航</SheetTitle>
          <SheetDescription className="sr-only">管理后台功能导航菜单</SheetDescription>
          <div className="flex h-full min-h-0 flex-col">
            {renderSidebarContent(() => setMobileNavOpen(false))}
          </div>
        </SheetContent>
      </Sheet>
      <nav
        className="hidden min-h-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex"
        aria-label="后台导航"
      >
        {renderSidebarContent()}
      </nav>
      <main id="main-content" className="min-w-0 flex-1 overflow-auto" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  )
}
