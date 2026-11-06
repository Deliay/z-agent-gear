// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import SessionHeader from '../SessionHeader';

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    session: {
      id: 's1',
      userId: 'u1',
      controllerId: 'c1',
      controllerName: 'ctrl',
      acpServerType: 'opencode',
      status: 'idling',
      externalSessionId: null,
      cwd: '/ws',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      endedAt: null,
      archived: false,
    },
    status: 'idling',
    onClose: vi.fn(),
    onDelete: vi.fn(),
    splitMode: 'chat' as const,
    onSplitModeChange: vi.fn(),
    live: false,
    onLiveChange: vi.fn(),
    wideEnoughForHorizontal: true,
    ...overrides,
  };
}

describe('SessionHeader 分屏门控（T-HDR / 返工 A2 前置）', () => {
  beforeEach(() => cleanup());

  it('三模式切换按钮触发 onSplitModeChange', () => {
    const onSplitModeChange = vi.fn();
    render(<SessionHeader {...baseProps({ splitMode: 'chat', onSplitModeChange })} />);
    fireEvent.click(screen.getByTestId('split-mode-horizontal'));
    expect(onSplitModeChange).toHaveBeenCalledWith('horizontal');
    fireEvent.click(screen.getByTestId('split-mode-vertical'));
    expect(onSplitModeChange).toHaveBeenCalledWith('vertical');
    fireEvent.click(screen.getByTestId('split-mode-chat'));
    expect(onSplitModeChange).toHaveBeenCalledWith('chat');
  });

  it('宽度门控：wideEnoughForHorizontal=false 隐藏「左右分栏」入口', () => {
    render(<SessionHeader {...baseProps({ wideEnoughForHorizontal: false })} />);
    expect(screen.queryByTestId('split-mode-horizontal')).toBeNull();
    expect(screen.getByTestId('split-mode-vertical')).toBeTruthy();
  });

  it('实况开关仅非 chat 渲染', () => {
    const { rerender } = render(<SessionHeader {...baseProps({ splitMode: 'chat' })} />);
    expect(screen.queryByTestId('live-toggle')).toBeNull();
    rerender(<SessionHeader {...baseProps({ splitMode: 'horizontal' })} />);
    expect(screen.getByTestId('live-toggle')).toBeTruthy();
  });

  it('实况开关触发 onLiveChange', () => {
    const onLiveChange = vi.fn();
    render(<SessionHeader {...baseProps({ splitMode: 'vertical', live: false, onLiveChange })} />);
    fireEvent.click(screen.getByTestId('live-toggle'));
    expect(onLiveChange).toHaveBeenCalledWith(true);
  });
});
