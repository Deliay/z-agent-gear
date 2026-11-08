import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useMutation } from '@apollo/client/react';
import { GET_CONTROLLER_WORKSPACES, GET_SESSIONS, GET_WORKSPACES, GET_ACP_CAPABILITIES } from '../../graphql/queries';
import { CREATE_WORKSPACE, DELETE_WORKSPACE, CLEAR_WORKSPACES, TOGGLE_WORKSPACE, INIT_GIT_REPO, SET_WORKSPACE_DEFAULT_BRANCH, SET_CONTROLLER_WORKTREE_DIR, WORKSPACE_ARCHIVE_IMPACT } from '../../graphql/mutations';
import type { GetControllerWorkspacesQuery, GetAcpCapabilitiesQuery, ControllerWorkspaceData, GitRepoInfoData, CreateWorkspaceMutation, WorkspaceArchiveImpactQuery } from '../../graphql/types';
import { getApiBase } from '../../lib/api-base';
import { Button } from '@/components/ui/button';
import HistorySessionDialog from './HistorySessionDialog';
import AddWorkspaceDialog from './AddWorkspaceDialog';
import DirectoryPicker from '@/components/ui/DirectoryPicker';
import { ChevronDownIcon, ChevronRightIcon, GitBranchIcon, GitForkIcon, LoaderIcon } from 'lucide-react';
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
  /** 手工新增工作目录成功（refetch 完成）后的可选回调；普通主机与设置页不传（零行为变化） */
  onWorkspaceCreated?: (workspace: { id: string }) => void;
}

/** 会话/工作区列表刷新（纯常量，供各操作的 refetchQueries 复用） */
const refetchSessions = () => ({ query: GET_SESSIONS });
const refetchWorkspaces = () => ({ query: GET_WORKSPACES });

