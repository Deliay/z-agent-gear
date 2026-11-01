import { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionStream } from './useSessionStream'
import { parseSessionUpdate } from '@/components/session/group-messages'
import {
  mergeToolCallMessages,
  toolCallHeaderTitle,
  type ToolCallMessageLike,
} from '@/components/session/tool-call-state'

/** 动态行结尾截断字符数（思考/文本共用，导出便于单测与后续调整） */
export const LIVE_ACTIVITY_TAIL_CHARS = 40

/** 节点卡片动态行保留的最近消息条数上限（防止长会话无限增长） */
const MAX_TRACKED_MESSAGES = 300

export type LiveActivityKind = 'thinking' | 'tool_call' | 'text'

export interface NodeLiveActivity {
  kind: LiveActivityKind
  text: string
}

export interface NodeSessionActivity {
  activity: NodeLiveActivity | null
  /** 最近一次 `usage_update.used`；无用量信息为 null */
  tokenUsage: number | null
}

/** 结尾截断：超长时保留尾部并加前缀省略号（单行展示，永不换行撑高卡片） */
export function tailText(text: string, limit = LIVE_ACTIVITY_TAIL_CHARS): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  return `…${normalized.slice(-limit)}`
}

function parseUpdate(update: unknown): Record<string, unknown> | null {
  if (!update || typeof update !== 'object') return null
  const record = update as Record<string, unknown>
  // SSE 的 `message` 事件下发消息对象，{content} 内才是 SessionUpdate；
  // history 与直接传入的 SessionUpdate 两种形态都要兼容。
  if (!('sessionUpdate' in record) && 'content' in record) {
    return (parseSessionUpdate(record.content as string | Record<string, unknown>) as unknown as Record<string, unknown>) ?? null
  }
  return record
}

function textOf(parsed: Record<string, unknown>): string {
  const content = parsed.content
  if (typeof content === 'string') return content
  if (content && typeof content === 'object') {
    const text = (content as Record<string, unknown>).text
    if (typeof text === 'string') return text
  }
  const fallback = parsed.text
  return typeof fallback === 'string' ? fallback : ''
}

function isToolCallUpdate(type: unknown): boolean {
  return type === 'tool_call' || type === 'tool_call_update'
}

/**
 * 将一组会话消息归一为「最新一行活动 + 最近一次用量」。
 *
 * 口径与会话页一致：思考/文本取结尾 `LIVE_ACTIVITY_TAIL_CHARS` 字符；
 * 工具调用直接复用 `mergeToolCallMessages` / `toolCallHeaderTitle`（禁止另写一套标题逻辑）。
 */
export function summarizeSessionUpdates(updates: unknown[]): NodeSessionActivity {
  const toolMessages = new Map<string, ToolCallMessageLike[]>()
  let nonTool: { seq: number; activity: NodeLiveActivity } | null = null
  let lastToolSeq = -1
  let lastToolCallId: string | null = null
  let tokenUsage: number | null = null
  let seq = 0

  for (const update of updates) {
    const parsed = parseUpdate(update)
    if (!parsed) continue
    const type = parsed.sessionUpdate
    seq += 1

    if (type === 'agent_thought_chunk') {
      nonTool = { seq, activity: { kind: 'thinking', text: tailText(textOf(parsed)) } }
    } else if (type === 'agent_message_chunk') {
      nonTool = { seq, activity: { kind: 'text', text: tailText(textOf(parsed)) } }
    } else if (isToolCallUpdate(type)) {
      const toolCallId = typeof parsed.toolCallId === 'string' ? parsed.toolCallId : null
      if (toolCallId) {
        const list = toolMessages.get(toolCallId) ?? []
        list.push({ content: parsed as unknown as Record<string, unknown> })
        toolMessages.set(toolCallId, list)
        lastToolCallId = toolCallId
        lastToolSeq = seq
      } else {
        const merged = mergeToolCallMessages([
          { content: parsed as unknown as Record<string, unknown> },
        ])
        nonTool = { seq, activity: { kind: 'tool_call', text: toolCallHeaderTitle(merged) } }
      }
    } else if (type === 'usage_update') {
      const used = parsed.used
      if (typeof used === 'number' && Number.isFinite(used)) {
        tokenUsage = used
      }
    }
  }

  let activity: NodeLiveActivity | null = nonTool?.activity ?? null
  if (lastToolCallId && lastToolSeq > (nonTool?.seq ?? -1)) {
    const merged = mergeToolCallMessages(toolMessages.get(lastToolCallId) ?? [])
    activity = { kind: 'tool_call', text: toolCallHeaderTitle(merged) }
  }

  return { activity, tokenUsage }
}

interface UseNodeSessionActivityOptions {
  /** 节点会话 id；为空表示该节点无会话（不建立连接） */
  sessionId?: string | null
  /** 仅在需要实时动态（进行中）时建立连接；关闭时保留已捕获的最后动态与用量 */
  active: boolean
  /**
   * 已完成节点（首屏挂载即 DONE）：短连一次拉取 SSE history 补全 token 用量，
   * 收到 history（或首次错误）后立即断开，避免为历史节点长期占用连接。
   */
  snapshot?: boolean
}

/**
 * 节点实时动态：直接复用 `useSessionStream`（鉴权/重试/生命周期天然覆盖），
 * 只在消息回调里做归一，不自行创建 EventSource。
 */
export function useNodeSessionActivity({
  sessionId,
  active,
  snapshot = false,
}: UseNodeSessionActivityOptions): NodeSessionActivity {
  const [state, setState] = useState<NodeSessionActivity>({ activity: null, tokenUsage: null })
  const updatesRef = useRef<unknown[]>([])
  const disconnectRef = useRef<(() => void) | null>(null)
  const snapshotRef = useRef(snapshot)
  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])

  const recompute = useCallback(() => {
    setState(summarizeSessionUpdates(updatesRef.current))
  }, [])

  const onMessage = useCallback(
    (message: unknown) => {
      updatesRef.current = [...updatesRef.current, message].slice(-MAX_TRACKED_MESSAGES)
      recompute()
    },
    [recompute],
  )

  const onHistory = useCallback(
    (messages: unknown[]) => {
      updatesRef.current = messages.slice(-MAX_TRACKED_MESSAGES)
      recompute()
      // 快照模式：拿到 history（含最后一条 usage_update）后立即释放连接
      if (snapshotRef.current) disconnectRef.current?.()
    },
    [recompute],
  )

  const onError = useCallback(() => {
    if (snapshotRef.current) disconnectRef.current?.()
  }, [])

  const { disconnect } = useSessionStream({
    sessionId: (active || snapshot) && sessionId ? sessionId : '',
    onMessage,
    onHistory,
    onError,
  })
  useEffect(() => {
    disconnectRef.current = disconnect
  }, [disconnect])

  return state
}
