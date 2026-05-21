import { useState } from 'react';
import { useQuery, useMutation } from '@apollo/client/react';
import { GET_CONTROLLER_WORKSPACES, GET_SESSIONS } from '../../graphql/queries';
import { CREATE_WORKSPACE, DELETE_WORKSPACE, CLEAR_WORKSPACES, TOGGLE_WORKSPACE } from '../../graphql/mutations';
import type { GetControllerWorkspacesQuery, ControllerWorkspaceData } from '../../graphql/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import DirectoryPicker from '../ui/DirectoryPicker';

interface WorkspaceManagerDialogProps {
  controllerId: string;
  controllerName: string;
  onClose: () => void;
}

export default function WorkspaceManagerDialog({ controllerId, controllerName, onClose }: WorkspaceManagerDialogProps) {
  const [showPicker, setShowPicker] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

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
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>管理工作区</DialogTitle>
          <DialogDescription>
            管理控制器「{controllerName}」的工作区目录
          </DialogDescription>
        </DialogHeader>

        {showPicker ? (
          <DirectoryPicker
            controllerId={controllerId}
            onSelect={handleAdd}
            onClose={() => setShowPicker(false)}
          />
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                {workspaces.length} 个工作区
              </span>
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

            {loading ? (
              <div className="text-sm text-muted-foreground">加载中...</div>
            ) : workspaces.length === 0 ? (
              <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                暂无工作区，点击「添加」开始配置
              </div>
            ) : (
              <ul className="max-h-64 space-y-2 overflow-y-auto">
                {workspaces.map((ws: ControllerWorkspaceData) => (
                  <li key={ws.id} className="flex items-center gap-2 rounded-lg border p-3">
                    <button
                      type="button"
                      className={`h-4 w-4 rounded ${ws.isEnabled ? 'bg-green-500' : 'bg-gray-300'}`}
                      onClick={() => handleToggle(ws.id)}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-medium">{ws.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{ws.path}</div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => handleDelete(ws.id)}
                    >
                      删除
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>

      <Dialog open={confirmClear} onOpenChange={() => setConfirmClear(false)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>清空工作区</DialogTitle>
            <DialogDescription>
              确定要清空所有工作区吗？此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClear(false)}>
              取消
            </Button>
            <Button variant="destructive" onClick={handleClear}>
              确认清空
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
