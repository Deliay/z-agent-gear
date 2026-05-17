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
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
}

export default function ProviderActionMenu({ isEnabled, onEdit, onToggle, onDelete }: ProviderActionMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="操作菜单" />}>
        <MoreHorizontalIcon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuPopup align="end">
        <DropdownMenuItem onClick={onEdit}>编辑</DropdownMenuItem>
        <DropdownMenuItem onClick={onToggle}>
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
