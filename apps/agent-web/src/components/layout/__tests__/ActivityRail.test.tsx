import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ActivityRail from '../ActivityRail';

const mockNavigate = vi.fn();
const mockLocation = { pathname: '/' };

vi.mock('react-router-dom', () => ({
  useLocation: () => mockLocation,
  useNavigate: () => mockNavigate,
}));

describe('ActivityRail 三层工作区一级导航轨', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocation.pathname = '/';
  });

  it('T-UIUX-RAIL1: 渲染概览、会话、工作流、知识库、主机、费用、设置等一级导航入口，点击可聚焦或跳转', () => {
    const onSelectSection = vi.fn();
    render(
      <ActivityRail
        activeSection="sessions"
        onSelectSection={onSelectSection}
        collapsed={false}
        onToggleCollapse={vi.fn()}
        hasPendingAttention={false}
      />,
    );

    expect(screen.getByTestId('activity-rail')).toBeInTheDocument();
    expect(screen.getByTestId('rail-item-home')).toBeInTheDocument();
    expect(screen.getByTestId('rail-item-sessions')).toBeInTheDocument();
    expect(screen.getByTestId('rail-item-workflows')).toBeInTheDocument();
    expect(screen.getByTestId('rail-item-knowledgeBases')).toBeInTheDocument();
    expect(screen.getByTestId('rail-item-hosts')).toBeInTheDocument();
    expect(screen.getByTestId('rail-item-billing')).toBeInTheDocument();
    expect(screen.getByTestId('rail-item-settings')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('rail-item-workflows'));
    expect(onSelectSection).toHaveBeenCalledWith('workflows');

    fireEvent.click(screen.getByTestId('rail-item-home'));
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('T-UIUX-RAIL2: 存在待处理 Review 或待办时在会话图标上展示醒目提醒圆点，并支持一键折叠/展开二级列表栏', () => {
    const onToggleCollapse = vi.fn();
    render(
      <ActivityRail
        activeSection="sessions"
        onSelectSection={vi.fn()}
        collapsed={false}
        onToggleCollapse={onToggleCollapse}
        hasPendingAttention={true}
      />,
    );

    expect(screen.getByTestId('rail-attention-dot')).toBeInTheDocument();

    const collapseBtn = screen.getByTestId('rail-toggle-sidebar');
    fireEvent.click(collapseBtn);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it('T-UIUX-RAIL3: 激活领域展示 2px 品牌色指示条，底部在线主机计数使用 tabular-nums', () => {
    mockLocation.pathname = '/workflows';
    render(
      <ActivityRail
        activeSection="workflows"
        onSelectSection={vi.fn()}
        collapsed={false}
        onToggleCollapse={vi.fn()}
        onlineHostCount={3}
      />,
    );

    const indicator = screen.getByTestId('rail-active-indicator');
    expect(indicator).toHaveClass('bg-primary');
    expect(indicator).toHaveClass('w-0.5');

    const onlineCount = screen.getByTestId('rail-online-count');
    expect(onlineCount).toHaveTextContent('3');
    expect(onlineCount).toHaveClass('tabular-nums');
  });
});
