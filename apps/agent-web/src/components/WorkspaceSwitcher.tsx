import { NavLink } from 'react-router-dom';
import { useApolloClient } from '@apollo/client/react';
import { ChevronDown, Settings2, Users } from 'lucide-react';
import {
  buildWorkspaceGroups,
  selectWorkspace,
  shouldShowWorkspaceSwitcher,
  useWorkspaceStore,
} from '../stores/workspace';

/**
 * 工作区切换器（多租户二期）。
 * - 按租户分组、按角色过滤（数据源 myWorkspaces 已由服务端按角色展开）。
 * - 未加入任何 team（仅个人租户）时不渲染。
 * - 切换后清空 Apollo 缓存并重拉活跃查询（HOME_OVERVIEW 等单一数据源）。
 */
export default function WorkspaceSwitcher() {
  const { current, myWorkspaces, myTenants, initialized } = useWorkspaceStore();
  const client = useApolloClient();

  // 首次同步前不渲染，避免个人用户闪现切换器
  if (!initialized || !shouldShowWorkspaceSwitcher({ current, myWorkspaces, myTenants, userId: null, initialized })) {
    return null;
  }

  const groups = buildWorkspaceGroups(myWorkspaces, myTenants);
  if (groups.length === 0) return null;

  const isTeamAdmin = current?.tenant.type === 'team' && current.myRole === 'admin';

  const handleChange = async (workspaceId: string) => {
    if (!workspaceId || workspaceId === current?.id) return;
    if (!selectWorkspace(workspaceId)) return;
    await client.resetStore();
  };

  return (
    <div className="mb-3 space-y-1 border-b border-sidebar-border pb-3" data-testid="workspace-switcher">
      <label htmlFor="workspace-switcher-select" className="px-1 text-xs font-medium text-muted-foreground">
        工作区
      </label>
      <div className="relative">
        <select
          id="workspace-switcher-select"
          aria-label="切换工作区"
          value={current?.id ?? ''}
          onChange={(event) => {
            void handleChange(event.target.value);
          }}
          className="h-8 w-full min-w-0 appearance-none rounded-md border border-sidebar-border bg-sidebar px-2 pr-7 text-sm text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {groups.map((group) => (
            <optgroup key={group.tenant.id} label={`${group.tenant.name}（${group.role === 'admin' ? '管理员' : '开发'}）`}>
              {group.workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                  {workspace.type === 'global' ? '（全局）' : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 top-2 size-4 text-muted-foreground" />
      </div>
      {isTeamAdmin && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 pt-1">
          <NavLink
            to="/workspaces"
            aria-label="工作区管理"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-sidebar-foreground"
          >
            <Settings2 className="size-3" />
            工作区管理
          </NavLink>
          {current?.tenant.id && (
            <NavLink
              to={`/tenants/${current.tenant.id}/members`}
              aria-label="租户成员"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-sidebar-foreground"
            >
              <Users className="size-3" />
              租户成员
            </NavLink>
          )}
        </div>
      )}
    </div>
  );
}
