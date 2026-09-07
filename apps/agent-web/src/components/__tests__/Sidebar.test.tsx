import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import Sidebar from '../Sidebar';

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => [mockUseMutation],
}));

vi.mock('react-router-dom', () => ({
  NavLink: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  useParams: () => ({}),
  useNavigate: () => vi.fn(),
}));

vi.mock('../session/NewSessionDialog', () => ({
  default: () => null,
}));

vi.mock('../workflow/InstantiateWorkflowDialog', () => ({
  default: () => null,
}));

vi.mock('../worktree/WorktreeSidebarGroup', () => ({
  default: () => null,
}));

vi.mock('../TodoListPanel', () => ({
  TodoListPanel: () => null,
}));

vi.mock('../ThemeToggle', () => ({
  default: () => null,
}));

vi.mock('../GatewaySection', () => ({
  default: () => null,
}));

describe('Sidebar 基本渲染', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('渲染用户名', () => {
    mockUseQuery.mockImplementation(() => ({
      data: undefined,
    }));

    render(<Sidebar username="testuser" />);

    expect(screen.getByText('testuser')).toBeDefined();
  });

  it('渲染新建会话按钮', () => {
    mockUseQuery.mockImplementation(() => ({
      data: undefined,
    }));

    render(<Sidebar username="testuser" />);

    expect(screen.getByTitle('新建会话')).toBeDefined();
  });

  it('渲染导航区域', () => {
    mockUseQuery.mockImplementation(() => ({
      data: undefined,
    }));

    render(<Sidebar username="testuser" />);

    expect(screen.getByRole('navigation')).toBeDefined();
  });
});