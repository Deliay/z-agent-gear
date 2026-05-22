import { useState } from 'react';
import { useQuery, useMutation } from '@apollo/client/react';
import { GET_CONTROLLER_WORKSPACES, GET_SESSIONS } from '../../graphql/queries';
import { CREATE_WORKSPACE, DELETE_WORKSPACE, CLEAR_WORKSPACES, TOGGLE_WORKSPACE } from '../../graphql/mutations';
import type { GetControllerWorkspacesQuery, ControllerWorkspaceData } from '../../graphql/types';
import { Button } from '@/components/ui/button';
import DirectoryPicker from '../ui/DirectoryPicker';
import HistorySessionDialog from './HistorySessionDialog';

interface WorkspaceSectionProps {
  controllerId: string;
  controllerOnline?: boolean;
}

export default function WorkspaceSection({ controllerId, controllerOnline = false }: WorkspaceSectionProps) {
  const [showPicker, setShowPicker] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [historyWorkspace, setHistoryWorkspace] = useState<{ id: string; name: string } | null>(null);

  const { data, loading, refetch } = useQuery<GetControllerWorkspacesQuery>(GET_CONTROLLER_WORKSPACES, {
    variables: { controllerId },
  });

  const [createWorkspace] = useMutation(CREATE_WORKSPACE);
  const [deleteWorkspace] = useMutation(DELETE_WORKSPACE);
  const [clearWorkspaces] = useMutation(CLEAR_WORKSPACES);
  const [toggleWorkspace] = useMutation(TOGGLE_WORKSPACE);

  const workspaces = data?.controllerWorkspaces ?? [];

  const refetchSessions = () => ({ query: GET_SESSIONS });

  const handleAdd = async (path: string) => {
    await createWorkspace({
      variables: { input: { controllerId, path } },
      refetchQueries: [refetchSessions()],
    });
    await refetch();
    setShowPicker(false);
  };

  const handleDelete = async (id: string) => {
    await deleteWorkspace({
      variables: { id },
      refetchQueries: [refetchSessions()],
    });
    await refetch();
  };

  const handleClear = async () => {
    await clearWorkspaces({
      variables: { controllerId },
      refetchQueries: [refetchSessions()],
    });
    await refetch();
    setConfirmClear(false);
  };

  const handleToggle = async (id: string) => {
    await toggleWorkspace({
      variables: { id },
      refetchQueries: [refetchSessions()],
    });
    await refetch();
  };

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">工作区</h2>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setShowPicker(true)}>
            添加
          </Button>
          {workspaces.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => setConfirmClear(true)}>
              清空
            </Button>
          )}
        </div>
      </div>

      {showPicker ? (
        <DirectoryPicker
          controllerId={controllerId}
          onSelect={handleAdd}
          onClose={() => setShowPicker(false)}
        />
      ) : loading ? (
        <div className="text-sm text-muted-foreground">加载中...</div>
      ) : workspaces.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          暂无工作区，点击「添加」开始配置
        </div>
      ) : (
        <ul className="space-y-2">
          {workspaces.map((ws: ControllerWorkspaceData) => (
            <li key={ws.id} className="flex items-center gap-2 rounded-lg border p-3">
              <button
                type="button"
                className={`h-4 w-4 rounded shrink-0 ${ws.isEnabled ? 'bg-green-500' : 'bg-gray-300'}`}
                onClick={() => handleToggle(ws.id)}
              />
              <div className="flex-1 min-w-0">
                <div className="truncate font-medium">{ws.name}</div>
                <div className="truncate text-xs text-muted-foreground">{ws.path}</div>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={!controllerOnline || !ws.isEnabled}
                title={
                  !controllerOnline
                    ? 'Controller 离线，无法获取历史会话'
                    : !ws.isEnabled
                      ? '工作目录未启用'
                      : ''
                }
                onClick={() => setHistoryWorkspace({ id: ws.id, name: ws.name })}
              >
                历史会话
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive shrink-0"
                onClick={() => handleDelete(ws.id)}
              >
                删除
              </Button>
            </li>
          ))}
        </ul>
      )}

      {confirmClear && (
        <div className="mt-4 rounded-lg border border-destructive/50 p-4">
          <p className="text-sm text-destructive mb-3">确定要清空所有工作区吗？此操作不可撤销。</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmClear(false)}>
              取消
            </Button>
            <Button variant="destructive" size="sm" onClick={handleClear}>
              确认清空
            </Button>
          </div>
        </div>
      )}

      <HistorySessionDialog
        open={!!historyWorkspace}
        onOpenChange={() => setHistoryWorkspace(null)}
        controllerId={controllerId}
        workspaceId={historyWorkspace?.id ?? ''}
        workspaceName={historyWorkspace?.name ?? ''}
      />
    </>
  );
}
