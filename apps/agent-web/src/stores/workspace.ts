import { useSyncExternalStore } from 'react';
import type {
  TenantMembershipData,
  TenantRole,
  WorkspaceData,
  WorkspaceTenantData,
} from '../graphql/types';

/**
 * 当前租户工作区状态（多租户二期，计划 Phase 8 / 裁决 13）。
 *
 * - 选择持久化：`localStorage['zag:current-workspace:<userId>']`（按 userId 隔离）。
 * - 缺省=个人租户全局工作区；未加入任何 team 时切换器隐藏。
 * - `myWorkspaces` 刷新后若当前/持久化工作区不在可见集（被移出团队、工作区已删除），
 *   自动回退个人全局并清理持久化，避免请求持续 `workspace not found`。
 */

export const WORKSPACE_STORAGE_PREFIX = 'zag:current-workspace';
export const AUTH_USER_STORAGE_KEY = 'auth_user';

export interface WorkspaceStoreState {
  current: WorkspaceData | null;
  myWorkspaces: WorkspaceData[];
  myTenants: TenantMembershipData[];
  /** 最近一次同步的 userId（用于持久化键隔离与登出清理） */
  userId: string | null;
  /** 是否已从 myWorkspaces 完成一次同步 */
  initialized: boolean;
}

const EMPTY: WorkspaceStoreState = {
  current: null,
  myWorkspaces: [],
  myTenants: [],
  userId: null,
  initialized: false,
};

let state: WorkspaceStoreState = EMPTY;
const listeners = new Set<() => void>();

function emit(next: WorkspaceStoreState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): WorkspaceStoreState {
  return state;
}

function getServerSnapshot(): WorkspaceStoreState {
  return EMPTY;
}

export function workspaceStorageKey(userId: string): string {
  return `${WORKSPACE_STORAGE_PREFIX}:${userId}`;
}

/** 当前登录用户 id（Apollo Link 等非 React 场景使用） */
export function readAuthUserId(): string | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(AUTH_USER_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { id?: unknown };
    return typeof parsed.id === 'string' && parsed.id ? parsed.id : null;
  } catch {
    return null;
  }
}

export function readPersistedWorkspaceId(userId: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(workspaceStorageKey(userId));
}

export function persistWorkspaceId(userId: string, workspaceId: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(workspaceStorageKey(userId), workspaceId);
}

export function clearPersistedWorkspaceId(userId: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(workspaceStorageKey(userId));
}

/**
 * Apollo Link 注入头时的当前工作区 id：
 * 优先已同步的 current；未同步前回退持久化选择（保证刷新/重登恢复）。
 * 返回 null 表示「无选择」→ 不发 `x-workspace-id`，服务端回退个人全局（一期等价）。
 */
export function getCurrentWorkspaceId(): string | null {
  if (state.current?.id) return state.current.id;
  const userId = state.userId ?? readAuthUserId();
  if (!userId) return null;
  return readPersistedWorkspaceId(userId);
}

/** 个人租户的全局工作区（缺省上下文） */
export function getPersonalGlobalWorkspace(
  workspaces: WorkspaceData[],
): WorkspaceData | null {
  return (
    workspaces.find(
      (workspace) => workspace.type === 'global' && workspace.tenant.type === 'personal',
    ) ??
    workspaces.find((workspace) => workspace.type === 'global') ??
    null
  );
}

export function isPersonalTenant(tenant: WorkspaceTenantData | null | undefined): boolean {
  return tenant?.type === 'personal';
}

export function isAnyTenantAdmin(tenants: TenantMembershipData[]): boolean {
  return tenants.some((membership) => membership.role === 'admin');
}

/** 是否展示切换器：仅个人租户用户不展示（未加入任何 team）。 */
export function shouldShowWorkspaceSwitcher(state: WorkspaceStoreState): boolean {
  return state.myTenants.some((membership) => membership.tenant.type === 'team');
}

export interface WorkspaceGroup {
  tenant: WorkspaceTenantData;
  role: TenantRole;
  workspaces: WorkspaceData[];
}

/**
 * 按租户分组并按角色过滤。`myWorkspaces` 本身已由服务端按角色展开
 * （admin=租户全部；developer=全局+已加入 normal），这里再收敛到 `myTenants`
 * 中真实存在的租户，避免旧缓存/越权数据出现在切换器。
 */
