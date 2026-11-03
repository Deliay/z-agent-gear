import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useHumanNodeActions } from './useHumanNodeActions'
import { toast } from 'sonner'

const mockComplete = vi.fn()
const mockReject = vi.fn()

vi.mock('@apollo/client/react', () => ({
  useMutation: (doc: unknown) => {
    const name = JSON.stringify(doc)
    return [name.includes('CompleteHumanNode') ? mockComplete : mockReject]
  },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const NODE = { id: 'n1', name: '评审' }
const INSTANCE_ID = 'inst-1'
const DRAFT_KEY = `workflow-node-draft:${INSTANCE_ID}:${NODE.id}`

describe('useHumanNodeActions', () => {
  beforeEach(() => {
    mockComplete.mockReset().mockResolvedValue({})
    mockReject.mockReset().mockResolvedValue({})
    localStorage.clear()
    vi.mocked(toast.success).mockClear()
    vi.mocked(toast.error).mockClear()
  })

  it('T-UI4-HA1 草稿从 localStorage 回填并随输入保存', async () => {
    localStorage.setItem(DRAFT_KEY, '已填内容')
    const { result } = renderHook(() => useHumanNodeActions({ instanceId: INSTANCE_ID, node: NODE }))
    expect(result.current.input).toBe('已填内容')

    act(() => result.current.setInput('新内容'))
    await waitFor(() => expect(localStorage.getItem(DRAFT_KEY)).toBe('新内容'))
  })

  it('T-UI4-HA2 完成节点传参正确并清空草稿', async () => {
    const { result } = renderHook(() => useHumanNodeActions({ instanceId: INSTANCE_ID, node: NODE }))
    act(() => result.current.setInput(' 通过 '))
    await act(async () => {
      await result.current.handleComplete()
    })
    expect(mockComplete).toHaveBeenCalledWith({
      variables: { instanceId: INSTANCE_ID, nodeId: NODE.id, input: '通过' },
      refetchQueries: [expect.objectContaining({ variables: { id: INSTANCE_ID } })],
    })
    expect(result.current.input).toBe('')
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
    expect(toast.success).toHaveBeenCalledWith('节点已完成')
  })

  it('T-UI4-HA3 空输入完成时 input 传 null', async () => {
    const { result } = renderHook(() => useHumanNodeActions({ instanceId: INSTANCE_ID, node: NODE }))
    await act(async () => {
      await result.current.handleComplete()
    })
    expect(mockComplete.mock.calls[0][0].variables.input).toBeNull()
  })

  it('T-UI4-HA4 打回理由为空不提交；非空按 trim 提交', async () => {
    const { result } = renderHook(() => useHumanNodeActions({ instanceId: INSTANCE_ID, node: NODE }))
    await act(async () => {
      await result.current.handleReject()
    })
    expect(mockReject).not.toHaveBeenCalled()

    act(() => result.current.setReason('  缺少测试  '))
    await act(async () => {
      await result.current.handleReject()
    })
    expect(mockReject).toHaveBeenCalledWith({
      variables: { instanceId: INSTANCE_ID, nodeId: NODE.id, reason: '缺少测试' },
      refetchQueries: [expect.objectContaining({ variables: { id: INSTANCE_ID } })],
    })
    expect(result.current.reason).toBe('')
    expect(result.current.rejectOpen).toBe(false)
  })

  it('T-UI4-HA5 失败映射错误文案，提交态复位', async () => {
    mockComplete.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useHumanNodeActions({ instanceId: INSTANCE_ID, node: NODE }))
    await act(async () => {
      await result.current.handleComplete()
    })
    expect(toast.error).toHaveBeenCalledWith('boom')
    expect(result.current.submitting).toBe(false)
  })
})
