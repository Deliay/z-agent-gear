import { useEffect, useState } from 'react'
import { useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import {
  GET_WORKFLOW_INSTANCE,
  COMPLETE_HUMAN_NODE,
  REJECT_NODE,
} from '@/graphql/workflow'

interface HumanNodeTarget {
  id: string
  name: string
}

export interface UseHumanNodeActionsOptions {
  instanceId: string
  node: HumanNodeTarget
}

/**
 * 人类节点操作（完成 / 打回）的共享实现：
 * 列表视图 `WorkflowNodeTree`、图表卡片 `WorkflowNodeCard`、详情抽屉 `NodeDetailDrawer` 三处共用，
 * 行为与抽离前完全一致（草稿持久化键 `workflow-node-draft:{instanceId}:{nodeId}`）。
 */
export function useHumanNodeActions({ instanceId, node }: UseHumanNodeActionsOptions) {
  // 实例页轮询期间节点状态翻转会使输入区重挂；输入内容按 instanceId+nodeId 持久化到 localStorage，
  // 刷新/重挂后自动恢复，完成/打回后清除。
  const draftKey = `workflow-node-draft:${instanceId}:${node.id}`
  const [input, setInput] = useState(() => {
    if (typeof localStorage === 'undefined') return ''
    return localStorage.getItem(draftKey) ?? ''
  })
  const [rejectOpen, setRejectOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    if (input) {
      localStorage.setItem(draftKey, input)
    } else {
      localStorage.removeItem(draftKey)
    }
  }, [draftKey, input])

  const [completeHumanNode] = useMutation(COMPLETE_HUMAN_NODE)
  const [rejectNode] = useMutation(REJECT_NODE)

  const refetch = [{ query: GET_WORKFLOW_INSTANCE, variables: { id: instanceId } }]

  const handleComplete = async () => {
    setSubmitting(true)
    try {
      await completeHumanNode({
        variables: { instanceId, nodeId: node.id, input: input.trim() || null },
        refetchQueries: refetch,
      })
      setInput('')
      localStorage.removeItem(draftKey)
      toast.success('节点已完成')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  const handleReject = async () => {
    if (!reason.trim()) return
    setSubmitting(true)
    try {
      await rejectNode({
        variables: { instanceId, nodeId: node.id, reason: reason.trim() },
        refetchQueries: refetch,
      })
      setRejectOpen(false)
      setReason('')
      toast.success('已打回上游节点')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '打回失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  return {
    input,
    setInput,
    rejectOpen,
    setRejectOpen,
    reason,
    setReason,
    submitting,
    handleComplete,
    handleReject,
    canReject: reason.trim().length > 0,
  }
}
