// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  refetch: vi.fn(),
  resetStore: vi.fn(),
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
  useApolloClient: () => ({ resetStore: mocks.resetStore }),
}));

vi.mock('../../stores/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

import { useWorkspaceContextSync } from '../useWorkspaceContextSync';
import { GET_WORKSPACE_CONTEXT } from '../../graphql/queries';
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

describe('useWorkspaceContextSync（工作区上下文刷新）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWorkspaceStore();
    localStorage.clear();
    mocks.refetch.mockResolvedValue({});
    mocks.resetStore.mockResolvedValue(undefined);
    mocks.useQuery.mockReturnValue({ data: undefined, error: undefined, refetch: mocks.refetch });
  });

  it('周期轮询工作区上下文（团队新建/加入工作区后无需刷新页面）', () => {
    renderHook(() => useWorkspaceContextSync());

    expect(mocks.useQuery).toHaveBeenCalledWith(
      GET_WORKSPACE_CONTEXT,
      expect.objectContaining({
        fetchPolicy: 'cache-and-network',
        pollInterval: 15_000,
      }),
    );
  });

  it('窗口重新聚焦时立即刷新', () => {
    renderHook(() => useWorkspaceContextSync());
    mocks.refetch.mockClear();

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it('持久化工作区已不可达（workspace not found）时清理选择并重新拉取', () => {
    persistWorkspaceId('user-1', 'ws-deleted');
    mocks.useQuery.mockReturnValue({
      data: undefined,
      error: new Error('workspace not found'),
      refetch: mocks.refetch,
    });

    renderHook(() => useWorkspaceContextSync());

    expect(readPersistedWorkspaceId('user-1')).toBeNull();
    expect(getWorkspaceState().current).toBeNull();
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it('正常同步 myWorkspaces / myTenants 到 store', () => {
    mocks.useQuery.mockReturnValue({
      data: {
        myWorkspaces: [workspace('ws-global', 'global'), workspace('ws-normal', 'normal')],
        myTenants: [
          {
            tenant: { id: 'tenant-1', name: 't', type: 'team', memberCount: 2 },
            role: 'admin',
          },
        ],
      },
      error: undefined,
      refetch: mocks.refetch,
    });

    renderHook(() => useWorkspaceContextSync());

    const state = getWorkspaceState();
    expect(state.initialized).toBe(true);
    expect(state.myWorkspaces.map((item) => item.id)).toEqual(['ws-global', 'ws-normal']);
    expect(state.current?.id).toBe('ws-global');
  });
});
