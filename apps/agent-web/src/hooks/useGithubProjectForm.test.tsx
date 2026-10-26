import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useGithubProjectForm } from './useGithubProjectForm'

const mockUseQuery = vi.fn()

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}))

function mockQueries() {
  mockUseQuery.mockImplementation(() => ({ data: null, loading: false }))
}

describe('useGithubProjectForm 前缀默认值', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockQueries()
  })

  it('hasDefaultWorkspace=true 预填 defaultWorkspace', async () => {
    const { result } = renderHook(() =>
      useGithubProjectForm({
        open: true,
        controllerId: 'ctrl-1',
        defaultWorkspace: '/root/custom',
        hasDefaultWorkspace: true,
      }),
    )

    await waitFor(() => expect(result.current.targetPath).toBe('/root/custom'))
  })

  it('hasDefaultWorkspace=false 预填 ~/workspace', async () => {
    const { result } = renderHook(() =>
      useGithubProjectForm({
        open: true,
        controllerId: 'ctrl-1',
        defaultWorkspace: null,
        hasDefaultWorkspace: false,
      }),
    )

    await waitFor(() => expect(result.current.targetPath).toBe('~/workspace'))
  })

  it('未传 hasDefaultWorkspace（新建云电脑）预填 ~/workspace', async () => {
    const { result } = renderHook(() =>
      useGithubProjectForm({ open: true, controllerId: 'ctrl-1' }),
    )

    await waitFor(() => expect(result.current.targetPath).toBe('~/workspace'))
  })

  it('~/workspace 前缀无错误、归一为 /root/workspace 且预览展开', async () => {
    const { result } = renderHook(() =>
      useGithubProjectForm({ open: true, controllerId: 'ctrl-1' }),
    )
    await waitFor(() => expect(result.current.targetPath).toBe('~/workspace'))

    act(() => result.current.setRepoFullName('alice/repo-a'))

    expect(result.current.prefixError).toBeNull()
    expect(result.current.normalizedPrefix).toBe('/root/workspace')
    expect(result.current.finalClonePath).toBe('/root/workspace/alice/repo-a')
  })

  it('~abc 返回起始字符错误文案', async () => {
    const { result } = renderHook(() =>
      useGithubProjectForm({ open: true, controllerId: 'ctrl-1' }),
    )
    await waitFor(() => expect(result.current.targetPath).toBe('~/workspace'))

    act(() => result.current.setTargetPath('~abc'))

    expect(result.current.prefixError).toBe('前缀地址必须以 / 或 ~ 开头')
    expect(result.current.normalizedPrefix).toBeNull()
  })
})
