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

  it('选中工作区后触发器显示名称', () => {
    // 所有查询都返回包含工作区数据的响应
    mockUseQuery.mockReturnValue({
      data: {
        workspaces: [
          { id: 'ws-1', controllerId: 'ctrl-1', name: '研发工作区', path: '/home/user/dev', isEnabled: true, isGitRepo: false, createdAt: '', updatedAt: '' },
        ],
        configuredWorkflows: [],
        workflowTemplates: [],
        acpCapabilities: [],
      },
    });

    render(
      <InstantiateWorkflowDialog
        open={true}
        onOpenChange={vi.fn()}
        controllerId="ctrl-1"
        workspaceId="ws-1"
      />
    );

    // 检查 SelectValue 触发器中显示工作区名称
    const trigger = screen.getByRole('combobox');
    expect(trigger).toBeInTheDocument();
    expect(trigger.textContent).toContain('研发工作区');
  });
});