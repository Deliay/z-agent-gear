import { describe, it, expect, beforeEach } from 'vitest';
import type {
  TenantMembershipData,
  WorkspaceData,
  WorkspaceTenantData,
} from '../../graphql/types';
import {
  buildWorkspaceGroups,
  clearWorkspaceStorage,
  getCurrentWorkspaceId,
  getPersonalGlobalWorkspace,
  getWorkspaceState,
  readPersistedWorkspaceId,
  resetWorkspaceStore,
  selectWorkspace,
  shouldShowWorkspaceSwitcher,
  syncWorkspaceContext,
  workspaceStorageKey,
} from '../workspace';

const PERSONAL_TENANT: WorkspaceTenantData = {
  id: 'tenant-p',
  name: 'personal',
  type: 'personal',
  memberCount: 1,
};

const TEAM_TENANT: WorkspaceTenantData = {
  id: 'tenant-t',
  name: '团队一',
  type: 'team',
  memberCount: 3,
};

function workspace(
  id: string,
  name: string,
  type: 'global' | 'normal',
  tenant: WorkspaceTenantData,
  myRole: 'admin' | 'developer' = 'admin',
): WorkspaceData {
  return {
    id,
    name,
    type,
    tenant,
    memberCount: type === 'global' ? tenant.memberCount : 1,
    myRole,
    readOnly: type === 'global' && myRole === 'developer',
    createdAt: '2026-10-28T00:00:00Z',
  };
}

const PERSONAL_GLOBAL = workspace('ws-p-global', '全局工作区', 'global', PERSONAL_TENANT);
const TEAM_GLOBAL = workspace('ws-t-global', '全局工作区', 'global', TEAM_TENANT);
const TEAM_NORMAL = workspace('ws-t-normal', '项目 A', 'normal', TEAM_TENANT);

const PERSONAL_MEMBERSHIP: TenantMembershipData = { tenant: PERSONAL_TENANT, role: 'admin' };
const TEAM_MEMBERSHIP: TenantMembershipData = { tenant: TEAM_TENANT, role: 'admin' };

function stateOf(workspaces: WorkspaceData[], tenants: TenantMembershipData[], userId: string) {
  syncWorkspaceContext({ workspaces, tenants, userId });
  return getWorkspaceState();
}

