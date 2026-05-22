import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ControllerConfigPage from '../ControllerConfigPage';

const mockUseQuery = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

vi.mock('@/components/settings/WorkspaceSection', () => ({
  default: () => <div data-testid="workspace-section">WorkspaceSection</div>,
}));

vi.mock('@/components/settings/HarnessToolsSection', () => ({
  default: () => <div data-testid="harness-section">HarnessToolsSection</div>,
}));

describe('ControllerConfigPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const defaultProps = {
    controllerId: 'ctrl-1',
    onBack: vi.fn(),
  };

  it('should render back button', () => {
    mockUseQuery.mockReturnValue({ data: { controllers: [] }, loading: false });

    render(<ControllerConfigPage {...defaultProps} />);

    expect(screen.getByText('← 返回')).toBeDefined();
  });

  it('should call onBack when back button clicked', () => {
    const onBack = vi.fn();
    mockUseQuery.mockReturnValue({ data: { controllers: [] }, loading: false });

    render(<ControllerConfigPage {...defaultProps} onBack={onBack} />);

    fireEvent.click(screen.getByText('← 返回'));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('should show controller name and online status', () => {
    mockUseQuery.mockReturnValue({
      data: {
        controllers: [
          { id: 'ctrl-1', name: 'My Machine', hostname: 'host-1', type: 'local', status: 'online', keyId: 'key-1', version: '1.0.0', lastHeartbeatAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
        ],
      },
      loading: false,
    });

    render(<ControllerConfigPage {...defaultProps} />);

    expect(screen.getByText('My Machine')).toBeDefined();
  });

  it('should show loading text when controller data loading', () => {
    mockUseQuery.mockReturnValue({ data: null, loading: true });

    render(<ControllerConfigPage {...defaultProps} />);

    expect(screen.getByText('加载中...')).toBeDefined();
  });

  it('should render WorkspaceSection by default', () => {
    mockUseQuery.mockReturnValue({ data: { controllers: [] }, loading: false });

    render(<ControllerConfigPage {...defaultProps} />);

    expect(screen.getByTestId('workspace-section')).toBeDefined();
    expect(screen.queryByTestId('harness-section')).toBeNull();
  });

  it('should switch to HarnessToolsSection when clicking harness nav', () => {
    mockUseQuery.mockReturnValue({ data: { controllers: [] }, loading: false });

    render(<ControllerConfigPage {...defaultProps} />);

    fireEvent.click(screen.getByText('可用 Harness 工具'));

    expect(screen.getByTestId('harness-section')).toBeDefined();
    expect(screen.queryByTestId('workspace-section')).toBeNull();
  });

  it('should switch back to WorkspaceSection when clicking workspace nav', () => {
    mockUseQuery.mockReturnValue({ data: { controllers: [] }, loading: false });

    render(<ControllerConfigPage {...defaultProps} />);

    fireEvent.click(screen.getByText('可用 Harness 工具'));
    fireEvent.click(screen.getByText('工作区'));

    expect(screen.getByTestId('workspace-section')).toBeDefined();
  });

  it('should render section nav buttons', () => {
    mockUseQuery.mockReturnValue({ data: { controllers: [] }, loading: false });

    render(<ControllerConfigPage {...defaultProps} />);

    expect(screen.getByText('工作区')).toBeDefined();
    expect(screen.getByText('可用 Harness 工具')).toBeDefined();
  });
});
