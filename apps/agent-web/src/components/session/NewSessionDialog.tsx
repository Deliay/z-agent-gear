import { useState, useEffect } from 'react';
import { useQuery, useLazyQuery } from '@apollo/client/react';
import { GET_ACP_CAPABILITIES, GET_CONTROLLER_WORKSPACES_ENABLED, DETECT_GIT_REPO, GET_MCP_SERVERS } from '../../graphql/queries';
import type { ControllerWorkspaceData, GitRepoInfoData } from '../../graphql/types';
import {
  Select as SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectIcon,
  SelectPopup,
  SelectItem,
  SelectItemText,
} from '../../components/ui/select';

interface Controller {
  id: string;
  name: string;
  status: string;
}

interface AcpCapability {
  type: string;
  available: boolean;
  version?: string;
}

interface McpServer {
  id: string;
  name: string;
  transport: string;
  source: string;
  enabled: boolean;
  status: string;
}

interface GetMcpServersData {
  mcpServers: McpServer[];
}

interface NewSessionDialogProps {
  controllers: Controller[];
  onClose: () => void;
  onCreate: (controllerId: string, acpServerType: string, workspaceId: string, enableWorktree?: boolean, worktreeBranchSuffix?: string, mcpServerIds?: string[]) => void;
  existingWorktreePath?: string;
  existingControllerId?: string;
  existingWorkspaceId?: string;
}

