import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import QuickCreatePanel from '../QuickCreatePanel';

const mockSubmitCreateSession = vi.fn();
const mockToastError = vi.fn();

const homeState = {
  data: {
    controllers: [
      { id: 'ctrl-1', name: '控制器一', status: 'online' },
      { id: 'ctrl-2', name: '控制器二', status: 'offline' },
    ],
  },
};

vi.mock('../../../stores/homeOverview', () => ({
  useHomeOverview: () => homeState,
}));

vi.mock('../../../hooks/useCreateSession', () => ({
  useCreateSession: () => mockSubmitCreateSession,
}));

vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}));

vi.mock('../../session/NewSessionDialog', () => ({
  default: (props: { controllers: unknown[]; onCreate: unknown }) => (
    <div data-testid="mock-new-session-dialog" data-controllers={props.controllers.length} />
  ),
}));

vi.mock('../../workflow/InstantiateWorkflowDialog', () => ({
  default: (props: { controllerId: string }) => (
    <div data-testid="mock-instantiate-dialog" data-controller={props.controllerId} />
  ),
}));

vi.mock('../../ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

describe('QuickCreatePanel ⌘K 快速新建（D6）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    homeState.data.controllers = [
      { id: 'ctrl-1', name: '控制器一', status: 'online' },
      { id: 'ctrl-2', name: '控制器二', status: 'offline' },
    ];
  });

  it('T-QCP1: ⌘K / Ctrl+K 唤起面板、Esc/再次快捷键关闭且焦点落在第一项', () => {
    render(<QuickCreatePanel />);
    expect(screen.queryByTestId('quick-create-panel')).toBeNull();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.getByTestId('quick-create-panel')).toBeInTheDocument();
    expect(screen.getByTestId('quick-create-session')).toHaveFocus();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.queryByTestId('quick-create-panel')).toBeNull();
  });

  it('T-QCP2: 两个条目分别打开既有 NewSessionDialog / InstantiateWorkflowDialog（零新增查询）', () => {
    render(<QuickCreatePanel />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });

    fireEvent.click(screen.getByTestId('quick-create-session'));
    expect(screen.getByTestId('mock-new-session-dialog')).toHaveAttribute('data-controllers', '2');
    expect(screen.queryByTestId('quick-create-panel')).toBeNull();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.click(screen.getByTestId('quick-create-workflow'));
    expect(screen.getByTestId('mock-instantiate-dialog')).toHaveAttribute('data-controller', 'ctrl-1');
  });

  it('T-QCP3: 键盘 ↑↓ 选择 + Enter 确认', () => {
    render(<QuickCreatePanel />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });

    const listbox = screen.getByRole('listbox', { name: '快速新建操作' });
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(screen.getByTestId('quick-create-workflow')).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(listbox, { key: 'Enter' });
    expect(screen.getByTestId('mock-instantiate-dialog')).toBeInTheDocument();
  });

  it('T-QCP4: 无可用控制器时提示且不打开工作流对话框', () => {
    homeState.data.controllers = [];
    render(<QuickCreatePanel />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.click(screen.getByTestId('quick-create-workflow'));

    expect(mockToastError).toHaveBeenCalled();
    expect(screen.queryByTestId('mock-instantiate-dialog')).toBeNull();
  });
});
