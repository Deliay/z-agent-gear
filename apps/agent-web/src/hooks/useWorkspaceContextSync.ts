import { useEffect, useRef } from 'react';
import { useQuery } from '@apollo/client/react';
import { useApolloClient } from '@apollo/client/react';
import { GET_WORKSPACE_CONTEXT } from '../graphql/queries';
import type { GetWorkspaceContextQuery } from '../graphql/types';
import { useAuth } from '../stores/auth';
import {
  getWorkspaceState,
  resetWorkspaceStore,
  syncWorkspaceContext,
} from '../stores/workspace';

/**
 * 拉取 `myWorkspaces` / `myTenants` 并同步到工作区 store。
 *
 * 失效回退：服务端返回的可见集不再包含当前/持久化工作区时，store 回退个人全局并清理
 * 持久化；此处随即重置 Apollo store，让 HOME_OVERVIEW 等查询以新上下文重新拉取。
 */
export function useWorkspaceContextSync(): void {
  const { user } = useAuth();
  const client = useApolloClient();
  const { data } = useQuery<GetWorkspaceContextQuery>(GET_WORKSPACE_CONTEXT, {
    skip: !user?.id,
    fetchPolicy: 'cache-and-network',
  });
  const lastFallbackResetRef = useRef<string | null>(null);

  useEffect(() => {
    if (!user?.id) {
      resetWorkspaceStore();
      lastFallbackResetRef.current = null;
      return;
    }
    if (!data || !Array.isArray(data.myWorkspaces) || !Array.isArray(data.myTenants)) return;

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
    void client.resetStore();
  }, [client, data, user?.id]);
}
