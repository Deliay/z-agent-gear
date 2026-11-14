import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ExternalLoginBindingSection from '../ExternalLoginBindingSection';

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();
const mocks = vi.hoisted(() => ({
  unbind: vi.fn(async () => ({ data: { unbindExternalLogin: true } })),
  createTicket: vi.fn(),
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}));

function queryResult(data: Record<string, unknown>) {
  return { data, loading: false, error: null, refetch: vi.fn() };
}

const BINDING = {
  id: 'el1',
  providerId: 'p1',
  providerType: 'oidc',
  providerDisplayName: '公司 SSO',
  providerEnabled: true,
  externalUsername: 'octo',
  displayName: 'Octo',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: '2026-02-01T00:00:00.000Z',
};

const PROVIDERS = [
  { id: 'p1', type: 'oidc', displayName: '公司 SSO' },
  { id: 'p2', type: 'github_oauth', displayName: 'GitHub' },
];

function setup(bindings: unknown[], providers: unknown[]) {
  mockUseQuery
    .mockReturnValueOnce(queryResult({ myExternalLogins: bindings }))
    .mockReturnValueOnce(queryResult({ authProviders: providers }))
    .mockReturnValue(queryResult({ myExternalLogins: bindings, authProviders: providers }));
}

describe('ExternalLoginBindingSection（T-OBO-BIND）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockReset();
    mockUseMutation.mockReset();
    let mutationCalls = 0;
    // 每次渲染的 useMutation 顺序固定：先 unbind 后 createFrontBindTicket
    mockUseMutation.mockImplementation(() => {
      const mutate = mutationCalls % 2 === 0 ? mocks.unbind : mocks.createTicket;
      mutationCalls += 1;
      return [mutate, { loading: false }];
    });
    mocks.unbind.mockResolvedValue({ data: { unbindExternalLogin: true } });
    mocks.createTicket.mockImplementation(
      () => new Promise(() => undefined),
    );
  });

  it('未配置任何登录方式且无绑定 → 不渲染区块', () => {
    setup([], []);
    const { container } = render(<ExternalLoginBindingSection />);
    expect(container.firstChild).toBeNull();
  });

  it('展示绑定列表（登录方式/外部帐号名/时间）与停用徽标', () => {
    setup([{ ...BINDING, providerEnabled: false }], [PROVIDERS[1]]);
    render(<ExternalLoginBindingSection />);
    expect(screen.getByText('公司 SSO')).toBeDefined();
    expect(screen.getByText('外部帐号：octo')).toBeDefined();
    expect(screen.getByText('已停用')).toBeDefined();
    expect(screen.getByRole('button', { name: '解绑' })).toBeDefined();
  });

  it('已绑定登录方式展示「已绑定」，未绑定项才提供绑定入口', () => {
    setup([BINDING], PROVIDERS);
    render(<ExternalLoginBindingSection />);
    expect(screen.getByText('已绑定')).toBeDefined();
    expect(screen.getByRole('button', { name: '绑定 GitHub' })).toBeDefined();
    expect(screen.queryByRole('button', { name: '绑定 公司 SSO' })).toBeNull();
  });

  it('点击绑定 → createFrontBindTicket(providerId)', async () => {
    setup([], [PROVIDERS[0]]);
    render(<ExternalLoginBindingSection />);
    fireEvent.click(screen.getByRole('button', { name: '绑定 公司 SSO' }));
    await waitFor(() => {
      expect(mocks.createTicket).toHaveBeenCalledWith({ variables: { providerId: 'p1' } });
    });
  });

  it('解绑经二次确认后调用 unbindExternalLogin', async () => {
    setup([BINDING], PROVIDERS);
    render(<ExternalLoginBindingSection />);
    fireEvent.click(screen.getByRole('button', { name: '解绑' }));
    expect(
      screen.getByText('确定要解绑该第三方登录方式吗？解绑后该身份将无法再登录当前账户。'),
    ).toBeDefined();

    const buttons = screen.getAllByRole('button', { name: '解绑' });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => {
      expect(mocks.unbind).toHaveBeenCalledWith({ variables: { id: 'el1' } });
    });
  });
});