export default function WorkspaceSection({ controllerId, controllerOnline = false, onWorkspaceCreated }: WorkspaceSectionProps) {
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [historyWorkspace, setHistoryWorkspace] = useState<{ id: string; name: string } | null>(null);
  /** 单删前置 impact 进行中标记（防重复点击）；结果分流 N>0 确认 / N=0 或取数失败直接删除 */
  const impactPendingRef = useRef(false);
  /** N>0 时的删除确认框（含连带归档会话数量） */
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; count: number } | null>(null);
  /** 清空确认的连带归档合计（key=workspaceId；null=取数失败降级不展示数量） */
  const [clearCounts, setClearCounts] = useState<Record<string, number | null>>({});
  const [gitStates, setGitStates] = useState<Record<string, {
    loading: boolean;
    data?: GitRepoInfoData;
    error?: string;
  }>>({});
  const [showWorktreeDirPicker, setShowWorktreeDirPicker] = useState(false);
  const [worktreeDir, setWorktreeDir] = useState<string | null>(null);

  const { data, loading, refetch } = useQuery<GetControllerWorkspacesQuery>(GET_CONTROLLER_WORKSPACES, {
    variables: { controllerId },
  });

  const { data: acpCapData } = useQuery<GetAcpCapabilitiesQuery>(GET_ACP_CAPABILITIES, {
    variables: { controllerId },
    skip: !controllerOnline,
  });
  const availableAcpServers = (acpCapData?.acpCapabilities?.filter((c) => c.available) ?? []).map((c) => ({ type: c.type, version: c.version ?? undefined }));

  const [createWorkspace] = useMutation<CreateWorkspaceMutation>(CREATE_WORKSPACE);
  const [deleteWorkspace] = useMutation(DELETE_WORKSPACE);
  const [clearWorkspaces] = useMutation(CLEAR_WORKSPACES);
  const [toggleWorkspace] = useMutation(TOGGLE_WORKSPACE);
  const [initGitRepo] = useMutation(INIT_GIT_REPO);
  const [setWorkspaceDefaultBranch] = useMutation(SET_WORKSPACE_DEFAULT_BRANCH);
  const [setControllerWorktreeDir] = useMutation(SET_CONTROLLER_WORKTREE_DIR);

  // 单删前置 impact 预查询：契约（contracts/agent-session.graphql）将其放在 Mutation，
  // 必须经 useMutation 执行（useQuery 会因 Cannot query field 直接失败并静默降级为不弹确认）。
  const [runWorkspaceArchiveImpact] = useMutation<WorkspaceArchiveImpactQuery>(WORKSPACE_ARCHIVE_IMPACT);

  const refetchWorktreeDir = async () => {
    try {
      const apiBase = getApiBase();
      const token = localStorage.getItem('auth_token');
      const result = await fetch(`${apiBase}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          query: `query GetController($id: ID!) { controller(id: $id) { worktreeDir } }`,
          variables: { id: controllerId },
        }),
      });
      const json = await result.json();
      if (json.data?.controller) {
        setWorktreeDir(json.data.controller.worktreeDir || null);
      }
    } catch {
      // ignore error
    }
  };

  useEffect(() => {
    if (controllerId) {
      refetchWorktreeDir();
    }
  }, [controllerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleWorktreeDirChange = async (path: string) => {
    await setControllerWorktreeDir({
      variables: { controllerId, worktreeDir: path },
    });
    setWorktreeDir(path);
    setShowWorktreeDirPicker(false);
  };

  const workspaces = data?.controllerWorkspaces ?? [];

  /** 清空连带归档合计：全部工作区取数成功才展示，任一失败降级为不展示数量 */
  const clearSessionCount = sumClearCounts(workspaces, clearCounts);

  const handleAdd = async (path: string) => {
    const { data } = await createWorkspace({
      variables: { input: { controllerId, path } },
      refetchQueries: [refetchSessions(), refetchWorkspaces()],
    });
    await refetch();
    setShowAddDialog(false);

    // 即时 Git 发现：创建成功后立即触发 detectGitRepo
    const newWorkspaceId = data?.createWorkspace?.id;
    if (newWorkspaceId) {
      onWorkspaceCreated?.({ id: newWorkspaceId });
      setGitStates((prev) => ({ ...prev, [newWorkspaceId]: { loading: true } }));
      try {
        const gitData = await refetchGitState(newWorkspaceId);
        setGitStates((prev) => ({
          ...prev,
          [newWorkspaceId]: { loading: false, data: gitData },
        }));
      } catch (err) {
        // 发现失败不阻塞添加，条目维持「未发现」状态，展开时按现有逻辑可重试
        setGitStates((prev) => ({
          ...prev,
          [newWorkspaceId]: { loading: false, error: (err as Error).message },
        }));
      }
    }
  };

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteWorkspace({
        variables: { id },
        refetchQueries: [refetchSessions(), refetchWorkspaces()],
      });
      await refetch();
    },
    [deleteWorkspace, refetch],
  );

  /** 点击「删除」：先取连带归档数量（N>0 弹确认框；N=0/取数失败按「不阻断」降级为直接删除） */
  const handleDeleteClick = async (id: string) => {
    if (impactPendingRef.current) return;
    impactPendingRef.current = true;
    let count: number | null;
    try {
      const result = await runWorkspaceArchiveImpact({ variables: { id } });
      count = result?.data?.workspaceArchiveImpact?.sessionCount ?? null;
    } catch {
      count = null;
    } finally {
      impactPendingRef.current = false;
    }
    if (count != null && count > 0) {
      setDeleteConfirm({ id, count });
    } else {
      void handleDelete(id);
    }
  };

  /** 清空确认：打开时重置合计并逐工作区取连带归档数量（任一失败则降级不展示数量） */
  const handleClearClick = () => {
    setClearCounts({});
    setConfirmClear(true);
  };

  const handleClearImpactResult = useCallback((id: string, count: number | null) => {
    setClearCounts((prev) => (prev[id] === count ? prev : { ...prev, [id]: count }));
  }, []);

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
    const apiBase = getApiBase();
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

  const handleDefaultBranchChange = async (wsId: string, defaultBranch: string | null) => {
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
      <div className="mb-4 rounded-lg border p-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-1.5">
              <GitForkIcon className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium">Git Worktree 工作目录</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {worktreeDir || '~/.zag/worktrees（默认）'}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              注：`~` 指控制器本机用户主目录，默认目录与后端生效默认值保持一致。
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowWorktreeDirPicker(true)}
          >
            修改
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">工作区</h2>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setShowAddDialog(true)}>
            添加
          </Button>
          {workspaces.length > 0 && (
            <Button size="sm" variant="outline" onClick={handleClearClick}>
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
                  className={`h-4 w-4 rounded shrink-0 ${ws.isEnabled ? 'bg-success' : 'bg-muted-foreground'}`}
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
                  onClick={() => handleDeleteClick(ws.id)}
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
          {clearSessionCount != null && clearSessionCount > 0 && (
            <p className="mb-3 text-sm text-muted-foreground" data-testid="clear-archive-impact">
              将同时归档其下 {clearSessionCount} 个会话
            </p>
          )}
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

      {/* 清空确认的连带归档数量探针：逐工作区取数，任一失败降级为不展示数量（不阻断确认） */}
      {confirmClear && workspaces.map((ws) => (
        <WorkspaceArchiveImpactProbe
          key={ws.id}
          workspaceId={ws.id}
          onResult={handleClearImpactResult}
        />
      ))}

      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg bg-card p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold">删除工作区</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              删除工作区将同时归档其下 {deleteConfirm.count} 个会话，是否继续？
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDeleteConfirm(null)}>
                取消
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  const { id } = deleteConfirm;
                  setDeleteConfirm(null);
                  void handleDelete(id);
                }}
              >
                确认删除
              </Button>
            </div>
          </div>
        </div>
      )}

      {showWorktreeDirPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg bg-card p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold">选择 Worktree 工作目录</h2>
            <p className="mb-4 text-sm text-muted-foreground">所有 Git Worktree 将创建在此目录下</p>
            <DirectoryPicker
              controllerId={controllerId}
              onSelect={handleWorktreeDirChange}
              onClose={() => setShowWorktreeDirPicker(false)}
            />
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
        availableAcpServers={availableAcpServers}
      />
    </>
  );
}

/** 清空连带归档合计：全部工作区取数成功才给出数量，任一缺失/失败返回 null（降级不展示数量） */
function sumClearCounts(
  workspaces: ReadonlyArray<{ id: string }>,
  counts: Record<string, number | null>,
): number | null {
  if (workspaces.length === 0) return null;
  let total = 0;
  for (const workspace of workspaces) {
    const count = counts[workspace.id];
    if (count == null) return null;
    total += count;
  }
  return total;
}

/** 单工作区归档影响探针：经 Mutation 取连带归档会话数并回调一次（null = 取数失败，降级不展示数量） */
function WorkspaceArchiveImpactProbe({
  workspaceId,
  onResult,
}: {
  workspaceId: string;
  onResult: (workspaceId: string, count: number | null) => void;
}) {
  const [runImpact] = useMutation<WorkspaceArchiveImpactQuery>(WORKSPACE_ARCHIVE_IMPACT);
  const reportedRef = useRef(false);

  useEffect(() => {
    if (reportedRef.current) return;
    reportedRef.current = true;
    // 探针只回调一次：成功取数回传数量，失败/异常回传 null（降级不展示数量）
    void (async () => {
      try {
        const result = await runImpact({ variables: { id: workspaceId } });
        onResult(workspaceId, result?.data?.workspaceArchiveImpact?.sessionCount ?? null);
      } catch {
        onResult(workspaceId, null);
      }
    })();
  }, [workspaceId, onResult, runImpact]);

  return null;
}
