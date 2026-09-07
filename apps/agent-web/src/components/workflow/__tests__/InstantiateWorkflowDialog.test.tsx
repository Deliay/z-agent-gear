import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import InstantiateWorkflowDialog from '../InstantiateWorkflowDialog';

// Mock Apollo Client
const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => [mockUseMutation],
}));

// Mock React Router
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

// Mock sonner
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Mock WorkflowGraphEditor
vi.mock('../WorkflowGraphEditor', () => ({
  default: () => <div data-testid="workflow-graph-editor" />,
}));

describe('InstantiateWorkflowDialog 工作区 Select', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('工作区下拉框存在', () => {
    mockUseQuery.mockImplementation(() => ({
      data: undefined,
    }));

    render(
      <InstantiateWorkflowDialog
        open={true}
        onOpenChange={vi.fn()}
        controllerId="ctrl-1"
        workspaceId="ws-1"
      />
    );

    // 检查工作区标签存在
    expect(screen.getByText('工作区')).toBeInTheDocument();
  });
});