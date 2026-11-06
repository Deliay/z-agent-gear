import { useEffect, useRef } from 'react';
import { useQuery } from '@apollo/client/react';
import { useApolloClient } from '@apollo/client/react';
import { GET_WORKSPACE_CONTEXT } from '../graphql/queries';
import type { GetWorkspaceContextQuery } from '../graphql/types';
import { useAuth } from '../stores/auth';
import {
  clearPersistedWorkspaceId,
  getWorkspaceState,
  readPersistedWorkspaceId,
  resetWorkspaceStore,
  syncWorkspaceContext,
} from '../stores/workspace';

/**
 * 拉取 `myWorkspaces` / `myTenants` 并同步到工作区 store。
 *
 * 刷新策略：工作区成员关系/角色/工作区列表会在会话期间变化（团队管理员新建工作区、
 * 把成员加入工作区），而上下文查询此前只在挂载时执行一次，导致已登录用户看不到新
 * 工作区（切换器缺失 → 归属该工作区的云电脑/资源也就无法进入）。因此与首页聚合口径
 * 一致做周期刷新，并在窗口重新聚焦/可见时立即刷新。
 *
 * 失效回退：
 * - 服务端返回的可见集不再包含当前/持久化工作区时，store 回退个人全局并清持久化；
 * - 持久化/当前工作区已不可达（请求直接返回 `workspace not found`）时，清空上下文并
 *   重新拉取，避免 header 持续指向失效工作区、所有请求一起失败。
 */
const WORKSPACE_CONTEXT_POLL_MS = 15_000;

function workspaceNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.includes('workspace not found');
}

export function useWorkspaceContextSync(): void {
  const { user } = useAuth();
  const client = useApolloClient();
  const { data, error, refetch } = useQuery<GetWorkspaceContextQuery>(GET_WORKSPACE_CONTEXT, {
    skip: !user?.id,
    fetchPolicy: 'cache-and-network',
    pollInterval: WORKSPACE_CONTEXT_POLL_MS,
  });
  const lastFallbackResetRef = useRef<string | null>(null);
  const lastInvalidWorkspaceRef = useRef<string | null>(null);

  // 窗口重新聚焦 / 标签页恢复可见时立即刷新，覆盖「切回页面马上查看」的场景。
  useEffect(() => {
    if (!user?.id) return;
    const refresh = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refetch().catch(() => undefined);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [refetch, user?.id]);

  // 持久化/当前工作区已失效：清空选择后重新请求，服务端回退个人全局并返回新的可见集。
  useEffect(() => {
    if (!user?.id || !workspaceNotFound(error)) return;
    const invalidId = readPersistedWorkspaceId(user.id) ?? getWorkspaceState().current?.id ?? null;
    if (!invalidId || lastInvalidWorkspaceRef.current === invalidId) return;
    lastInvalidWorkspaceRef.current = invalidId;
    clearPersistedWorkspaceId(user.id);
    resetWorkspaceStore();
    void refetch().catch(() => undefined);
  }, [error, refetch, user?.id]);

  useEffect(() => {
    if (!user?.id) {
      resetWorkspaceStore();
      lastFallbackResetRef.current = null;
      return;
    }
    if (!data || !Array.isArray(data.myWorkspaces) || !Array.isArray(data.myTenants)) return;

    // 请求已成功，失效工作区自愈完成；下一次再出现可重新处理。
    lastInvalidWorkspaceRef.current = null;

    const result = syncWorkspaceContext({
      workspaces: data.myWorkspaces,
      tenants: data.myTenants,
      userId: user.id,
    });

    if (!result.fallback) {
      lastFallbackResetRef.current = null;
      return;
    }
    const fallbackId = getWorkspaceState().current?.id ?? '__none__';
    if (lastFallbackResetRef.current === fallbackId) return;
    lastFallbackResetRef.current = fallbackId;
    void client.resetStore().catch(() => undefined);
  }, [client, data, user?.id]);
}
