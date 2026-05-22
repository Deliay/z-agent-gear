import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import HarnessToolsSection from '../HarnessToolsSection';

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}));

function mockQuery(overrides: Record<string, unknown> = {}) {
  return {
    data: null,
    loading: false,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  };
}

describe('HarnessToolsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMutation.mockReturnValue([vi.fn(), { loading: false }]);
  });

  const defaultProps = { controllerId: 'ctrl-1' };

  it('should show loading state', () => {
    mockUseQuery.mockReturnValue(mockQuery({ loading: true }));

    render(<HarnessToolsSection {...defaultProps} />);

    expect(screen.getByText('加载中...')).toBeDefined();
  });

  it('should show empty state when no capabilities', () => {
    mockUseQuery.mockReturnValue(mockQuery({ data: { acpCapabilities: [] } }));

    render(<HarnessToolsSection {...defaultProps} />);

    expect(screen.getByText('当前控制器未检测到可用工具')).toBeDefined();
  });

  it('should display capabilities list', () => {
    mockUseQuery.mockReturnValue(mockQuery({
      data: {
        acpCapabilities: [
          { type: 'opencode', available: true, version: '1.0.0', checkedAt: '2026-01-01T00:00:00Z' },
        ],
      },
    }));

    render(<HarnessToolsSection {...defaultProps} />);

    expect(screen.getByText('opencode')).toBeDefined();
    expect(screen.getByText('可用')).toBeDefined();
    expect(screen.getByText('v1.0.0')).toBeDefined();
  });

  it('should display unavailable status', () => {
    mockUseQuery.mockReturnValue(mockQuery({
      data: {
        acpCapabilities: [
          { type: 'opencode', available: false, version: null, checkedAt: null },
        ],
      },
    }));

    render(<HarnessToolsSection {...defaultProps} />);

    expect(screen.getByText('不可用')).toBeDefined();
  });

  it('should display checkedAt timestamp', () => {
    mockUseQuery.mockReturnValue(mockQuery({
      data: {
        acpCapabilities: [
          { type: 'opencode', available: true, version: '1.0.0', checkedAt: '2026-05-22T10:30:00Z' },
        ],
      },
    }));

    render(<HarnessToolsSection {...defaultProps} />);

    expect(screen.getByText(/上次检测/)).toBeDefined();
  });

  it('should not display checkedAt when null', () => {
    mockUseQuery.mockReturnValue(mockQuery({
      data: {
        acpCapabilities: [
          { type: 'opencode', available: true, version: '1.0.0', checkedAt: null },
        ],
      },
    }));

    render(<HarnessToolsSection {...defaultProps} />);

    expect(screen.queryByText(/上次检测/)).toBeNull();
  });

  it('should call refresh mutation on button click', async () => {
    const refetch = vi.fn();
    const refreshMutate = vi.fn().mockResolvedValue({ data: { refreshAcpCapabilities: [] } });
    mockUseQuery.mockReturnValue(mockQuery({
      data: { acpCapabilities: [] },
      refetch,
    }));
    mockUseMutation.mockReturnValue([refreshMutate, { loading: false }]);

    render(<HarnessToolsSection {...defaultProps} />);

    fireEvent.click(screen.getByText('刷新'));

    expect(refreshMutate).toHaveBeenCalledWith({ variables: { controllerId: 'ctrl-1' } });
  });

  it('should show refreshing text while mutating', () => {
    mockUseQuery.mockReturnValue(mockQuery({ data: { acpCapabilities: [] } }));
    mockUseMutation.mockReturnValue([vi.fn(), { data: null, loading: true }]);

    render(<HarnessToolsSection {...defaultProps} />);

    expect(screen.getByText('刷新中...')).toBeDefined();
  });
});
