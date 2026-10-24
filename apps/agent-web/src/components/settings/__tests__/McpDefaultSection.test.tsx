import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import McpDefaultSection from '../McpDefaultSection'
import type { ControllerData } from '../../../graphql/types'

const mockUseQuery = vi.fn()
const mockSaveDefaultMcp = vi.fn()
const mockToastSuccess = vi.fn()

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => [mockSaveDefaultMcp, { loading: false }],
}))

vi.mock('sonner', () => ({
  toast: { success: (...args: unknown[]) => mockToastSuccess(...args), error: vi.fn() },
}))

function makeController(overrides: Partial<ControllerData> = {}): ControllerData {
  return {
    id: 'ctrl-1',
    name: 'My Machine',
    hostname: 'host-1',
    type: 'local',
    status: 'online',
    keyId: 'key-1',
    version: '1.0.0',
    lastHeartbeatAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const servers = [
  { id: 'm1', name: 'MCP A', source: 'manual', enabled: true, status: 'active' },
  { id: 'm2', name: 'MCP B', source: 'proxy', enabled: true, status: 'active' },
  { id: 'm3', name: 'MCP Off', source: 'manual', enabled: false, status: 'disabled' },
]

describe('McpDefaultSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseQuery.mockReturnValue({ data: { mcpServers: servers }, loading: false })
    mockSaveDefaultMcp.mockResolvedValue({ data: { setControllerDefaultMcp: makeController() } })
  })

  it('历史控制器（defaultMcp 缺省）默认开启「注入全部已启用」', () => {
    render(<McpDefaultSection controller={makeController()} />)

    expect(screen.getByLabelText('默认注入全部 MCP')).toBeChecked()
    expect(screen.getByText('已启用 2 个 MCP 服务，全部自动注入')).toBeInTheDocument()
  })

  it('关闭全量后可按列表勾选，保存提交 serverIds', async () => {
    render(
      <McpDefaultSection
        controller={makeController({ defaultMcp: { useAllEnabled: false, serverIds: ['m2'] } })}
      />,
    )

    expect(screen.getByLabelText('默认注入全部 MCP')).not.toBeChecked()
    expect(screen.getByLabelText('MCP A')).not.toBeChecked()
    expect(screen.getByLabelText('MCP B')).toBeChecked()
    expect(screen.getByLabelText('MCP Off')).toBeDisabled()

    fireEvent.click(screen.getByLabelText('MCP A'))
    fireEvent.click(screen.getByRole('button', { name: '保存默认 MCP' }))

    await waitFor(() => {
      expect(mockSaveDefaultMcp).toHaveBeenCalledWith({
        variables: { controllerId: 'ctrl-1', useAllEnabled: false, serverIds: ['m2', 'm1'] },
      })
    })
    expect(mockToastSuccess).toHaveBeenCalledWith('已保存，对后续新建会话生效')
  })

  it('全量模式保存时 serverIds 传空数组', async () => {
    render(<McpDefaultSection controller={makeController()} />)

    fireEvent.click(screen.getByRole('button', { name: '保存默认 MCP' }))

    await waitFor(() => {
      expect(mockSaveDefaultMcp).toHaveBeenCalledWith({
        variables: { controllerId: 'ctrl-1', useAllEnabled: true, serverIds: [] },
      })
    })
  })

  it('N-2: 保存成功后解除 dirty 并回写服务端权威值', async () => {
    mockSaveDefaultMcp.mockResolvedValue({
      data: {
        setControllerDefaultMcp: makeController({
          defaultMcp: { useAllEnabled: false, serverIds: ['m2'] },
        }),
      },
    })
    render(
      <McpDefaultSection
        controller={makeController({ defaultMcp: { useAllEnabled: false, serverIds: ['m2'] } })}
      />,
    )

    fireEvent.click(screen.getByLabelText('MCP A'))
    fireEvent.click(screen.getByRole('button', { name: '保存默认 MCP' }))

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled())
    // 回写权威值：MCP A 回到未勾选、MCP B 保持勾选
    expect(screen.getByLabelText('MCP A')).not.toBeChecked()
    expect(screen.getByLabelText('MCP B')).toBeChecked()
  })

  it('N-2: 切换控制器强制重置，不携带上一台未保存的脏值', () => {
    const { rerender } = render(
      <McpDefaultSection
        controller={makeController({ defaultMcp: { useAllEnabled: false, serverIds: ['m1'] } })}
      />,
    )
    fireEvent.click(screen.getByLabelText('MCP B'))

    rerender(
      <McpDefaultSection
        controller={makeController({
          id: 'ctrl-2',
          defaultMcp: { useAllEnabled: false, serverIds: ['m2'] },
        })}
      />,
    )

    expect(screen.getByLabelText('MCP A')).not.toBeChecked()
    expect(screen.getByLabelText('MCP B')).toBeChecked()
  })

  it('N-6: 保存成功后解除 dirty，后台刷新可回同步权威值', async () => {
    // 保存返回服务端权威值 m1（覆盖用户刚才勾选的 m2）
    mockSaveDefaultMcp.mockResolvedValue({
      data: {
        setControllerDefaultMcp: makeController({
          defaultMcp: { useAllEnabled: false, serverIds: ['m1'] },
        }),
      },
    })
    const { rerender } = render(
      <McpDefaultSection
        controller={makeController({ defaultMcp: { useAllEnabled: false, serverIds: ['m1'] } })}
      />,
    )
    fireEvent.click(screen.getByLabelText('MCP B'))
    fireEvent.click(screen.getByRole('button', { name: '保存默认 MCP' }))
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled())

    // 后台刷新带来新的权威值 m2：若 dirty 未解除，effect 会短路，MCP B 不会被取消
    rerender(
      <McpDefaultSection
        controller={makeController({ defaultMcp: { useAllEnabled: false, serverIds: ['m2'] } })}
      />,
    )
    expect(screen.getByLabelText('MCP A')).not.toBeChecked()
    expect(screen.getByLabelText('MCP B')).toBeChecked()
  })

  it('C-11: MCP_SERVER_NOT_SELECTABLE 映射为平台云工具专用提示', async () => {
    mockSaveDefaultMcp.mockRejectedValueOnce(new Error('MCP_SERVER_NOT_SELECTABLE'))
    render(<McpDefaultSection controller={makeController()} />)

    fireEvent.click(screen.getByRole('button', { name: '保存默认 MCP' }))

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        '平台云工具服务由系统自动注入，不可手动选择',
      ),
    )
  })

  it('MCP_SERVER_NOT_FOUND 映射为中文提示', async () => {
    mockSaveDefaultMcp.mockRejectedValueOnce(new Error('MCP_SERVER_NOT_FOUND'))
    render(<McpDefaultSection controller={makeController()} />)

    fireEvent.click(screen.getByRole('button', { name: '保存默认 MCP' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('所选 MCP 已停用或不存在，请重新选择')
  })
})
