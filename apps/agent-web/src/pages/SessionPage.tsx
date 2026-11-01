import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@apollo/client/react';
import { toast } from 'sonner';
import { GET_SESSIONS, GET_CONTROLLERS } from '../graphql/queries';
import { CREATE_SESSION } from '../graphql/mutations';
import type { GetControllersQuery, CreateSessionMutation } from '../graphql/types';
import SessionView from '../components/session/SessionView';
import NewSessionDialog from '../components/session/NewSessionDialog';
import { Button } from '../components/ui/button';
import { logger } from '../lib/logger';

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [showNewSessionDialog, setShowNewSessionDialog] = useState(false);

  const { data: controllersData } = useQuery<GetControllersQuery>(GET_CONTROLLERS);
  const [createSession] = useMutation<CreateSessionMutation>(CREATE_SESSION);

  const handleCreateSession = async (
    controllerId: string,
    acpServerType: string,
    workspaceId: string,
    enableWorktree?: boolean,
    worktreeBranchSuffix?: string,
    mcpServerIds?: string[],
    existingWorktreePath?: string,
    modeId?: string,
    modelId?: string,
  ) => {
    try {
      const { data } = await createSession({
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
          },
        },
        refetchQueries: [{ query: GET_SESSIONS }],
      });
      if (data?.createSession?.session?.id) {
        navigate(`/sessions/${data.createSession.session.id}`);
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to create session');
      // C-19：创建失败不能静默
      toast.error(error instanceof Error ? error.message : '创建会话失败，请重试');
    }
  };

  if (!id) {
    return (
      <div className="p-6">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold">会话</h1>
          <Button onClick={() => setShowNewSessionDialog(true)}>
            新建会话
          </Button>
        </div>
        <p className="text-muted-foreground">暂无会话</p>

        {showNewSessionDialog && (
          <NewSessionDialog
            controllers={controllersData?.controllers || []}
            onClose={() => setShowNewSessionDialog(false)}
            onCreate={handleCreateSession}
          />
        )}
      </div>
    );
  }

  return (
    <>
      <SessionView sessionId={id} onDeleted={() => navigate('/sessions')} />

      {showNewSessionDialog && (
        <NewSessionDialog
          controllers={controllersData?.controllers || []}
          onClose={() => setShowNewSessionDialog(false)}
          onCreate={handleCreateSession}
        />
      )}
    </>
  );
}
