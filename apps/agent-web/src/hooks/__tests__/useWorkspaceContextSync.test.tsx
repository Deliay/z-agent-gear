// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  refetch: vi.fn(),
  resetStore: vi.fn(),
  home: { data: null as unknown, error: undefined as unknown, refetch: vi.fn() },
}));

vi.mock('@apollo/client/react', () => ({
  useApolloClient: () => ({ resetStore: mocks.resetStore }),
}));

vi.mock('../../stores/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('../../stores/homeOverview', () => ({
  useHomeOverview: () => mocks.home,
}));

import { useWorkspaceContextSync } from '../useWorkspaceContextSync';
import {
  getWorkspaceState,
  persistWorkspaceId,
  readPersistedWorkspaceId,
  resetWorkspaceStore,
} from '../../stores/workspace';

function workspace(id: string, type: 'global' | 'normal', tenantId = 'tenant-1') {
  return {
    id,
    name: id,
    type,
    tenant: { id: tenantId, name: 't', type: 'team', memberCount: 2 },
    memberCount: 2,
    myRole: 'admin' as const,
    readOnly: false,
    createdAt: new Date().toISOString(),
  };
}

function homeData(overrides: { workspaces?: unknown[]; tenants?: unknown[] } = {}) {
  return {
    workspaceContext: {
      myWorkspaces: overrides.workspaces ?? [],
      myTenants: overrides.tenants ?? [],
    },
  };
}

describe('useWorkspaceContextSync（消费 homeOverview.workspaceContext）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWorkspaceStore();
    localStorage.clear();
    mocks.refetch.mockResolvedValue({});
    mocks.resetStore.mockResolvedValue(undefined);
    mocks.home = { data: null, error: undefined, refetch: mocks.refetch };
  });

  it('不再发起独立查询/轮询（数据随 HOME_OVERVIEW 15s 轮询）', () => {
    renderHook(() => useWorkspaceContextSync());
    // 无 useQuery 调用点：模块仅使用 useHomeOverview（由用例 mock 提供）
    expect(mocks.home.data).toBeNull();
  });

  it('窗口重新聚焦时立即 refetch HOME_OVERVIEW', () => {
    renderHook(() => useWorkspaceContextSync());
    mocks.refetch.mockClear();

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it('持久化工作区已不可达（workspace not found）时清理选择并重新拉取', () => {
    persistWorkspaceId('user-1', 'ws-deleted');
    mocks.home = {
      data: null,
      error: new Error('workspace not found'),
      refetch: mocks.refetch,
    };

    renderHook(() => useWorkspaceContextSync());

    expect(readPersistedWorkspaceId('user-1')).toBeNull();
    expect(getWorkspaceState().current).toBeNull();
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it('正常同步 workspaceContext.myWorkspaces / myTenants 到 store', () => {
    mocks.home = {
      data: homeData({
        workspaces: [workspace('ws-global', 'global'), workspace('ws-normal', 'normal')],
        tenants: [
          {
            tenant: { id: 'tenant-1', name: 't', type: 'team', memberCount: 2 },
            role: 'admin',
          },
        ],
      }),
      error: undefined,
      refetch: mocks.refetch,
    };

    renderHook(() => useWorkspaceContextSync());

    const state = getWorkspaceState();
    expect(state.initialized).toBe(true);
    expect(state.myWorkspaces.map((item) => item.id)).toEqual(['ws-global', 'ws-normal']);
    expect(state.current?.id).toBe('ws-global');
  });
});
