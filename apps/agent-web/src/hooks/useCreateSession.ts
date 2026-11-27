import { useMutation } from '@apollo/client/react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { CREATE_SESSION } from '../graphql/mutations';
import { HOME_OVERVIEW } from '../graphql/home';
import { logger } from '../lib/logger';
import type { CreateSessionMutation } from '../graphql/types';

/**
 * 新建会话唯一提交链路（Sidebar 与 ⌘K 快速新建共用，D6）：
 * 参数口径与 `NewSessionDialog.onCreate` 的 10 个位置参数保持一致，
 * 不新增提交链路、不改 `onCreate` 签名。
 *
 * 成功返回新会话 id（调用方负责跳转与关闭弹窗），失败返回 null 并提示。
 */
export function useCreateSession() {
  const navigate = useNavigate();
  const [createSession] = useMutation<CreateSessionMutation>(CREATE_SESSION);

  return async function submitCreateSession(
    controllerId: string,
    acpServerType: string,
    workspaceId: string,
    enableWorktree?: boolean,
    worktreeBranchSuffix?: string,
    mcpServerIds?: string[],
    existingWorktreePath?: string,
    modeId?: string,
    modelId?: string,
    customMcpServerIds?: string[],
  ): Promise<string | null> {
    try {
      const { data: result } = await createSession({
        variables: {
          input: {
            controllerId,
            acpServerType,
            workspaceId,
            enableWorktree: existingWorktreePath ? false : (enableWorktree || false),
            worktreeBranchSuffix: worktreeBranchSuffix || null,
            // 显式空数组 = 不注入；undefined 走控制器默认
            mcpServerIds: mcpServerIds === undefined ? null : mcpServerIds,
            existingWorktreePath: existingWorktreePath || null,
            modeId: modeId || null,
            modelId: modelId || null,
            // 第 10 参：自定义 MCP；undefined/[] 不注入（保持旧报文形状不含该键）
            ...(customMcpServerIds && customMcpServerIds.length > 0
              ? { customMcpServerIds }
              : {}),
          },
        },
        refetchQueries: [{ query: HOME_OVERVIEW }],
      });
      const sessionId = result?.createSession?.session?.id;
      if (sessionId) {
        navigate(`/sessions/${sessionId}`);
        return sessionId;
      }
      return null;
    } catch (error) {
      logger.error({ err: error }, 'Failed to create session');
      // C-19：创建失败不能静默（弹窗已关闭，至少给出可感知反馈）
      toast.error(error instanceof Error ? error.message : '创建会话失败，请重试');
      return null;
    }
  };
}
