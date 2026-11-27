import { useEffect, useRef } from 'react';
import { useApolloClient } from '@apollo/client/react';
import { useAuth } from '../stores/auth';
import { useHomeOverview } from '../stores/homeOverview';
import {
  clearPersistedWorkspaceId,
  getWorkspaceState,
  readPersistedWorkspaceId,
  resetWorkspaceStore,
  syncWorkspaceContext,
} from '../stores/workspace';

/**
 * 将 `homeOverview.workspaceContext`（myWorkspaces / myTenants）同步到工作区 store。
 *
 * 数据随 `HOME_OVERVIEW` 的 15s 轮询刷新，不再另起独立轮询或组合查询：
 * - 窗口重新聚焦/标签页恢复可见时立即 `refetch()` HOME_OVERVIEW；
 * - 可见集不再包含当前/持久化工作区时，store 回退个人全局并清持久化；
 * - 持久化/当前工作区已不可达（请求返回 `workspace not found`）时，清空上下文并
 *   重新拉取，避免 header 持续指向失效工作区、所有请求一起失败。
 */
function workspaceNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.includes('workspace not found');
}

export function useWorkspaceContextSync(): void {
  const { user } = useAuth();
  const client = useApolloClient();
  const { data, error, refetch } = useHomeOverview();
  const workspaceContext = data?.workspaceContext;
  const lastFallbackResetRef = useRef<string | null>(null);
  const lastInvalidWorkspaceRef = useRef<string | null>(null);

  // 窗口重新聚焦 / 标签页恢复可见时立即刷新首页聚合（覆盖「切回页面马上查看」的场景）。
  useEffect(() => {
    if (!user?.id) return;
    const refresh = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      Promise.resolve(refetch()).catch(() => undefined);
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
    Promise.resolve(refetch()).catch(() => undefined);
  }, [error, refetch, user?.id]);

  useEffect(() => {
    if (!user?.id) {
      resetWorkspaceStore();
      lastFallbackResetRef.current = null;
      return;
    }
    if (
      !workspaceContext ||
      !Array.isArray(workspaceContext.myWorkspaces) ||
      !Array.isArray(workspaceContext.myTenants)
    ) {
      return;
    }
    // D12 降级保护：workspaceContext 单分支失败会 degrade 为空集；登录用户至少拥有
    // 个人全局工作区，因此空 myWorkspaces 只可能是降级值。此时不得据此清空持久化
    // 工作区 / 触发 resetStore（否则一次 Mongo 抖动会把用户静默切回个人全局）。
    if (workspaceContext.myWorkspaces.length === 0) {
      return;
    }

    // 请求已成功，失效工作区自愈完成；下一次再出现可重新处理。
    lastInvalidWorkspaceRef.current = null;

    const result = syncWorkspaceContext({
      workspaces: workspaceContext.myWorkspaces,
      tenants: workspaceContext.myTenants,
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
  }, [client, workspaceContext, user?.id]);
}