export function buildWorkspaceGroups(
  workspaces: WorkspaceData[],
  tenants: TenantMembershipData[],
): WorkspaceGroup[] {
  const roleByTenant = new Map(tenants.map((membership) => [membership.tenant.id, membership.role]));
  const groups = new Map<string, WorkspaceGroup>();
  for (const workspace of workspaces) {
    const tenant = workspace.tenant;
    // 仅展示当前用户仍是成员的租户（myWorkspaces 为旧缓存/越权数据时收敛）
    const role = roleByTenant.get(tenant.id);
    if (!role) continue;
    let group = groups.get(tenant.id);
    if (!group) {
      group = { tenant, role, workspaces: [] };
      groups.set(tenant.id, group);
    }
    group.workspaces.push(workspace);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      workspaces: [...group.workspaces].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'global' ? -1 : 1;
        return a.name.localeCompare(b.name);
      }),
    }))
    .sort((a, b) => {
      if (a.tenant.type !== b.tenant.type) return a.tenant.type === 'personal' ? -1 : 1;
      return a.tenant.name.localeCompare(b.tenant.name);
    });
}

export function getTenantRole(
  tenants: TenantMembershipData[],
  tenantId: string,
): TenantRole | null {
  return tenants.find((membership) => membership.tenant.id === tenantId)?.role ?? null;
}

export interface SyncWorkspaceResult {
  /** 当前选择不在可见集，已回退个人全局 */
  fallback: boolean;
  /** 回退或恢复导致 current 发生变化 */
  changed: boolean;
}

/** 用服务端最新 myWorkspaces/myTenants 同步状态并执行失效回退。 */
export function syncWorkspaceContext(input: {
  workspaces: WorkspaceData[];
  tenants: TenantMembershipData[];
  userId: string;
}): SyncWorkspaceResult {
  const { workspaces, tenants, userId } = input;
  const persistedId = readPersistedWorkspaceId(userId);
  const currentId = state.userId === userId ? state.current?.id ?? null : null;
  const desiredId = currentId ?? persistedId;

  const desired = desiredId ? workspaces.find((workspace) => workspace.id === desiredId) : undefined;
  if (desired) {
    const changed = state.current?.id !== desired.id || state.userId !== userId;
    emit({
      current: desired,
      myWorkspaces: workspaces,
      myTenants: tenants,
      userId,
      initialized: true,
    });
    if (changed) persistWorkspaceId(userId, desired.id);
    return { fallback: false, changed };
  }

  const fallback = getPersonalGlobalWorkspace(workspaces) ?? workspaces[0] ?? null;
  // 失效工作区：清理持久化，避免下一次请求继续携带非法 id。
  if (persistedId) clearPersistedWorkspaceId(userId);
  const changed =
    state.current?.id !== (fallback?.id ?? null) ||
    state.userId !== userId ||
    !state.initialized;
  emit({
    current: fallback,
    myWorkspaces: workspaces,
    myTenants: tenants,
    userId,
    initialized: true,
  });
  return { fallback: persistedId !== null || currentId !== null, changed };
}

/** 用户主动切换（仅允许切到可见集内的工作区）。 */
export function selectWorkspace(workspaceId: string): boolean {
  const workspace = state.myWorkspaces.find((item) => item.id === workspaceId);
  if (!workspace) return false;
  const userId = state.userId ?? readAuthUserId();
  if (!userId) return false;
  emit({ ...state, current: workspace, userId });
  persistWorkspaceId(userId, workspaceId);
  return true;
}

/** 登出/切换账号时清空内存状态（持久化按 userId 隔离，保留各账号自己的选择）。 */
export function resetWorkspaceStore(): void {
  emit(EMPTY);
}

/** 测试隔离用：清空状态并移除所有持久化键。 */
export function clearWorkspaceStorage(): void {
  if (typeof localStorage === 'undefined') return;
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(`${WORKSPACE_STORAGE_PREFIX}:`)) keys.push(key);
  }
  for (const key of keys) localStorage.removeItem(key);
}

export function getWorkspaceState(): WorkspaceStoreState {
  return state;
}

export function useWorkspaceStore(): WorkspaceStoreState & {
  select: typeof selectWorkspace;
  sync: typeof syncWorkspaceContext;
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    ...snapshot,
    select: selectWorkspace,
    sync: syncWorkspaceContext,
  };
}

/** 当前工作区视图模型（只读收敛、来源徽标与管理入口共用） */
export function useWorkspaceAccess() {
  const { current, myTenants } = useWorkspaceStore();
  const tenantId = current?.tenant.id ?? null;
  const role = current?.myRole ?? (tenantId ? getTenantRole(myTenants, tenantId) : null);
  return {
    workspace: current,
    tenant: current?.tenant ?? null,
    role,
    isAdmin: role === 'admin',
    isDeveloper: role === 'developer',
    isGlobal: current?.type === 'global',
    isTeamTenant: current?.tenant.type === 'team',
    /** 全局工作区 + developer：整体只读 */
    readOnly: current?.readOnly ?? (current?.type === 'global' && role === 'developer'),
    tenantId,
  };
}
