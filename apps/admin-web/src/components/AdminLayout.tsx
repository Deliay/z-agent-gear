import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { Boxes, Cloud, LogOut, Server } from 'lucide-react'
import { useAuth } from '@/stores/auth'
import { Button } from '@/components/ui/button'

const NAV_ITEMS = [
  { to: '/models', label: '模型配置', icon: Server },
  { to: '/base-images', label: '基础镜像', icon: Boxes },
  { to: '/cloud-containers', label: '云端容器', icon: Cloud },
]

export default function AdminLayout() {
  const { admin, logout } = useAuth()
  const navigate = useNavigate()

  const handleLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="grid h-screen grid-cols-[240px_1fr]">
      <nav
        className="flex min-h-0 flex-col border-r bg-sidebar text-sidebar-foreground"
        aria-label="后台导航"
      >
        <div className="shrink-0 border-b border-sidebar-border px-4 py-3 font-heading text-base font-medium">
          管理后台
        </div>
        <ul className="flex-1 space-y-1 overflow-y-auto p-3">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                className={({ isActive }) =>
                  `flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                    isActive
                      ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                      : 'text-sidebar-foreground hover:bg-sidebar-accent'
                  }`
                }
              >
                <Icon className="size-4 shrink-0" />
                <span className="truncate">{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="shrink-0 space-y-2 border-t border-sidebar-border p-3">
          <div className="truncate px-1 text-xs text-muted-foreground">
            {admin?.username ?? ''}
          </div>
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
      </nav>
      <main className="min-w-0 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}
