import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  useQuery: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: () => h.useQuery(),
  useMutation: () => [h.remove],
}));

import CloudHostIssuesLinkageSection from '../CloudHostIssuesLinkageSection';

const linkages = [
  {
    id: 'link-1',
    controllerId: 'ctrl-1',
    configuredWorkflowId: 'wf-1',
    configuredWorkflowName: '开发流程',
    labelName: 'start-开发',
    repoFullNames: ['a/b', 'c/d'],
    createdAt: '',
    updatedAt: '',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.useQuery.mockReturnValue({
    data: { cloudHostIssuesLinkages: linkages },
    loading: false,
    error: undefined,
    refetch: vi.fn(),
  });
  h.remove.mockResolvedValue({ data: { deleteCloudHostIssuesLinkage: true } });
});

describe('CloudHostIssuesLinkageSection', () => {
  it('展示工作流名、标签与仓库 chips', () => {
    render(<CloudHostIssuesLinkageSection controllerId="ctrl-1" />);
    expect(screen.getByText('开发流程')).toBeInTheDocument();
    expect(screen.getByText('start-开发')).toBeInTheDocument();
    expect(screen.getByText('a/b')).toBeInTheDocument();
    expect(screen.getByText('c/d')).toBeInTheDocument();
  });

  it('删除需二次确认后调用 mutation', async () => {
    render(<CloudHostIssuesLinkageSection controllerId="ctrl-1" />);
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(screen.getByText(/确认删除？/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '确认删除 start-开发' }));
    await waitFor(() => {
      expect(h.remove).toHaveBeenCalledWith({ variables: { id: 'link-1' } });
    });
  });

  it('空列表展示引导文案', () => {
    h.useQuery.mockReturnValue({
      data: { cloudHostIssuesLinkages: [] },
      loading: false,
      refetch: vi.fn(),
    });
    render(<CloudHostIssuesLinkageSection controllerId="ctrl-1" />);
    expect(screen.getByText('暂无 Issue 联动配置。')).toBeInTheDocument();
  });
});
