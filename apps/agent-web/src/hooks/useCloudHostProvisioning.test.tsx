import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useCloudHostProvisioning } from './useCloudHostProvisioning'
import type { HarnessType } from '../graphql/types'

const mockCreateCloudHost = vi.fn()
const mockSetupGithubProject = vi.fn()

vi.mock('@apollo/client/react', () => ({
  useMutation: (doc: unknown) =>
    JSON.stringify(doc).includes('setupCloudHostGithubProject')
      ? [mockSetupGithubProject]
      : [mockCreateCloudHost],
}))

const project = {
  accountId: 'acc-1',
  repoFullName: 'alice/repo-a',
  targetPath: '/root/workspace',
}

describe('useCloudHostProvisioning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateCloudHost.mockResolvedValue({
      data: {
        createCloudHost: {
          id: 'cloud-1',
          name: '云电脑 A',
          controllerId: 'ctrl-cloud',
          status: 'STARTING',
          harnessTypes: ['OPENCODE'],
          defaultSessionId: null,
          activeSessionCount: 0,
          failureReason: null,
          deletedAt: null,
        },
      },
    })
    mockSetupGithubProject.mockResolvedValue({
      data: { setupCloudHostGithubProject: { id: 'op-1', kind: 'GITHUB_SETUP', status: 'RUNNING', steps: [] } },
    })
  })

  it('createCloudHost 显式关闭默认会话，并记录 hostId', async () => {
    const { result } = renderHook(() => useCloudHostProvisioning())

    await act(async () => {
      await result.current.start({
        name: '云电脑 A',
        harnessTypes: ['OPENCODE'],
        project,
        workloadIds: ['wl-docker'],
      })
    })

    expect(mockCreateCloudHost).toHaveBeenCalledWith({
      variables: {
        input: {
          name: '云电脑 A',
          harnessTypes: ['OPENCODE'],
          workloadIds: ['wl-docker'],
          createDefaultSession: false,
        },
      },
    })
    expect(result.current.hostId).toBe('cloud-1')
    expect(result.current.operationId).toBeNull()
    expect(mockSetupGithubProject).not.toHaveBeenCalled()
  })

  it('单 Harness 时 setup 传 createSession=true 并记录 operationId', async () => {
    const { result } = renderHook(() => useCloudHostProvisioning())
    await act(async () => {
      await result.current.start({ name: '云电脑 A', harnessTypes: ['OPENCODE'], project })
    })

    await act(async () => {
      await result.current.beginProjectSetup({
        controllerId: 'ctrl-cloud',
        harnessTypes: ['OPENCODE'],
        project,
      })
    })

    expect(mockSetupGithubProject).toHaveBeenCalledWith({
      variables: {
        input: {
          controllerId: 'ctrl-cloud',
          accountId: 'acc-1',
          repoFullName: 'alice/repo-a',
          targetPath: '/root/workspace',
          createSession: true,
        },
      },
    })
    expect(result.current.operationId).toBe('op-1')
  })

  it('多 Harness 时 setup 传 createSession=false（会话步骤 SKIPPED）', async () => {
    const { result } = renderHook(() => useCloudHostProvisioning())

    await act(async () => {
      await result.current.beginProjectSetup({
        controllerId: 'ctrl-cloud',
        harnessTypes: ['OPENCODE', 'CLAUDE_CODE'] as unknown as HarnessType[],
        project,
      })
    })

    const input = mockSetupGithubProject.mock.calls[0][0].variables.input
    expect(input.createSession).toBe(false)
    expect(input).not.toHaveProperty('workloadIds')
  })

  it('reset 清空编排状态', async () => {
    const { result } = renderHook(() => useCloudHostProvisioning())
    await act(async () => {
      await result.current.start({ name: '云电脑 A', harnessTypes: ['OPENCODE'], project })
    })

    act(() => result.current.reset())

    expect(result.current.hostId).toBeNull()
    expect(result.current.operationId).toBeNull()
    expect(result.current.error).toBeNull()
  })
})
