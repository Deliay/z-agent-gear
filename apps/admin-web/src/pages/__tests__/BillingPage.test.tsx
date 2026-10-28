import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BillingPage from '@/pages/BillingPage';
import type { BillingAccountData } from '@/graphql/types';

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  refetch: vi.fn(),
  searchParams: { current: new URLSearchParams() },
}));

vi.mock('@apollo/client', () => ({
  gql: (strings: TemplateStringsArray) => strings.join(''),
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
  useMutation: () => [vi.fn(), { loading: false }],
}));

vi.mock('react-router-dom', () => ({
  useSearchParams: () => [mocks.searchParams.current],
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const tenantAccount: BillingAccountData = {
  id: 'a-tenant',
  ownerType: 'tenant',
  ownerId: 't1',
  ownerName: '租户甲',
  cashBalance: 0,
  giftBalance: 0,
  creditLimit: 0,
  frozenAmount: 0,
  availableBalance: 0,
  status: 'active',
  insufficientSince: null,
  ledgerCount: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const adminAccount: BillingAccountData = {
  ...tenantAccount,
  id: 'a-admin',
  ownerType: 'admin_user',
  ownerId: 'admin',
  ownerName: '后台管理员',
};

function setupAccounts(accounts: BillingAccountData[]) {
  mocks.useQuery.mockImplementation((doc: unknown) => {
    const source = String(doc);
    if (source.includes('AdminBillingAccounts')) {
      return {
        data: { adminBillingAccounts: accounts },
        loading: false,
        error: undefined,
        refetch: mocks.refetch,
      };
    }
    return { data: undefined, loading: false, error: undefined, refetch: mocks.refetch };
  });
}

function lastVariables() {
  const call = mocks.useQuery.mock.calls
    .filter(([doc]) => String(doc).includes('AdminBillingAccounts'))
    .at(-1);
  return (call?.[1] as { variables?: Record<string, unknown> } | undefined)?.variables;
}

describe('BillingPage 双 owner 检索', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchParams.current = new URLSearchParams();
  });

  it('ownerType 下拉同时提供 tenant 与 admin_user', () => {
    setupAccounts([tenantAccount, adminAccount]);
    render(<BillingPage />);

    const select = screen.getByLabelText('账户类型');
    expect(select).toBeDefined();
    expect(screen.getByRole('option', { name: '租户（tenant）' })).toBeDefined();
    expect(screen.getByRole('option', { name: '后台（admin_user）' })).toBeDefined();
    expect(screen.getByText('租户甲')).toBeDefined();
    expect(screen.getByText('后台管理员')).toBeDefined();
  });

  it('切换 ownerType 触发按类型检索', () => {
    setupAccounts([tenantAccount, adminAccount]);
    render(<BillingPage />);

    expect(lastVariables()).toEqual({ keyword: null, ownerType: null, page: 1, pageSize: 20 });

    fireEvent.change(screen.getByLabelText('账户类型'), { target: { value: 'tenant' } });
    expect(lastVariables()).toEqual({ keyword: null, ownerType: 'tenant', page: 1, pageSize: 20 });

    fireEvent.change(screen.getByLabelText('账户类型'), { target: { value: 'admin_user' } });
    expect(lastVariables()).toEqual({ keyword: null, ownerType: 'admin_user', page: 1, pageSize: 20 });
  });

  it('从租户详情页跳转时预置 tenant 检索并自动选中该租户计费账户', () => {
    mocks.searchParams.current = new URLSearchParams('ownerType=tenant&keyword=t1');
    setupAccounts([adminAccount, tenantAccount]);
    render(<BillingPage />);

    expect(screen.getByLabelText('账户类型')).toHaveValue('tenant');
    expect(screen.getByDisplayValue('t1')).toBeDefined();
    expect(lastVariables()).toEqual({
      keyword: 't1',
      ownerType: 'tenant',
      page: 1,
      pageSize: 20,
    });
    // 自动选中 tenant 账户后展开账户详情与充值入口
    expect(screen.getByText('租户甲 的账户')).toBeDefined();
    expect(screen.getAllByRole('button', { name: '充值' }).length).toBeGreaterThan(0);
  });
});
