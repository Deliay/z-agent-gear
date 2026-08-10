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
  /** 工作流节点会话：确认后待会话 ready 会自动发送工作流继续提示词 */
  isWorkflowNode: boolean
}

/** 断连会话「继续」确认框：提示用户确认后系统将恢复会话并让 AI 继续工作 */
export default function ResumeConfirmDialog({ open, onOpenChange, onConfirm, isWorkflowNode }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>检测到 AI 断连</DialogTitle>
          <DialogDescription>
            当前会话处于断连状态。是否让 AI 继续？
            {isWorkflowNode && '确认后将等待会话恢复，并提示 AI 调用工作流 MCP 工具继续之前的工作。'}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={onConfirm}>让 AI 继续</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
