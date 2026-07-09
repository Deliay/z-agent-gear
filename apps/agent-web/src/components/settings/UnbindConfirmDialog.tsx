import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export default function UnbindConfirmDialog({ open, onOpenChange, onConfirm }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>确认解绑</DialogTitle>
          <DialogDescription>
            确定要解绑此 GitHub 帐号吗？关联的仓库数据也将被移除。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button variant="destructive" onClick={onConfirm}>解绑</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
