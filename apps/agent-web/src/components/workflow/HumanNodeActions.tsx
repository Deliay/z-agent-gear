import { useHumanNodeActions } from '@/hooks/useHumanNodeActions'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'

interface HumanNodeActionsProps {
  instanceId: string
  node: { id: string; name: string }
  /** 图表卡片内使用：更紧凑的排版 + 手势隔离 */
  compact?: boolean
}

/**
 * 人类节点操作区（完成 / 打回）：列表视图、图表卡片、详情抽屉三处共用同一份 hook 与交互，
 * 保证草稿、校验、错误提示三处一致。
 */
export default function HumanNodeActions({ instanceId, node, compact }: HumanNodeActionsProps) {
  const {
    input,
    setInput,
    rejectOpen,
    setRejectOpen,
    reason,
    setReason,
    submitting,
    handleComplete,
    handleReject,
    canReject,
  } = useHumanNodeActions({ instanceId, node })

  return (
    <div className={compact ? 'nodrag mt-2 space-y-1.5 border-t pt-2' : 'mt-3 space-y-2 border-t pt-3'}>
      <textarea
        aria-label={`${node.name} 完成输入`}
        className={`nodrag w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 ${
          compact ? 'min-h-10 text-xs' : 'min-h-16'
        }`}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        placeholder="输入内容（将作为节点产物写入黑板，可为空）"
      />
      <div className="nodrag flex gap-2">
        <Button
          size="xs"
          onClick={(e) => {
            e.stopPropagation()
            void handleComplete()
          }}
          disabled={submitting}
        >
          完成
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={(e) => {
            e.stopPropagation()
            setRejectOpen(true)
          }}
          disabled={submitting}
        >
          打回
        </Button>
      </div>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>打回节点「{node.name}」</DialogTitle>
            <DialogDescription>
              请填写打回理由，上游节点将收到理由并返工修正。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>打回理由</Label>
            <textarea
              aria-label="打回理由"
              className="min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="请说明打回原因"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleReject()}
              disabled={!canReject || submitting}
            >
              确认打回
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
