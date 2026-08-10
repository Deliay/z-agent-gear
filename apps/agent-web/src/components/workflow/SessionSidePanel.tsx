import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import SessionView from '@/components/session/SessionView'

interface SessionSidePanelProps {
  sessionId: string | null
  onClose: () => void
}

/** 会话侧面板：以 Sheet 形态内嵌复用 SessionView */
export default function SessionSidePanel({ sessionId, onClose }: SessionSidePanelProps) {
  return (
    <Dialog open={sessionId != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="top-0 right-0 left-auto grid-rows-[auto_1fr] h-full max-h-none w-full translate-x-0 translate-y-0 rounded-none sm:max-w-2xl"
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle>节点会话</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          {sessionId && <SessionView key={sessionId} sessionId={sessionId} />}
        </div>
      </DialogContent>
    </Dialog>
  )
}
