import { useState } from 'react'
import { useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { FAIL_WORKFLOW_NODE } from '@/graphql/workflow'

interface FailNodeTarget {
  id: string
  type: string
  status: string
}

export interface UseFailNodeActionOptions {
  instanceId: string
  node: FailNodeTarget
}

/** 二次确认文案（三项后果，PRD 功能点 1 验收） */
export const FAIL_NODE_CONFIRM_DESCRIPTION =
  '确认后将中断会话、取消全部自动重试，节点置为失败并阻断工作流，等待人工介入。'

/**
 * 人工「立即失败」动作（节点详情抽屉）：
 * - 可见性：仅 AI 节点且 RUNNING/REWORK（与 `canRestart` 独立收窄）；
 * - 二次确认后调 `failNode`（不传 reason，走服务端缺省「人工标记失败」）；
 * - 成功 toast，失败原样展示服务端文案；不本地伪造节点状态（5s 轮询收敛）。
 */
export function useFailNodeAction({ instanceId, node }: UseFailNodeActionOptions) {
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [failNode] = useMutation(FAIL_WORKFLOW_NODE)

  const canFail = node.type === 'AI' && (node.status === 'RUNNING' || node.status === 'REWORK')

  const request = () => setOpen(true)

  const confirm = async () => {
    setSubmitting(true)
    try {
      await failNode({ variables: { instanceId, nodeId: node.id } })
      setOpen(false)
      toast.success('节点已标记失败')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  return {
    canFail,
    open,
    setOpen,
    submitting,
    request,
    confirm,
    description: FAIL_NODE_CONFIRM_DESCRIPTION,
  }
}
