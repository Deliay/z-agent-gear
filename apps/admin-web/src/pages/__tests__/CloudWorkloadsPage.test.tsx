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
    paramSchema: [],
    dependsOnWorkloadIds: [],
    isPreset: false,
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
            input: {
              name: 'init-env',
              initScript: 'echo init',
              postScript: null,
              paramSchema: [],
              dependsOnWorkloadIds: [],
            },
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

  it('T-FW2: blocks save when name exceeds 64 chars or a script exceeds 16 KiB', () => {
    setupWorkloads([]);
    render(<CloudWorkloadsPage />);

    fireEvent.click(screen.getByRole('button', { name: '新建工作负载' }));
    const save = screen.getByRole('button', { name: '保存' });

    // 名称超长（65 字符）
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'n'.repeat(65) } });
    fireEvent.change(screen.getByLabelText('初始化脚本'), { target: { value: 'echo ok' } });
    expect(save).toBeDisabled();
    expect(screen.getByText(/名称最多 64 个字符/)).toBeDefined();

    // 名称合法但脚本超过 16 KiB
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'ok-name' } });
    fireEvent.change(screen.getByLabelText('初始化脚本'), { target: { value: 'x'.repeat(16 * 1024 + 1) } });
    expect(save).toBeDisabled();
    expect(screen.getByText(/脚本超过 16 KiB 上限/)).toBeDefined();

    // 恰好 16 KiB 允许保存
    fireEvent.change(screen.getByLabelText('初始化脚本'), { target: { value: 'x'.repeat(16 * 1024) } });
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
              paramSchema: [],
              dependsOnWorkloadIds: [],
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

  it('T-FP8: shows the preset badge, param count and dependency names', () => {
    setupWorkloads([
      workload({
        id: 'w1',
        name: 'Aspire',
        isPreset: true,
        paramSchema: [
          { key: 'a', label: 'A', type: 'TEXT', options: [], defaultValue: '' },
          { key: 'b', label: 'B', type: 'BOOLEAN', options: [], defaultValue: false },
        ],
        dependsOnWorkloadIds: ['w2'],
      }),
      workload({ id: 'w2', name: 'Docker', initScript: null, postScript: 'echo clean' }),
    ]);
    render(<CloudWorkloadsPage />);

    expect(screen.getByText('预制')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
    // 依赖名称按 ID 映射列表：Aspire 行展示 Docker（名称列 + 依赖标签）
    expect(screen.getAllByText('Docker').length).toBeGreaterThanOrEqual(2);
    // 无参数/依赖的行展示「-」
    expect(screen.getAllByText('-').length).toBeGreaterThan(0);
  });

  it('T-FP4: dependency multi-select excludes self, preserves order and submits ids', async () => {
    setupWorkloads([
      workload({ id: 'w1', name: 'setup-node' }),
      workload({ id: 'w2', name: 'dep-a' }),
      workload({ id: 'w3', name: 'dep-b' }),
    ]);
    mocks.update.mockResolvedValue({});
    render(<CloudWorkloadsPage />);

    fireEvent.click(screen.getByRole('button', { name: '编辑 setup-node' }));
    // 排除自身
    expect(screen.queryByRole('checkbox', { name: 'setup-node' })).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: 'dep-b' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'dep-a' }));
    expect(screen.getByText(/dep-b → dep-a/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: expect.objectContaining({
            id: 'w1',
            input: expect.objectContaining({ dependsOnWorkloadIds: ['w3', 'w2'] }),
          }),
        }),
      ),
    );
  });

  it('T-FP4: blocks save and hints when a dependency cycle is introduced', () => {
    setupWorkloads([
      workload({ id: 'w1', name: 'A' }),
      workload({ id: 'w2', name: 'B', dependsOnWorkloadIds: ['w1'] }),
    ]);
    render(<CloudWorkloadsPage />);

    // 让 A 依赖 B，而 B 已依赖 A => 环
    fireEvent.click(screen.getByRole('button', { name: '编辑 A' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'B' }));

    expect(screen.getByText(/检测到依赖环/)).toBeDefined();
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });

  it('T-FP2: saves a configured param schema (normalized) with the workload', async () => {
    setupWorkloads([]);
    mocks.create.mockResolvedValue({});
    render(<CloudWorkloadsPage />);

    fireEvent.click(screen.getByRole('button', { name: '新建工作负载' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'with-params' } });
    fireEvent.change(screen.getByLabelText('初始化脚本'), { target: { value: 'echo ok' } });
    fireEvent.click(screen.getByRole('button', { name: /添加参数/ }));
    fireEvent.change(screen.getByLabelText('参数标识'), { target: { value: 'mode' } });
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '模式' } });
    fireEvent.change(screen.getByLabelText('字段类型'), { target: { value: 'SELECT' } });
    fireEvent.change(screen.getByLabelText('可选项'), { target: { value: 'dev\nprod' } });
    fireEvent.change(screen.getByLabelText('默认值'), { target: { value: 'dev' } });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: {
            input: {
              name: 'with-params',
              initScript: 'echo ok',
              postScript: null,
              paramSchema: [
                {
                  key: 'mode',
                  label: '模式',
                  type: 'SELECT',
                  options: ['dev', 'prod'],
                  defaultValue: 'dev',
                },
              ],
              dependsOnWorkloadIds: [],
            },
          },
        }),
      ),
    );
  });

  it('T-FP3: blocks save and locates param errors', () => {
    setupWorkloads([]);
    render(<CloudWorkloadsPage />);

    fireEvent.click(screen.getByRole('button', { name: '新建工作负载' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('初始化脚本'), { target: { value: 'echo' } });
    fireEvent.click(screen.getByRole('button', { name: /添加参数/ }));

    expect(screen.getByText('参数标识必填')).toBeDefined();
    expect(screen.getByText('显示名称必填')).toBeDefined();
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });
});
