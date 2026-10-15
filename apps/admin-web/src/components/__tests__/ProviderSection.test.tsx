import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import ProviderSection from '../providers/ProviderSection';

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  mutate: vi.fn(),
  refetch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock('@apollo/client', () => ({
  gql: (strings: TemplateStringsArray) => strings.join(''),
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
  useMutation: (...args: unknown[]) => mocks.useMutation(...args),
}));

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    warning: mocks.toastWarning,
  },
}));

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    name: 'My OpenAI',
    type: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    credentialType: 'api_key',
    credentialValue: 'sk-1234567890abcdef',
    isEnabled: true,
    scope: 'global',
    models: [{ id: 'm1', providerId: 'p1', name: 'gpt-4o', isCustom: false, isEnabled: true, sortOrder: 0, scope: 'global' }],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function setup(providers: unknown[] = [provider()], extra: Record<string, unknown> = {}) {
  mocks.useQuery.mockReturnValue({
    data: { adminProviders: providers },
    loading: false,
    error: undefined,
    refetch: mocks.refetch,
    ...extra,
  });
}

describe('ProviderSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useMutation.mockReturnValue([mocks.mutate, { loading: false }]);
  });

  it('T-W5: shows empty state with add guidance', () => {
    setup([]);
    render(<ProviderSection />);
    expect(screen.getByText('暂无供应商，点击「添加供应商」开始配置')).toBeDefined();
  });

  it('T-W5: keeps the list (not loading) when refetching with data', () => {
    setup([provider()], { loading: true });
    render(<ProviderSection />);
    expect(screen.getByText('My OpenAI')).toBeDefined();
    expect(screen.queryByText('加载中...')).toBeNull();
  });

  it('T-W1: masks the credential (first 3 / last 4)', () => {
    setup();
    render(<ProviderSection />);
    expect(screen.getByText('sk-****cdef')).toBeDefined();
    expect(screen.queryByText('sk-1234567890abcdef')).toBeNull();
  });

  it('T-W1: shows the batch action bar after selecting a provider', () => {
    setup();
    render(<ProviderSection />);
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 My OpenAI' }));
    expect(screen.getByText('已选 1 项')).toBeDefined();
  });

  it('T-W1: render a real error state with retry instead of the empty state', () => {
    mocks.useQuery.mockReturnValue({
      data: undefined,
      loading: false,
      error: new Error('adminProviders boom'),
      refetch: mocks.refetch,
    });
    render(<ProviderSection />);

    expect(screen.getByRole('alert').textContent).toContain('adminProviders boom');
    expect(screen.queryByText('暂无供应商，点击「添加供应商」开始配置')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it('T-W1: delete uses the custom confirm dialog before mutating', async () => {
    setup();
    mocks.mutate.mockResolvedValue({});
    render(<ProviderSection />);

    fireEvent.click(screen.getByRole('button', { name: '操作菜单' }));
    fireEvent.click(screen.getByText('删除'));

    // 自定义对话框（非 window.confirm）出现，尚未发请求
    expect(screen.getByText('删除供应商')).toBeDefined();
    expect(mocks.mutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ variables: { id: 'p1' } }),
      ),
    );
  });

  it('T-W1: does not mutate when the delete dialog is cancelled', () => {
    setup();
    render(<ProviderSection />);

    fireEvent.click(screen.getByRole('button', { name: '操作菜单' }));
    fireEvent.click(screen.getByText('删除'));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('T-W1: batch enable disables buttons while in flight and toasts successCount', async () => {
    setup([
      provider(),
      provider({ id: 'p2', name: 'Second' }),
    ]);
    let resolveMutate: (value: unknown) => void = () => {};
    mocks.mutate.mockImplementation(
      () => new Promise((resolve) => {
        resolveMutate = resolve;
      }),
    );

    render(<ProviderSection />);
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 My OpenAI' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 Second' }));
    fireEvent.click(screen.getByRole('button', { name: '启用' }));

    // in-flight：批量按钮全部禁用，防止双击连发
    expect(screen.getByRole('button', { name: '启用' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '禁用' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除' })).toBeDisabled();
    expect(mocks.mutate).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveMutate({ data: { batchEnableGlobalProviders: { successCount: 2 } } });
    });

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringContaining('2')),
    );
  });

  it('T-W1: batch enable surfaces a partial failure when successCount < requested', async () => {
    setup([
      provider(),
      provider({ id: 'p2', name: 'Second' }),
    ]);
    mocks.mutate.mockResolvedValue({
      data: { batchEnableGlobalProviders: { successCount: 1 } },
    });

    render(<ProviderSection />);
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 My OpenAI' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 Second' }));
    fireEvent.click(screen.getByRole('button', { name: '启用' }));

    await waitFor(() =>
      expect(mocks.toastWarning).toHaveBeenCalledWith(expect.stringContaining('1/2')),
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('T-W1: batch delete confirms in the custom dialog before mutating', async () => {
    setup([
      provider(),
      provider({ id: 'p2', name: 'Second' }),
    ]);
    mocks.mutate.mockResolvedValue({
      data: { batchDeleteGlobalProviders: { successCount: 2 } },
    });

    render(<ProviderSection />);
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 My OpenAI' }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    expect(screen.getByText('批量删除供应商')).toBeDefined();
    expect(mocks.mutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ variables: { ids: ['p1'] } }),
      ),
    );
  });
});
