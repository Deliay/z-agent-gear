import { useCallback } from 'react';
import { resolveResourceSource, type ResourceSource } from '@/lib/workspace-source';
import { useWorkspaceStore } from '@/stores/workspace';

/** 当前上下文的资源共享来源判定（供应商/模型/GitHub 绑定复用）。 */
export function useResourceSourceResolver(): (workspaceId: string | null | undefined) => ResourceSource {
  const { current, myWorkspaces } = useWorkspaceStore();
  return useCallback(
    (workspaceId: string | null | undefined): ResourceSource =>
      resolveResourceSource(workspaceId, current, myWorkspaces),
    [current, myWorkspaces],
  );
}
