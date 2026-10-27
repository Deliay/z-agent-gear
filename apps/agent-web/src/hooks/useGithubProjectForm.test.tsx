import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useGithubProjectForm } from './useGithubProjectForm'
import { GET_GITHUB_ACCOUNTS } from '../graphql/queries'

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
        defaultWorkspace: '/home/worker/custom',
        hasDefaultWorkspace: true,
      }),
    )

    await waitFor(() => expect(result.current.targetPath).toBe('/home/worker/custom'))
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

  it('~/workspace 前缀无错误、归一为 /home/worker/workspace 且预览展开', async () => {
    const { result } = renderHook(() =>
      useGithubProjectForm({ open: true, controllerId: 'ctrl-1' }),
    )
    await waitFor(() => expect(result.current.targetPath).toBe('~/workspace'))

    act(() => result.current.setRepoFullName('alice/repo-a'))

    expect(result.current.prefixError).toBeNull()
    expect(result.current.normalizedPrefix).toBe('/home/worker/workspace')
    expect(result.current.finalClonePath).toBe('/home/worker/workspace/alice/repo-a')
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

  it('T-AW-G15: 锁定帐号固定不可切换，仓库列表来自该帐号', async () => {
    mockUseQuery.mockImplementation((query: unknown) => {
      if (query === GET_GITHUB_ACCOUNTS) {
        return {
          data: {
            githubAccounts: [
              {
                id: 'acc-1',
                githubLogin: 'alice',
                installations: [{ repos: [{ fullName: 'alice/a' }] }],
              },
              {
                id: 'acc-2',
                githubLogin: 'bob',
                installations: [{ repos: [{ fullName: 'bob/b' }] }],
              },
            ],
          },
          loading: false,
        }
      }
      return { data: null, loading: false }
    })
    const { result } = renderHook(() =>
      useGithubProjectForm({
        open: true,
        controllerId: 'ctrl-1',
        lockedAccountId: 'acc-2',
      }),
    )
    await waitFor(() => expect(result.current.accountId).toBe('acc-2'))
    expect(result.current.repos.map((repo) => repo.fullName)).toEqual(['bob/b'])
    act(() => result.current.setAccountId('acc-1'))
    expect(result.current.accountId).toBe('acc-2')
  })

  it('T-AW-G16: 锁定帐号不在账号列表时标记授权失效', async () => {
    mockUseQuery.mockImplementation((query: unknown) => {
      if (query === GET_GITHUB_ACCOUNTS) {
        return {
          data: { githubAccounts: [{ id: 'acc-1', githubLogin: 'alice', installations: [] }] },
          loading: false,
        }
      }
      return { data: null, loading: false }
    })
    const { result } = renderHook(() =>
      useGithubProjectForm({
        open: true,
        controllerId: 'ctrl-1',
        lockedAccountId: 'acc-missing',
      }),
    )
    await waitFor(() => expect(result.current.lockedAccountMissing).toBe(true))
  })
})
