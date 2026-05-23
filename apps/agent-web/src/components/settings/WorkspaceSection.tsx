import { useState } from 'react';
import { useQuery, useMutation } from '@apollo/client/react';
import { GET_CONTROLLER_WORKSPACES, GET_SESSIONS, GET_WORKSPACES } from '../../graphql/queries';
import { CREATE_WORKSPACE, DELETE_WORKSPACE, CLEAR_WORKSPACES, TOGGLE_WORKSPACE, INIT_GIT_REPO, SET_WORKSPACE_DEFAULT_BRANCH } from '../../graphql/mutations';
import type { GetControllerWorkspacesQuery, ControllerWorkspaceData, GitRepoInfoData } from '../../graphql/types';
import { Button } from '@/components/ui/button';
import HistorySessionDialog from './HistorySessionDialog';
import AddWorkspaceDialog from './AddWorkspaceDialog';
import { ChevronDownIcon, ChevronRightIcon, GitBranchIcon, LoaderIcon } from 'lucide-react';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectIcon,
  SelectPopup,
  SelectItem,
  SelectItemText,
} from '@/components/ui/select';

interface WorkspaceSectionProps {
  controllerId: string;
  controllerOnline?: boolean;
}

export default function WorkspaceSection({ controllerId, controllerOnline = false }: WorkspaceSectionProps) {
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [historyWorkspace, setHistoryWorkspace] = useState<{ id: string; name: string } | null>(null);
  const [gitStates, setGitStates] = useState<Record<string, {
    loading: boolean;
    data?: GitRepoInfoData;
    error?: string;
  }>>({});

  const { data, loading, refetch } = useQuery<GetControllerWorkspacesQuery>(GET_CONTROLLER_WORKSPACES, {
    variables: { controllerId },
  });

  const [createWorkspace] = useMutation(CREATE_WORKSPACE);
  const [deleteWorkspace] = useMutation(DELETE_WORKSPACE);
  const [clearWorkspaces] = useMutation(CLEAR_WORKSPACES);
  const [toggleWorkspace] = useMutation(TOGGLE_WORKSPACE);
  const [initGitRepo] = useMutation(INIT_GIT_REPO);
  const [setWorkspaceDefaultBranch] = useMutation(SET_WORKSPACE_DEFAULT_BRANCH);

  const workspaces = data?.controllerWorkspaces ?? [];

  const refetchSessions = () => ({ query: GET_SESSIONS });
  const refetchWorkspaces = () => ({ query: GET_WORKSPACES });

  const handleAdd = async (path: string) => {
    await createWorkspace({
      variables: { input: { controllerId, path } },
      refetchQueries: [refetchSessions(), refetchWorkspaces()],
    });
    await refetch();
    setShowAddDialog(false);
  };

  const handleDelete = async (id: string) => {
    await deleteWorkspace({
      variables: { id },
      refetchQueries: [refetchSessions(), refetchWorkspaces()],
    });
    await refetch();
  };

  const handleClear = async () => {
    await clearWorkspaces({
      variables: { controllerId },
      refetchQueries: [refetchSessions(), refetchWorkspaces()],
    });
    await refetch();
    setConfirmClear(false);
  };

  const handleToggle = async (id: string) => {
    await toggleWorkspace({
      variables: { id },
      refetchQueries: [refetchSessions(), refetchWorkspaces()],
    });
    await refetch();
  };

  const handleExpand = async (wsId: string) => {
    if (expandedId === wsId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(wsId);

    if (!gitStates[wsId]) {
      setGitStates((prev) => ({ ...prev, [wsId]: { loading: true } }));

      try {
        const gitData = await refetchGitState(wsId);
        setGitStates((prev) => ({
          ...prev,
          [wsId]: { loading: false, data: gitData },
        }));
      } catch (err) {
        setGitStates((prev) => ({
          ...prev,
          [wsId]: { loading: false, error: (err as Error).message },
        }));
      }
    }
  };

  const refetchGitState = async (wsId: string) => {
    const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:4000';
    const token = localStorage.getItem('auth_token');
    const result = await fetch(`${apiBase}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        query: `query DetectGitRepo($controllerId: ID!, $workspaceId: ID!) {
          detectGitRepo(controllerId: $controllerId, workspaceId: $workspaceId) {
            isGitRepo
            currentBranch
            branches
            defaultBranch
          }
        }`,
        variables: { controllerId, workspaceId: wsId },
      }),
    });
    const json = await result.json();
    if (json.errors) throw new Error(json.errors[0].message);
    return json.data.detectGitRepo;
  };

  const handleInitGit = async (ws: ControllerWorkspaceData) => {
    setGitStates((prev) => ({
      ...prev,
      [ws.id]: { loading: true },
    }));

    try {
      await initGitRepo({
        variables: { controllerId, workspaceId: ws.id },
      });

      const gitData = await refetchGitState(ws.id);
      setGitStates((prev) => ({
        ...prev,
        [ws.id]: { loading: false, data: gitData },
      }));
    } catch (err) {
      setGitStates((prev) => ({
        ...prev,
        [ws.id]: { loading: false, error: (err as Error).message },
      }));
    }
  };

  const handleDefaultBranchChange = async (wsId: string, defaultBranch: string) => {
    await setWorkspaceDefaultBranch({
      variables: { id: wsId, defaultBranch },
    });

    setGitStates((prev) => {
      const current = prev[wsId];
      if (!current?.data) return prev;
      return {
        ...prev,
        [wsId]: {
          ...current,
          data: { ...current.data, defaultBranch },
        },
      };
    });
  };

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">工作区</h2>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setShowAddDialog(true)}>
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
        <ul className="space-y-2">
          {workspaces.map((ws: ControllerWorkspaceData) => (
            <li key={ws.id} className="rounded-lg border">
              <div className="flex items-center gap-2 p-3">
                <button
                  type="button"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={() => handleExpand(ws.id)}
                >
                  {expandedId === ws.id ? (
                    <ChevronDownIcon className="size-4" />
                  ) : (
                    <ChevronRightIcon className="size-4" />
                  )}
                </button>
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
              </div>

              {expandedId === ws.id && (
                <div className="border-t px-3 py-3">
                  {gitStates[ws.id]?.loading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <LoaderIcon className="size-4 animate-spin" />
                      检测 Git 状态中...
                    </div>
                  ) : gitStates[ws.id]?.error ? (
                    <div className="text-sm text-destructive">
                      {gitStates[ws.id].error}
                    </div>
                  ) : gitStates[ws.id]?.data?.isGitRepo ? (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-sm">
                        <GitBranchIcon className="size-4 text-muted-foreground" />
                        <span className="text-muted-foreground">当前分支:</span>
                        <span className="font-medium">{gitStates[ws.id].data?.currentBranch}</span>
                      </div>
                      <div className="space-y-1">
                        <span className="text-xs text-muted-foreground">默认分支</span>
                        <Select
                          value={gitStates[ws.id]?.data?.defaultBranch}
                          onValueChange={(value) => handleDefaultBranchChange(ws.id, value)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="选择分支..." />
                            <SelectIcon />
                          </SelectTrigger>
                          <SelectPopup>
                            {(gitStates[ws.id]?.data?.branches ?? []).map((branch) => (
                              <SelectItem key={branch} value={branch}>
                                <SelectItemText>{branch}</SelectItemText>
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      </div>
                    </div>
                  ) : gitStates[ws.id]?.data ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-sm text-muted-foreground">该目录不是 Git 仓库</p>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleInitGit(ws)}
                        disabled={!controllerOnline}
                        className="self-start"
                      >
                        初始化 Git 仓库
                      </Button>
                    </div>
                  ) : null}
                </div>
              )}
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

      <AddWorkspaceDialog
        controllerId={controllerId}
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        onSelect={handleAdd}
      />

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