export default function NewSessionDialog({
  controllers,
  onClose,
  onCreate,
  existingWorktreePath,
  existingControllerId,
  existingWorkspaceId,
}: NewSessionDialogProps) {
  const isPreselected = Boolean(existingWorktreePath && existingControllerId && existingWorkspaceId);
  const [selectedController, setSelectedController] = useState<string>(existingControllerId ?? '');
  const [selectedAcpServer, setSelectedAcpServer] = useState<string>('');
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>(existingWorkspaceId ?? '');
  const [selectedMcpServerIds, setSelectedMcpServerIds] = useState<string[]>([]);
  const [mcpSearch, setMcpSearch] = useState('');
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [enableWorktree, setEnableWorktree] = useState(false);
  const [branchSuffix, setBranchSuffix] = useState('');
  const [detectGitRepo] = useLazyQuery<{ detectGitRepo: GitRepoInfoData }>(DETECT_GIT_REPO, {
    fetchPolicy: 'network-only',
  });

  const onlineControllers = controllers.filter((c) => c.status === 'online');

  const { data: mcpData } = useQuery<GetMcpServersData>(GET_MCP_SERVERS);

  const enabledMcpServers = (mcpData?.mcpServers ?? []).filter((s) => s.enabled);
  const filteredMcpServers = mcpSearch
    ? enabledMcpServers.filter((s) => s.name.toLowerCase().includes(mcpSearch.toLowerCase()))
    : enabledMcpServers;

  const { data: acpData, loading: acpLoading } = useQuery<{ acpCapabilities: AcpCapability[] }>(
    GET_ACP_CAPABILITIES,
    {
      variables: { controllerId: selectedController },
      skip: !selectedController,
    },
  );

  const { data: wsData, loading: wsLoading } = useQuery<{ controllerWorkspaces: ControllerWorkspaceData[] }>(
    GET_CONTROLLER_WORKSPACES_ENABLED,
    {
      variables: { controllerId: selectedController },
      skip: !selectedController,
    },
  );

  const acpServers = acpData?.acpCapabilities?.filter((s) => s.available) ?? [];
  const workspaces = wsData?.controllerWorkspaces ?? [];

  // Auto-select first available ACP server
  useEffect(() => {
    if (acpServers.length > 0 && !selectedAcpServer) {
      setSelectedAcpServer(acpServers[0].type);
    }
  }, [acpServers, selectedAcpServer]);

  // Auto-select first enabled workspace (skip if preselected)
  useEffect(() => {
    if (!isPreselected && workspaces.length > 0 && !selectedWorkspace) {
      setSelectedWorkspace(workspaces[0].id);
    }
  }, [workspaces, selectedWorkspace, isPreselected]);

  // Detect Git repo when workspace is selected
  useEffect(() => {
    if (isPreselected) {
      setIsGitRepo(true);
      return;
    }
    if (selectedWorkspace && selectedController) {
      setIsGitRepo(false);
      setEnableWorktree(false);
      detectGitRepo({
        variables: { controllerId: selectedController, workspaceId: selectedWorkspace },
      }).then((res) => {
        if (res.data?.detectGitRepo?.isGitRepo) {
          setIsGitRepo(true);
          const ws = workspaces.find((w) => w.id === selectedWorkspace);
          if (ws) {
            const defaultSuffix = `feat-${Math.random().toString(36).slice(2, 8)}`;
            setBranchSuffix(defaultSuffix);
          }
        }
      });
    }
  }, [selectedWorkspace, selectedController, detectGitRepo, workspaces, isPreselected]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedController && selectedAcpServer && selectedWorkspace) {
      onCreate(
        selectedController,
        selectedAcpServer,
        selectedWorkspace,
        enableWorktree,
        enableWorktree ? branchSuffix : undefined,
        selectedMcpServerIds.length > 0 ? selectedMcpServerIds : undefined,
      );
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg bg-card p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold text-foreground">新建会话</h2>
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label htmlFor="controller" className="mb-2 block text-sm font-medium text-card-foreground">
              控制器
            </label>
            <select
              id="controller"
              value={selectedController}
              onChange={(e) => {
                setSelectedController(e.target.value);
                setSelectedAcpServer('');
                setSelectedWorkspace('');
              }}
              disabled={isPreselected}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
              required
            >
              <option value="">选择控制器</option>
              {onlineControllers.map((controller) => (
                <option key={controller.id} value={controller.id}>
                  {controller.name}
                </option>
              ))}
            </select>
            {onlineControllers.length === 0 && (
              <p className="mt-1 text-sm text-destructive">无在线控制器</p>
            )}
          </div>

          {selectedController && (
            <div className="mb-4">
              <label className="mb-2 block text-sm font-medium text-card-foreground">
                ACP 服务
              </label>
              {acpLoading ? (
                <p className="text-sm text-muted-foreground">检测 ACP 服务中...</p>
              ) : (
                <SelectRoot
                  value={selectedAcpServer}
                  onValueChange={(value) => setSelectedAcpServer(value || '')}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue>
                      {selectedAcpServer || '选择 ACP 服务'}
                    </SelectValue>
                    <SelectIcon />
                  </SelectTrigger>
                  <SelectPopup>
                    {(acpServers.length > 0 ? acpServers : [{ type: 'opencode', available: true, version: undefined }]).map((server) => (
                      <SelectItem key={server.type} value={server.type}>
                        <SelectItemText>
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">{server.type}</span>
                            {server.version && (
                              <span className="text-xs text-muted-foreground">v{server.version}</span>
                            )}
                          </div>
                        </SelectItemText>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </SelectRoot>
              )}
            </div>
          )}

          {selectedController && (
            <div className="mb-6">
              <label className="mb-2 block text-sm font-medium text-card-foreground">
                工作目录
              </label>
              {wsLoading ? (
                <p className="text-sm text-muted-foreground">加载工作区中...</p>
              ) : workspaces.length === 0 ? (
                <div className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                  暂无工作区，请先在设置中管理工作区
                </div>
              ) : (
                <SelectRoot
                  value={selectedWorkspace}
                  onValueChange={(value) => setSelectedWorkspace(value || '')}
                  disabled={isPreselected}
                >
                  <SelectTrigger className={`w-full${isPreselected ? ' opacity-50 cursor-not-allowed' : ''}`}>
                    <SelectValue>
                      {selectedWorkspace
                        ? workspaces.find((w) => w.id === selectedWorkspace)?.name || selectedWorkspace
                        : '选择工作区'}
                    </SelectValue>
                    <SelectIcon />
                  </SelectTrigger>
                  <SelectPopup>
                    {workspaces.map((ws) => (
                      <SelectItem key={ws.id} value={ws.id}>
                        <SelectItemText>
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">{ws.name}</span>
                            <span className="text-xs text-muted-foreground">{ws.path}</span>
                          </div>
                        </SelectItemText>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </SelectRoot>
              )}
            </div>
          )}

          {isGitRepo && !isPreselected && (
            <div className="mb-6 rounded-md border p-3">
              <div className="mb-2 block text-sm font-medium text-card-foreground">
                Worktree 设置
              </div>
              <label className="flex cursor-pointer items-center gap-2 mb-3">
                <input
                  type="checkbox"
                  checked={enableWorktree}
                  onChange={(e) => setEnableWorktree(e.target.checked)}
                  className="h-4 w-4"
                />
                <span className="text-sm text-foreground">启用 Git Worktree 隔离工作目录</span>
              </label>
              {enableWorktree && (
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">分支名称</label>
                  <div className="mb-1 text-sm text-muted-foreground">
                    {workspaces.find((w) => w.id === selectedWorkspace)?.name || ''}/
                  </div>
                  <input
                    type="text"
                    value={branchSuffix}
                    onChange={(e) => setBranchSuffix(e.target.value)}
                    className="w-full rounded-md border px-2 py-1.5 text-sm text-foreground"
                    placeholder="分支后缀"
                  />
                </div>
              )}
            </div>
          )}

          {selectedController && enabledMcpServers.length > 0 && (
            <div className="mb-6">
              <label className="mb-2 block text-sm font-medium text-card-foreground">
                MCP 服务（可选，默认不装配）
              </label>
              <div className="rounded-md border border-border p-3">
                {enabledMcpServers.length > 8 && (
                  <input
                    type="text"
                    value={mcpSearch}
                    onChange={(e) => setMcpSearch(e.target.value)}
                    className="mb-2 w-full rounded-md border px-2 py-1.5 text-sm text-foreground"
                    placeholder="搜索 MCP 服务"
                  />
                )}
                <div className="max-h-40 space-y-1 overflow-y-auto">
                  {filteredMcpServers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">无匹配的 MCP 服务</p>
                  ) : (
                    filteredMcpServers.map((server) => (
                      <label key={server.id} className="flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selectedMcpServerIds.includes(server.id)}
                          onChange={(e) => {
                            setSelectedMcpServerIds((prev) =>
                              e.target.checked
                                ? [...prev, server.id]
                                : prev.filter((id) => id !== server.id),
                            );
                          }}
                          className="h-4 w-4"
                        />
                        <span className="text-sm text-foreground">{server.name}</span>
                        {server.source === 'platform' && (
                          <span className="text-xs text-muted-foreground">平台内置</span>
                        )}
                      </label>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-input bg-background px-4 py-2 text-sm text-card-foreground hover:bg-accent"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={!selectedController || !selectedAcpServer || !selectedWorkspace}
              className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              创建会话
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
