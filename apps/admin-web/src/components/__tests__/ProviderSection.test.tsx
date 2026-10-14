import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ProviderSection from '../providers/ProviderSection';

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock('@apollo/client', () => ({
  gql: (strings: TemplateStringsArray) => strings.join(''),
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
  useMutation: (...args: unknown[]) => mocks.useMutation(...args),
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

describe('ProviderSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useMutation.mockReturnValue([mocks.mutate, { loading: false }]);
  });

  it('T-W5: shows empty state with add guidance', () => {
    mocks.useQuery.mockReturnValue({ data: { adminProviders: [] }, loading: false });
    render(<ProviderSection />);
    expect(screen.getByText('暂无供应商，点击「添加供应商」开始配置')).toBeDefined();
  });

  it('T-W5: keeps the list (not loading) when refetching with data', () => {
    mocks.useQuery.mockReturnValue({ data: { adminProviders: [provider()] }, loading: true });
    render(<ProviderSection />);
    expect(screen.getByText('My OpenAI')).toBeDefined();
    expect(screen.queryByText('加载中...')).toBeNull();
  });

  it('T-W1: masks the credential (first 3 / last 4)', () => {
    mocks.useQuery.mockReturnValue({ data: { adminProviders: [provider()] }, loading: false });
    render(<ProviderSection />);
    expect(screen.getByText('sk-****cdef')).toBeDefined();
    expect(screen.queryByText('sk-1234567890abcdef')).toBeNull();
  });

  it('T-W1: shows the batch action bar after selecting a provider', () => {
    mocks.useQuery.mockReturnValue({ data: { adminProviders: [provider()] }, loading: false });
    render(<ProviderSection />);
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 My OpenAI' }));
    expect(screen.getByText('已选 1 项')).toBeDefined();
  });

  it('T-W1: delete confirms with a cascade warning before mutating', () => {
    mocks.useQuery.mockReturnValue({ data: { adminProviders: [provider()] }, loading: false });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ProviderSection />);

    fireEvent.click(screen.getByRole('button', { name: '操作菜单' }));
    fireEvent.click(screen.getByText('删除'));

    expect(confirmSpy).toHaveBeenCalledWith('确定要删除此供应商吗？关联的模型也将被删除。');
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { id: 'p1' } }),
    );
  });

  it('T-W1: does not mutate when the cascade confirm is cancelled', () => {
    mocks.useQuery.mockReturnValue({ data: { adminProviders: [provider()] }, loading: false });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ProviderSection />);

    fireEvent.click(screen.getByRole('button', { name: '操作菜单' }));
    fireEvent.click(screen.getByText('删除'));

    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});
