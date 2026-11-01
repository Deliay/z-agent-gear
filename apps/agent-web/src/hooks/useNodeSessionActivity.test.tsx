import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  LIVE_ACTIVITY_TAIL_CHARS,
  summarizeSessionUpdates,
  tailText,
  useNodeSessionActivity,
} from './useNodeSessionActivity'

const disconnectSpy = vi.fn()
const streamCalls: Array<{
  sessionId: string
  onMessage?: (message: unknown) => void
  onHistory?: (messages: unknown[]) => void
}> = []

vi.mock('./useSessionStream', () => ({
  useSessionStream: (options: {
    sessionId: string
    onMessage?: (message: unknown) => void
    onHistory?: (messages: unknown[]) => void
  }) => {
    streamCalls.push(options)
    return { isConnected: false, error: null, disconnect: disconnectSpy }
  },
}))

/** 构造一条 SSE 消息对象：{content: JSON 字符串}（与 agent-api 下发形态一致） */
function message(update: Record<string, unknown>) {
  return { id: `m-${Math.random()}`, direction: 'output', type: 'text', content: JSON.stringify(update) }
}

beforeEach(() => {
  streamCalls.length = 0
  disconnectSpy.mockClear()
})

describe('tailText', () => {
  it('短文本原样返回，长文本保留结尾并加省略号', () => {
    expect(tailText('hello')).toBe('hello')
    const long = 'a'.repeat(LIVE_ACTIVITY_TAIL_CHARS + 10)
    const result = tailText(long)
    expect(result.startsWith('…')).toBe(true)
    expect(result.slice(1)).toBe(long.slice(-LIVE_ACTIVITY_TAIL_CHARS))
  })

  it('连续空白归一为单空格（单行展示）', () => {
    expect(tailText('a\n\n  b\tc')).toBe('a b c')
  })
})

describe('summarizeSessionUpdates', () => {
  it('T-UI4-NA1 思考消息映射为 thinking + 结尾截断', () => {
    const result = summarizeSessionUpdates([
      message({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: `思考${'x'.repeat(60)}` },
      }),
    ])
    expect(result.activity?.kind).toBe('thinking')
    expect(result.activity?.text.startsWith('…')).toBe(true)
  })

  it('T-UI4-NA2 工具调用映射为会话页同口径标题（多消息合并）', () => {
    const result = summarizeSessionUpdates([
      message({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'execute', status: 'in_progress' }),
      message({ sessionUpdate: 'tool_call_update', toolCallId: 't1', title: '执行 npm test' }),
    ])
    expect(result.activity?.kind).toBe('tool_call')
    expect(result.activity?.text).toBe('Tool Call: 执行 npm test')
  })

  it('T-UI4-NA3 普通文本映射为总结中文本', () => {
    const result = summarizeSessionUpdates([
      message({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '总结内容' } }),
    ])
    expect(result.activity).toEqual({ kind: 'text', text: '总结内容' })
  })

  it('T-UI4-NA4 usage_update 记录 used，缺失为 null', () => {
    expect(
      summarizeSessionUpdates([
        message({ sessionUpdate: 'usage_update', used: 1234 }),
        message({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }),
      ]).tokenUsage,
    ).toBe(1234)
    expect(summarizeSessionUpdates([]).tokenUsage).toBeNull()
  })

  it('T-UI4-NA5 非活动消息（user/plan/available_commands）忽略', () => {
    const result = summarizeSessionUpdates([
      message({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '用户输入' } }),
      message({ sessionUpdate: 'plan', entries: [] }),
      message({ sessionUpdate: 'available_commands_update', availableCommands: [] }),
    ])
    expect(result.activity).toBeNull()
    expect(result.tokenUsage).toBeNull()
  })

  it('后到的活动覆盖先到的工具调用（按消息顺序）', () => {
    const result = summarizeSessionUpdates([
      message({ sessionUpdate: 'tool_call', toolCallId: 't1', title: '读取文件' }),
      message({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '再想想' } }),
    ])
    expect(result.activity).toEqual({ kind: 'thinking', text: '再想想' })
  })
})

describe('useNodeSessionActivity', () => {
  it('T-UI4-NA6 无消息时活动为空（中性态由组件渲染「等待消息」）', () => {
    const { result } = renderHook(() =>
      useNodeSessionActivity({ sessionId: 's1', active: true }),
    )
    expect(result.current.activity).toBeNull()
    expect(streamCalls.at(-1)?.sessionId).toBe('s1')
  })

  it('T-UI4-NA7 节点非进行中/无会话时不建立连接，且保留已捕获状态', () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useNodeSessionActivity({ sessionId: 's1', active }),
      { initialProps: { active: true } },
    )
    act(() => {
      streamCalls.at(-1)?.onMessage?.(
        message({ sessionUpdate: 'usage_update', used: 42 }),
      )
    })
    expect(result.current.tokenUsage).toBe(42)

    rerender({ active: false })
    expect(streamCalls.at(-1)?.sessionId).toBe('')
    expect(result.current.tokenUsage).toBe(42)
  })

  it('T-UI4-NA8 已完成节点快照模式：短连拉 history 补 usage 后立即断开', () => {
    const { result } = renderHook(() =>
      useNodeSessionActivity({ sessionId: 's1', active: false, snapshot: true }),
    )
    expect(streamCalls.at(-1)?.sessionId).toBe('s1')

    act(() => {
      streamCalls.at(-1)?.onHistory?.([
        message({ sessionUpdate: 'usage_update', used: 99 }),
      ])
    })
    expect(result.current.tokenUsage).toBe(99)
    expect(disconnectSpy).toHaveBeenCalledTimes(1)
  })

  it('T-UI4-NA8 非快照的非进行中节点不建连', () => {
    renderHook(() => useNodeSessionActivity({ sessionId: 's1', active: false }))
    expect(streamCalls.at(-1)?.sessionId).toBe('')
  })

  it('history 首帧回填最新活动与用量', () => {
    renderHook(() => useNodeSessionActivity({ sessionId: 's1', active: true }))
    act(() => {
      streamCalls.at(-1)?.onHistory?.([
        message({ sessionUpdate: 'usage_update', used: 7 }),
        message({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '完成' } }),
      ])
    })
  })
})
