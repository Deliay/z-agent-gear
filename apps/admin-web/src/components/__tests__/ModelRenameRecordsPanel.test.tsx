import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ModelRenameRecordsPanel from '../models/ModelRenameRecordsPanel'

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  refetch: vi.fn(),
}))

vi.mock('@apollo/client', () => ({
  gql: (strings: TemplateStringsArray) => strings.join(''),
}))

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
}))

describe('ModelRenameRecordsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('T-W17: does not query while collapsed and renders rows after expanding', () => {
    mocks.useQuery.mockReturnValue({
      data: {
        modelRenameRecords: [
          {
            id: 'r1',
            modelId: 'm1',
            providerId: 'p1',
            providerName: 'OpenAI A',
            oldName: 'gpt-4o',
            newName: 'gpt-4o-2',
            batchId: '20261020-005',
            renamedAt: '2026-10-20T08:00:00.000Z',
          },
        ],
      },
      loading: false,
      error: undefined,
      refetch: mocks.refetch,
    })

    render(<ModelRenameRecordsPanel />)

    // 折叠时不发起查询
    expect(mocks.useQuery).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ skip: true }))
    expect(screen.queryByText('gpt-4o-2')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /重名整理记录/ }))

    expect(mocks.useQuery).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ skip: false }))
    expect(screen.getByText('gpt-4o')).toBeDefined()
    expect(screen.getByText('gpt-4o-2')).toBeDefined()
    expect(screen.getByText('OpenAI A')).toBeDefined()
  })

  it('T-W17: shows the empty state', () => {
    mocks.useQuery.mockReturnValue({
      data: { modelRenameRecords: [] },
      loading: false,
      error: undefined,
      refetch: mocks.refetch,
    })

    render(<ModelRenameRecordsPanel />)
    fireEvent.click(screen.getByRole('button', { name: /重名整理记录/ }))

    expect(screen.getByText('暂无重名整理记录')).toBeDefined()
  })
})
