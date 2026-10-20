import { MoreHorizontalIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuPopup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

interface ProviderActionMenuProps {
  isEnabled: boolean
  togglePending?: boolean
  onImport: () => void
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
}

export default function ProviderActionMenu({ isEnabled, togglePending = false, onImport, onEdit, onToggle, onDelete }: ProviderActionMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="操作菜单" />}>
        <MoreHorizontalIcon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuPopup>
        <DropdownMenuItem onClick={onImport}>导入模型</DropdownMenuItem>
        <DropdownMenuItem onClick={onEdit}>编辑</DropdownMenuItem>
        <DropdownMenuItem onClick={onToggle} disabled={togglePending}>
          {isEnabled ? '禁用' : '启用'}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onDelete} className="text-destructive">
          删除
        </DropdownMenuItem>
      </DropdownMenuPopup>
    </DropdownMenu>
  )
}
