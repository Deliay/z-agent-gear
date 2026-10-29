import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { TenantRole } from '@/graphql/types'
import { DEFAULT_TENANT_ROLE, TENANT_ROLE_LABELS, TENANT_ROLE_OPTIONS } from './roles'

interface AddMemberDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 服务端错误文案（本地校验失败时优先展示本地文案）。 */
  error: string | null
  submitting: boolean
  onSubmit: (username: string, role: TenantRole) => void | Promise<void>
}

const ROLE_SELECT_CLASS =
  'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50'

/**
 * 添加租户成员（仅 team 租户）：按登录名添加已存在账户，并指定租户角色（缺省开发）。
 * 只有 admin-api 转发（`adminAddTenantMember`），后台不直接写 tenantmembers。
 */
export default function AddMemberDialog({
  open,
  onOpenChange,
  error,
  submitting,
  onSubmit,
}: AddMemberDialogProps) {
  const [username, setUsername] = useState('')
  const [role, setRole] = useState<TenantRole>(DEFAULT_TENANT_ROLE)
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setUsername('')
      setRole(DEFAULT_TENANT_ROLE)
      setLocalError(null)
    }
  }, [open])

  const submit = () => {
    const trimmed = username.trim()
    if (!trimmed) {
      setLocalError('请输入成员登录名')
      return
    }
    setLocalError(null)
    void onSubmit(trimmed, role)
  }

  const message = localError ?? error

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加成员</DialogTitle>
          <DialogDescription>
            添加已存在的前台账户为团队成员，并按需指定角色（缺省为开发）。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tenant-member-username">登录名</Label>
            <Input
              id="tenant-member-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="前台账号登录名"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tenant-member-role">角色</Label>
            <select
              id="tenant-member-role"
              aria-label="角色"
              value={role}
              disabled={submitting}
              onChange={(event) => setRole(event.target.value as TenantRole)}
              className={ROLE_SELECT_CLASS}
            >
              {TENANT_ROLE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {TENANT_ROLE_LABELS[option]}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              管理员可管理租户全部工作区与成员；开发仅可读写所加入的普通工作区。
            </p>
          </div>
        </div>
        {message && (
          <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {message}
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? '添加中...' : '确认添加'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
