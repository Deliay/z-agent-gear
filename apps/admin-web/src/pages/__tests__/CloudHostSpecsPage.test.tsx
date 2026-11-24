import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CloudHostSpecsPage from '@/pages/CloudHostSpecsPage';

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
    if (source.includes('AdminCreateCloudSpec')) return [mocks.create, { loading: false }];
    if (source.includes('AdminUpdateCloudSpec')) return [mocks.update, { loading: false }];
    if (source.includes('AdminDeleteCloudSpec')) return [mocks.remove, { loading: false }];
    return [vi.fn(), { loading: false }];
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: mocks.toastError, warning: vi.fn() },
}));

function spec(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    name: '8C 16G 20G',
    cpu: 8,
    memoryGi: 16,
    ephemeralStorageGi: 20,
    unlimited: false,
    whitelistEnabled: false,
    allowedTenantIds: [],
    isPreset: false,
    presetKey: null,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-02T00:00:00Z',
    ...overrides,
  };
}

function tenant(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    name: '团队A',
    type: 'team',
    memberCount: 2,
    balance: 0,
    createdAt: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

function setup({
  specs = [spec()],
  tenants = [tenant(), tenant({ id: 't2', name: '团队B' })],
}: { specs?: unknown[]; tenants?: unknown[] } = {}) {
  mocks.useQuery.mockImplementation((doc: unknown) => {
    const source = String(doc);
    if (source.includes('AdminTenants')) {
      return {
        data: { adminTenants: tenants },
        loading: false,
        error: undefined,
        refetch: vi.fn(),
      };
    }
    return {
      data: { adminCloudSpecs: specs },
      loading: false,
      error: undefined,
      refetch: mocks.refetch,
    };
  });
}

const whitelistToggle = () => screen.getByRole('checkbox', { name: '开启白名单' });

describe('CloudHostSpecsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-SPWEB1: lists name, resources, whitelist state, visible tenant count and preset badge', () => {
    setup({
      specs: [
        spec({ whitelistEnabled: true, allowedTenantIds: ['t1', 't2'] }),
        spec({
          id: 's2',
          name: 'unlimited-0c0g',
          cpu: 0,
          memoryGi: 0,
          ephemeralStorageGi: 0,
          unlimited: true,
          whitelistEnabled: true,
          allowedTenantIds: [],
          isPreset: true,
          presetKey: 'unlimited-0c0g',
        }),
      ],
    });
    render(<CloudHostSpecsPage />);

    expect(screen.getByRole('heading', { name: '容器规格' })).toBeDefined();
    expect(screen.getByText('8C 16G 20G')).toBeDefined();
    expect(screen.getByText('可见租户 2')).toBeDefined();
    // 「预制」列头 + 预制规格行徽标
    expect(screen.getAllByText('预制').length).toBe(2);
    // 不限制规格：三项资源列与名称旁徽标均展示「不限制」
    expect(screen.getAllByText('不限制').length).toBe(4);
    expect(screen.getByRole('button', { name: '新建规格' })).toBeDefined();
  });

  it('T-SPWEB1: shows empty state when there are no specs', () => {
    setup({ specs: [] });
    render(<CloudHostSpecsPage />);

    expect(screen.getByText('暂无容器规格')).toBeDefined();
  });

  it('T-SPWEB2: new spec defaults to all-zero resources with whitelist enabled', () => {
    setup();
    render(<CloudHostSpecsPage />);

    fireEvent.click(screen.getByRole('button', { name: '新建规格' }));

    expect(whitelistToggle()).toBeChecked();
    expect(screen.getByLabelText('搜索租户')).toBeDefined();
    expect((screen.getByLabelText('CPU（核）') as HTMLInputElement).value).toBe('0');
    expect((screen.getByLabelText('内存（GiB）') as HTMLInputElement).value).toBe('0');
    expect((screen.getByLabelText('临时存储（GiB）') as HTMLInputElement).value).toBe('0');
  });

  it('T-SPWEB2: hides the tenant picker when whitelist is unchecked', () => {
    setup();
    render(<CloudHostSpecsPage />);

    fireEvent.click(screen.getByRole('button', { name: '新建规格' }));
    expect(screen.getByLabelText('搜索租户')).toBeDefined();

    fireEvent.click(whitelistToggle());
    expect(whitelistToggle()).not.toBeChecked();
    expect(screen.queryByLabelText('搜索租户')).toBeNull();
  });

  it('T-SPWEB3: blocks save and shows an inline error for mixed zero resources', () => {
    setup();
    render(<CloudHostSpecsPage />);

    fireEvent.click(screen.getByRole('button', { name: '新建规格' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '4C 0G 20G' } });
    fireEvent.change(screen.getByLabelText('CPU（核）'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('内存（GiB）'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('临时存储（GiB）'), { target: { value: '20' } });

    expect(screen.getByText('除「全 0（不限制）」外，三项都必须大于 0')).toBeDefined();
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('内存（GiB）'), { target: { value: '8' } });
    expect(screen.queryByText('除「全 0（不限制）」外，三项都必须大于 0')).toBeNull();
    expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled();
  });

  it('T-SPWEB3: rejects non-integers, over-limit values and an empty name', () => {
    setup();
    render(<CloudHostSpecsPage />);

    fireEvent.click(screen.getByRole('button', { name: '新建规格' }));
    const save = screen.getByRole('button', { name: '保存' });

    // 名称为空 + 全零（不限制）本身合法
    expect(screen.getByText('名称必填')).toBeDefined();
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'over-limit' } });
    fireEvent.change(screen.getByLabelText('CPU（核）'), { target: { value: '1.5' } });
    fireEvent.change(screen.getByLabelText('内存（GiB）'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('临时存储（GiB）'), { target: { value: '20' } });
    expect(screen.getByText('CPU、内存、临时存储必须为非负整数')).toBeDefined();
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('CPU（核）'), { target: { value: '65' } });
    expect(screen.getByText('CPU 不可超过 64')).toBeDefined();
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('CPU（核）'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('内存（GiB）'), { target: { value: '257' } });
    expect(screen.getByText('内存不可超过 256 GiB')).toBeDefined();

    fireEvent.change(screen.getByLabelText('内存（GiB）'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('临时存储（GiB）'), { target: { value: '513' } });
    expect(screen.getByText('临时存储不可超过 512 GiB')).toBeDefined();
    expect(save).toBeDisabled();
  });

  it('T-SPWEB4: creates a spec with trimmed name and selected whitelist tenants', async () => {
    setup();
    mocks.create.mockResolvedValue({});
    render(<CloudHostSpecsPage />);

    fireEvent.click(screen.getByRole('button', { name: '新建规格' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '  4C 8G 20G  ' } });
    fireEvent.change(screen.getByLabelText('CPU（核）'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('内存（GiB）'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('临时存储（GiB）'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '团队A' }));

    expect(screen.getByLabelText('移除租户 团队A')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: {
            input: {
              name: '4C 8G 20G',
              cpu: 4,
              memoryGi: 8,
              ephemeralStorageGi: 20,
              whitelistEnabled: true,
              allowedTenantIds: ['t1'],
            },
          },
        }),
      ),
    );
    expect(mocks.create.mock.calls[0][0].refetchQueries).toBeDefined();
  });

  it('T-SPWEB4: submits an empty whitelist when whitelist is unchecked', async () => {
    setup();
    mocks.create.mockResolvedValue({});
    render(<CloudHostSpecsPage />);

    fireEvent.click(screen.getByRole('button', { name: '新建规格' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '2C 4G 10G' } });
    fireEvent.change(screen.getByLabelText('CPU（核）'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('内存（GiB）'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('临时存储（GiB）'), { target: { value: '10' } });
    fireEvent.click(whitelistToggle());

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: {
            input: {
              name: '2C 4G 10G',
              cpu: 2,
              memoryGi: 4,
              ephemeralStorageGi: 10,
              whitelistEnabled: false,
              allowedTenantIds: [],
            },
          },
        }),
      ),
    );
  });

  it('T-SPWEB5: edits an existing spec with values backfilled and submits its id', async () => {
    setup({
      specs: [spec({ whitelistEnabled: true, allowedTenantIds: ['t1'] })],
    });
    mocks.update.mockResolvedValue({});
    render(<CloudHostSpecsPage />);

    fireEvent.click(screen.getByRole('button', { name: '编辑 8C 16G 20G' }));

    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('8C 16G 20G');
    expect((screen.getByLabelText('CPU（核）') as HTMLInputElement).value).toBe('8');
    expect(whitelistToggle()).toBeChecked();

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '8C 16G 20G v2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: {
            id: 's1',
            input: {
              name: '8C 16G 20G v2',
              cpu: 8,
              memoryGi: 16,
              ephemeralStorageGi: 20,
              whitelistEnabled: true,
              allowedTenantIds: ['t1'],
            },
          },
        }),
      ),
    );
  });

  it('T-SPWEB6: maps server validation errors into the inline error block', async () => {
    setup();
    mocks.create.mockRejectedValue(new Error('spec name already exists'));
    render(<CloudHostSpecsPage />);

    fireEvent.click(screen.getByRole('button', { name: '新建规格' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'dup' } });
    fireEvent.change(screen.getByLabelText('CPU（核）'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('内存（GiB）'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('临时存储（GiB）'), { target: { value: '5' } });
    fireEvent.click(whitelistToggle());
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('规格名称已存在'),
    );
  });

  it('T-SPWEB7: delete asks for confirmation and triggers the mutation', async () => {
    setup();
    mocks.remove.mockResolvedValue({});
    render(<CloudHostSpecsPage />);

    fireEvent.click(screen.getByRole('button', { name: '删除 8C 16G 20G' }));
    expect(screen.getByText('删除容器规格')).toBeDefined();
    expect(mocks.remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() =>
      expect(mocks.remove).toHaveBeenCalledWith(
        expect.objectContaining({ variables: { id: 's1' } }),
      ),
    );
  });
});
