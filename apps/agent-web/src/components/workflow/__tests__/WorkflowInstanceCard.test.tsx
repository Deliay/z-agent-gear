import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import WorkflowInstanceCard from '../WorkflowInstanceCard'
import type { WorkflowInstanceSummaryData } from '@/graphql/workflow'

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }))

vi.mock('react-router-dom', () => ({
  NavLink: ({ children, to, title }: { children: React.ReactNode; to: string; title?: string }) => (
    <a href={to} title={title}>
      {children}
    </a>
  ),
  useNavigate: () => navigateMock,
}))

function makeInstance(overrides: Partial<WorkflowInstanceSummaryData> = {}): WorkflowInstanceSummaryData {
  return {
    id: 'wf-1',
    configuredWorkflowId: null,
    controllerId: 'ctrl-1',
    workspaceId: 'ws-1',
    name: 'UI 优化四期',
    currentNodeNames: [],
    lastNodeName: '实现',
    lastNodeStatus: 'DONE',
    archived: false,
    workspace: { id: 'ws-1', name: 'z-agent-gear' },
    controller: { id: 'ctrl-1', name: '我的主机' },
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

describe('WorkflowInstanceCard', () => {
  it('T-UI4-IC1 两行布局：名称 + 状态徽标 / 工作区', () => {
    render(<ul><WorkflowInstanceCard instance={makeInstance()} /></ul>)
    expect(screen.getByText('UI 优化四期')).toHaveClass('font-semibold')
    expect(screen.getByTestId('workflow-instance-workspace')).toHaveTextContent('z-agent-gear')
    expect(screen.getByTestId('workflow-instance-status')).toHaveTextContent('已完成')
  })

  it('T-UI4-IC2 不在卡片上显示控制器名称（移入 tooltip）', () => {
    const { container } = render(<ul><WorkflowInstanceCard instance={makeInstance()} /></ul>)
    expect(container.textContent).not.toContain('我的主机')
    expect(container.querySelector('a')?.getAttribute('title')).toContain('控制器：我的主机')
  })

  it('T-UI4-IC3 工作区判空回退「未知工作区」', () => {
    render(<ul><WorkflowInstanceCard instance={makeInstance({ workspace: null })} /></ul>)
    expect(screen.getByTestId('workflow-instance-workspace')).toHaveTextContent('未知工作区')
  })

  it('T-UI4-IC4 执行中显示执行中徽标（配色随状态体系）', () => {
    render(
      <ul>
        <WorkflowInstanceCard instance={makeInstance({ currentNodeNames: ['实现'], lastNodeStatus: 'RUNNING' })} />
      </ul>,
    )
    const badge = screen.getByTestId('workflow-instance-status')
    expect(badge).toHaveTextContent('执行中')
    expect(badge.className).toContain('bg-info/15')
    expect(badge).toHaveAttribute('data-status', 'RUNNING')
  })

  it('T-UI4-IC5 失败态徽标走 destructive 语义色，与打回（warning）可区分', () => {
    render(
      <ul>
        <WorkflowInstanceCard
          instance={makeInstance({ lastNodeName: '实现', lastNodeStatus: 'FAILED' })}
        />
      </ul>,
    )
    expect(screen.getByTestId('workflow-instance-status').className).toContain('destructive')
  })
})

describe('WorkflowInstanceCard 不可用与接续入口（T-WEB1）', () => {
  beforeEach(() => {
    navigateMock.mockReset()
  })

  it('T-WEB1a 控制器离线：展示不可用徽标与「接续」按钮', () => {
    render(
      <ul>
        <WorkflowInstanceCard instance={makeInstance({ unavailableReason: 'CONTROLLER_OFFLINE' })} />
      </ul>,
    )
    expect(screen.getByTestId('workflow-instance-unavailable')).toHaveTextContent('控制器离线')
    expect(screen.getByRole('button', { name: '接续工作流' })).toBeInTheDocument()
  })

  it('T-WEB1b 控制器已删除：展示已删除徽标', () => {
    render(
      <ul>
        <WorkflowInstanceCard instance={makeInstance({ unavailableReason: 'CONTROLLER_DELETED' })} />
      </ul>,
    )
    expect(screen.getByTestId('workflow-instance-unavailable')).toHaveTextContent('控制器已删除')
  })

  it('T-WEB1c 点击接续跳转 ?continue=1，不触发卡片导航', () => {
    render(
      <ul>
        <WorkflowInstanceCard instance={makeInstance({ unavailableReason: 'CONTROLLER_OFFLINE' })} />
      </ul>,
    )
    fireEvent.click(screen.getByRole('button', { name: '接续工作流' }))
    expect(navigateMock).toHaveBeenCalledWith('/workflows/wf-1?continue=1')
  })

  it('T-WEB1d 可用实例零变化：无徽标无接续按钮', () => {
    render(<ul><WorkflowInstanceCard instance={makeInstance({ unavailableReason: null })} /></ul>)
    expect(screen.queryByTestId('workflow-instance-unavailable')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '接续工作流' })).not.toBeInTheDocument()
  })
})