describe('workspace store（多租户二期 Phase 8）', () => {
  beforeEach(() => {
    localStorage.clear();
    resetWorkspaceStore();
  });

  it('首次同步缺省选择个人全局工作区', () => {
    syncWorkspaceContext({
      workspaces: [TEAM_GLOBAL, PERSONAL_GLOBAL],
      tenants: [PERSONAL_MEMBERSHIP, TEAM_MEMBERSHIP],
      userId: 'u1',
    });

    expect(getPersonalGlobalWorkspace([TEAM_GLOBAL, PERSONAL_GLOBAL])?.id).toBe('ws-p-global');
    expect(getCurrentWorkspaceId()).toBe('ws-p-global');
  });

  it('刷新时按 userId 隔离恢复持久化选择', () => {
    syncWorkspaceContext({
      workspaces: [PERSONAL_GLOBAL, TEAM_GLOBAL, TEAM_NORMAL],
      tenants: [PERSONAL_MEMBERSHIP, TEAM_MEMBERSHIP],
      userId: 'u1',
    });
    expect(selectWorkspace('ws-t-normal')).toBe(true);
    expect(readPersistedWorkspaceId('u1')).toBe('ws-t-normal');

    // 模拟刷新：清空内存状态后重新同步
    resetWorkspaceStore();
    syncWorkspaceContext({
      workspaces: [PERSONAL_GLOBAL, TEAM_GLOBAL, TEAM_NORMAL],
      tenants: [PERSONAL_MEMBERSHIP, TEAM_MEMBERSHIP],
      userId: 'u1',
    });
    expect(getCurrentWorkspaceId()).toBe('ws-t-normal');
  });

  it('不同 userId 的持久化选择互不影响', () => {
    localStorage.setItem(workspaceStorageKey('u1'), 'ws-t-normal');
    localStorage.setItem(workspaceStorageKey('u2'), 'ws-t-global');

    expect(readPersistedWorkspaceId('u1')).toBe('ws-t-normal');
    expect(readPersistedWorkspaceId('u2')).toBe('ws-t-global');
  });

  it('失效工作区（被移出团队/已删除）自动回退个人全局并清理持久化', () => {
    localStorage.setItem(workspaceStorageKey('u1'), 'ws-removed');

    const result = syncWorkspaceContext({
      workspaces: [PERSONAL_GLOBAL, TEAM_GLOBAL],
      tenants: [PERSONAL_MEMBERSHIP, TEAM_MEMBERSHIP],
      userId: 'u1',
    });

    expect(result.fallback).toBe(true);
    expect(getCurrentWorkspaceId()).toBe('ws-p-global');
    expect(readPersistedWorkspaceId('u1')).toBeNull();
  });

  it('当前工作区不在刷新后的可见集时同样回退并清理', () => {
    syncWorkspaceContext({
      workspaces: [PERSONAL_GLOBAL, TEAM_GLOBAL, TEAM_NORMAL],
      tenants: [PERSONAL_MEMBERSHIP, TEAM_MEMBERSHIP],
      userId: 'u1',
    });
    selectWorkspace('ws-t-normal');

    const result = syncWorkspaceContext({
      workspaces: [PERSONAL_GLOBAL, TEAM_GLOBAL],
      tenants: [PERSONAL_MEMBERSHIP, TEAM_MEMBERSHIP],
      userId: 'u1',
    });

    expect(result.fallback).toBe(true);
    expect(getCurrentWorkspaceId()).toBe('ws-p-global');
  });

  it('未加入任何 team（仅个人租户）隐藏切换器', () => {
    const state = stateOf([PERSONAL_GLOBAL], [PERSONAL_MEMBERSHIP], 'u1');
    expect(shouldShowWorkspaceSwitcher({
      current: state.current,
      myWorkspaces: state.myWorkspaces,
      myTenants: state.myTenants,
      userId: 'u1',
      initialized: true,
    })).toBe(false);

    const teamState = stateOf(
      [PERSONAL_GLOBAL, TEAM_GLOBAL],
      [PERSONAL_MEMBERSHIP, TEAM_MEMBERSHIP],
      'u1',
    );
    expect(shouldShowWorkspaceSwitcher({
      current: teamState.current,
      myWorkspaces: teamState.myWorkspaces,
      myTenants: teamState.myTenants,
      userId: 'u1',
      initialized: true,
    })).toBe(true);
  });

  it('按租户分组：个人在前，组内全局工作区在前', () => {
    const groups = buildWorkspaceGroups(
      [TEAM_NORMAL, TEAM_GLOBAL, PERSONAL_GLOBAL],
      [TEAM_MEMBERSHIP, PERSONAL_MEMBERSHIP],
    );

    expect(groups.map((group) => group.tenant.id)).toEqual(['tenant-p', 'tenant-t']);
    expect(groups[1].role).toBe('admin');
    expect(groups[1].workspaces.map((item) => item.id)).toEqual(['ws-t-global', 'ws-t-normal']);
  });

  it('切换器不展示 myTenants 中不存在的租户（越权/旧缓存收敛）', () => {
    const orphan = workspace('ws-orphan', '旧团队', 'normal', {
      id: 'tenant-old',
      name: '旧团队',
      type: 'team',
      memberCount: 1,
    });
    const groups = buildWorkspaceGroups([PERSONAL_GLOBAL, orphan], [PERSONAL_MEMBERSHIP]);
    expect(groups.map((group) => group.tenant.id)).toEqual(['tenant-p']);
  });

  it('只允许切换到可见集内的工作区', () => {
    syncWorkspaceContext({
      workspaces: [PERSONAL_GLOBAL, TEAM_GLOBAL],
      tenants: [PERSONAL_MEMBERSHIP, TEAM_MEMBERSHIP],
      userId: 'u1',
    });
    expect(selectWorkspace('ws-missing')).toBe(false);
    expect(getCurrentWorkspaceId()).toBe('ws-p-global');
  });

  it('clearWorkspaceStorage 只清理工作区选择键', () => {
    localStorage.setItem(workspaceStorageKey('u1'), 'ws-p-global');
    localStorage.setItem(workspaceStorageKey('u2'), 'ws-p-global');
    localStorage.setItem('auth_token', 't');
    clearWorkspaceStorage();
    expect(localStorage.getItem(workspaceStorageKey('u1'))).toBeNull();
    expect(localStorage.getItem(workspaceStorageKey('u2'))).toBeNull();
    expect(localStorage.getItem('auth_token')).toBe('t');
  });
});
