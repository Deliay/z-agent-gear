import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CloudWorkloadsPage from '@/pages/CloudWorkloadsPage';

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  refetch: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@apollo/client', () => ({
  gql: (strings: TemplateStringsArray) => strings.join(''),
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
  useMutation: (doc: unknown) => {
    const source = String(doc);
    if (source.includes('AdminCreateCloudWorkload')) return [mocks.create, { loading: false }];
    if (source.includes('AdminUpdateCloudWorkload')) return [mocks.update, { loading: false }];
    if (source.includes('AdminDeleteCloudWorkload')) return [mocks.remove, { loading: false }];
    return [vi.fn(), { loading: false }];
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: mocks.toastError, warning: vi.fn() },
}));

function workload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'w1',
    name: 'setup-node',
    initScript: 'git clone repo && npm install',
    postScript: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    ...overrides,
  };
}

function setupWorkloads(workloads: unknown[]) {
  mocks.useQuery.mockReturnValue({
    data: { adminCloudWorkloads: workloads },
    loading: false,
    error: undefined,
    refetch: mocks.refetch,
  });
}

describe('CloudWorkloadsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-FW1: shows empty state with create guidance', () => {
    setupWorkloads([]);
    render(<CloudWorkloadsPage />);

    expect(screen.getByText('暂无工作负载')).toBeDefined();
    expect(screen.getByRole('button', { name: '新建工作负载' })).toBeDefined();
  });

  it('T-FW1: lists name, script summary and updated time', () => {
    setupWorkloads([workload()]);
    render(<CloudWorkloadsPage />);

    expect(screen.getByText('setup-node')).toBeDefined();
    expect(screen.getByText('git clone repo && npm install')).toBeDefined();
    expect(screen.getByText('初始化脚本')).toBeDefined();
    expect(screen.getByText('更新时间')).toBeDefined();
  });

  it('T-FW1: renders an error state with retry instead of the empty state', () => {
    mocks.useQuery.mockReturnValue({
      data: undefined,
      loading: false,
      error: new Error('cloudWorkloads boom'),
      refetch: mocks.refetch,
    });
    render(<CloudWorkloadsPage />);

    expect(screen.getByRole('alert').textContent).toContain('cloudWorkloads boom');
    expect(screen.queryByText('暂无工作负载')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it('T-FW1: keeps loaded data and toasts when a refresh fails', () => {
    mocks.useQuery.mockReturnValue({
      data: { adminCloudWorkloads: [workload()] },
      loading: false,
      error: new Error('refresh boom'),
      refetch: mocks.refetch,
    });
    render(<CloudWorkloadsPage />);

    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining('refresh boom'));
    expect(screen.getByText('setup-node')).toBeDefined();
  });

  it('T-FW2: creates a workload through the dialog with correct variables', async () => {
    setupWorkloads([]);
    mocks.create.mockResolvedValue({});
    render(<CloudWorkloadsPage />);

    fireEvent.click(screen.getByRole('button', { name: '新建工作负载' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'init-env' } });
    fireEvent.change(screen.getByLabelText('初始化脚本'), { target: { value: 'echo init' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: {
            input: { name: 'init-env', initScript: 'echo init', postScript: null },
          },
        }),
      ),
    );
  });

  it('T-FW2: blocks save when name is empty or both scripts are empty', () => {
    setupWorkloads([]);
    render(<CloudWorkloadsPage />);

    fireEvent.click(screen.getByRole('button', { name: '新建工作负载' }));
    const save = screen.getByRole('button', { name: '保存' });

    // 名称空 + 双空脚本
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'only-name' } });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('清理脚本'), { target: { value: ' ' } });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('初始化脚本'), { target: { value: 'echo ok' } });
    expect(save).not.toBeDisabled();
  });

  it('T-FW2: edits an existing workload and submits its id', async () => {
    setupWorkloads([workload()]);
    mocks.update.mockResolvedValue({});
    render(<CloudWorkloadsPage />);

    fireEvent.click(screen.getByRole('button', { name: '编辑 setup-node' }));
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('setup-node');

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'setup-node-v2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: {
            id: 'w1',
            input: {
              name: 'setup-node-v2',
              initScript: 'git clone repo && npm install',
              postScript: null,
            },
          },
        }),
      ),
    );
  });

  it('T-FW2: surfaces a duplicate-name save error', async () => {
    setupWorkloads([]);
    mocks.create.mockRejectedValue(new Error('Workload name already exists'));
    render(<CloudWorkloadsPage />);

    fireEvent.click(screen.getByRole('button', { name: '新建工作负载' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'dup' } });
    fireEvent.change(screen.getByLabelText('初始化脚本'), { target: { value: 'echo ok' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Workload name already exists'),
    );
  });

  it('T-FW3: delete asks for confirmation and can be cancelled', () => {
    setupWorkloads([workload()]);
    render(<CloudWorkloadsPage />);

    fireEvent.click(screen.getByRole('button', { name: '删除 setup-node' }));
    expect(screen.getByText('删除工作负载')).toBeDefined();
    expect(screen.getByText('确定要删除工作负载「setup-node」吗？此操作不可撤销。')).toBeDefined();
    expect(mocks.remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('T-FW3: delete confirmation triggers the mutation', async () => {
    setupWorkloads([workload()]);
    mocks.remove.mockResolvedValue({});
    render(<CloudWorkloadsPage />);

    fireEvent.click(screen.getByRole('button', { name: '删除 setup-node' }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() =>
      expect(mocks.remove).toHaveBeenCalledWith(
        expect.objectContaining({ variables: { id: 'w1' } }),
      ),
    );
  });
});
