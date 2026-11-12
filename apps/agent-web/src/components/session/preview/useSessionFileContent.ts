import { useCallback } from 'react';
import { useQuery } from '@apollo/client/react';
import { GET_SESSION_FILE_CONTENT, type SessionFileContentData } from '../../../graphql/preview';

/**
 * 会话文件内容懒加载（预览 / Review 共用）。
 *
 * 状态收敛为三态，避免「无数据且无错误」被当成永久加载：
 * - `ready`：已有内容（含 cache-and-network 的缓存命中，刷新失败不吞掉旧内容）；
 * - `loading`：首次加载中；
 * - `error`：请求失败，或请求结束但既无数据也无错误（空响应）。
 */
export type SessionFileContentStatus = 'loading' | 'error' | 'ready';

export interface SessionFileContentState {
  status: SessionFileContentStatus;
  content: string;
  truncated: boolean;
  error: Error | null;
  retry: () => void;
}

export function useSessionFileContent(sessionId: string, path: string, skip = false): SessionFileContentState {
  const { data, loading, error, refetch } = useQuery<{ sessionFileContent: SessionFileContentData }>(
    GET_SESSION_FILE_CONTENT,
    {
      variables: { sessionId, path },
      fetchPolicy: 'cache-and-network',
      skip,
    },
  );

  const file = data?.sessionFileContent;
  // skip 时查询未发起：保持 loading（调用方本来就不会渲染内容区），不误报失败。
  const status: SessionFileContentStatus = skip
    ? 'loading'
    : file
      ? 'ready'
      : loading
        ? 'loading'
        : 'error';

  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  return {
    status,
    content: file?.content ?? '',
    truncated: file?.truncated ?? false,
    error: (error as Error | undefined) ?? null,
    retry,
  };
}
