import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CREATE_WORKSPACE } from '../../../graphql/mutations';

const h = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  createWorkspace: vi.fn(),
  noop: vi.fn(),
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => h.useQuery(...args),
  useMutation: (...args: unknown[]) => h.useMutation(...args),
}));

vi.mock('../AddWorkspaceDialog', () => ({
  default: ({ open, onSelect }: { open: boolean; onSelect: (path: string) => void }) =>
    open ? (
      <button type="button" onClick={() => onSelect('/home/worker/new-project')}>
        mock-select-dir
      </button>
    ) : null,
}));

import WorkspaceSection from '../WorkspaceSection';

function setup() {
  const refetch = vi.fn().mockResolvedValue({ data: { controllerWorkspaces: [] } });
  h.useQuery.mockReturnValue({
    data: { controllerWorkspaces: [], acpCapabilities: [] },
    loading: false,
    refetch,
  });
  h.useMutation.mockImplementation((doc: unknown) => {
    if (doc === CREATE_WORKSPACE) return [h.createWorkspace];
    return [h.noop];
  });
  h.createWorkspace.mockResolvedValue({ data: { createWorkspace: { id: 'ws-new' } } });
  return { refetch };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('WorkspaceSection onWorkspaceCreated（T-RW-WEB5）', () => {
  it('新增工作目录成功且 refetch 完成后回调工作区 id', async () => {
    setup();
    const onWorkspaceCreated = vi.fn();

    render(<WorkspaceSection controllerId="ctrl-1" onWorkspaceCreated={onWorkspaceCreated} />);

    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.click(screen.getByRole('button', { name: 'mock-select-dir' }));

    await waitFor(() => {
      expect(h.createWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: { input: { controllerId: 'ctrl-1', path: '/home/worker/new-project' } },
        }),
      );
    });
    await waitFor(() => {
      expect(onWorkspaceCreated).toHaveBeenCalledWith({ id: 'ws-new' });
    });
  });

  it('未传 onWorkspaceCreated 时新增流程零行为变化（不抛错）', async () => {
    setup();

    render(<WorkspaceSection controllerId="ctrl-1" />);

    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    fireEvent.click(screen.getByRole('button', { name: 'mock-select-dir' }));

    await waitFor(() => {
      expect(h.createWorkspace).toHaveBeenCalled();
    });
  });
});
