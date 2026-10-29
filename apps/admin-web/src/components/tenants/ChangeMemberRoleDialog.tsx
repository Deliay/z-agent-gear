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
import { Label } from '@/components/ui/label'
import type { TenantRole } from '@/graphql/types'
import { TENANT_ROLE_LABELS, TENANT_ROLE_OPTIONS } from './roles'

interface ChangeMemberRoleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 被变更成员的登录名（用于确认文案）。 */
  username: string
  /** 当前角色（初始选中项）。 */
  currentRole: TenantRole
  error: string | null
  submitting: boolean
  onSubmit: (role: TenantRole) => void | Promise<void>
}

const ROLE_SELECT_CLASS =
  'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50'

/**
 * 变更租户成员角色。
 *
 * 后台契约本期只提供 `adminAddTenantMember` / `adminRemoveTenantMember`（无角色变更 mutation），
 * 因此以「移除 + 重新添加」完成：先移除该成员再按新角色添加。中途失败会明确提示需人工重试，
 * last-admin 保护由服务端拒绝（最后一名管理员移除返回 `last admin cannot be removed`）。
 */
export default function ChangeMemberRoleDialog({
  open,
  onOpenChange,
  username,
  currentRole,
  error,
  submitting,
  onSubmit,
}: ChangeMemberRoleDialogProps) {
  const [role, setRole] = useState<TenantRole>(currentRole)

  useEffect(() => {
    if (open) setRole(currentRole)
  }, [open, currentRole])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>变更角色</DialogTitle>
          <DialogDescription>
            将成员「{username}」的角色由「{TENANT_ROLE_LABELS[currentRole] ?? currentRole}」调整为所选角色。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="tenant-member-new-role">新角色</Label>
          <select
            id="tenant-member-new-role"
            aria-label="新角色"
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
            后台暂未提供角色变更接口，本次变更以「移除并重新添加」完成：成员会短暂失去访问权限。
            移除会级联清空该成员在本租户全部普通工作区的成员关系，重新添加后不会自动恢复，
            需由管理员在对应工作区重新添加成员。最后一名管理员将被服务端拒绝（last-admin 保护）。
          </p>
        </div>
        {error && (
          <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button onClick={() => void onSubmit(role)} disabled={submitting || role === currentRole}>
            {submitting ? '变更中...' : '确认变更'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
