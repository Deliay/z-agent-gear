import { useState, useEffect, useMemo, useRef } from 'react';
import { useQuery, useLazyQuery, useMutation } from '@apollo/client/react';
import {
  GET_ACP_CAPABILITIES,
  GET_ACP_SERVER_OPTIONS,
  GET_CONTROLLER_WORKSPACES_ENABLED,
  DETECT_GIT_REPO,
  GET_MCP_SERVERS,
} from '../../graphql/queries';
import { REFRESH_ACP_SERVER_OPTIONS } from '../../graphql/mutations';
import type {
  AcpServerOptionsData,
  CloudHostData,
  ControllerDefaultMcpData,
  ControllerWorkspaceData,
  GetAcpServerOptionsQuery,
  GitRepoInfoData,
  RefreshAcpServerOptionsMutation,
} from '../../graphql/types';
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
  /** cloud 类型主机携带云电脑；普通主机为 undefined/null */
  type?: string;
  cloudHost?: CloudHostData | null;
  /** 新建会话默认注入的 MCP（历史控制器归一为 useAllEnabled=true） */
  defaultMcp?: ControllerDefaultMcpData | null;
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
  onCreate: (
    controllerId: string,
    acpServerType: string,
    workspaceId: string,
    enableWorktree?: boolean,
    worktreeBranchSuffix?: string,
    mcpServerIds?: string[],
    existingWorktreePath?: string,
    modeId?: string,
    modelId?: string,
  ) => void;
  existingWorktreePath?: string;
  existingControllerId?: string;
  existingWorkspaceId?: string;
}

/** Radix Select 不接受空字符串 value；用哨兵表示「不传」 */
const DEFAULT_OPTION_VALUE = '__default__';
/** 云会话自动装配的平台 MCP，前端不作为可选项 */
const AGENT_CLOUD_HOST_TOOLS_MCP = 'agent-cloud-host-tools';

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
  const [selectedModeId, setSelectedModeId] = useState('');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [optionsOverride, setOptionsOverride] = useState<AcpServerOptionsData | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [workspacesRefreshError, setWorkspacesRefreshError] = useState(false);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [enableWorktree, setEnableWorktree] = useState(false);
  const [branchSuffix, setBranchSuffix] = useState('');
  // 默认 MCP 预选只在「打开 / 切换控制器」时计算一次，用户手动调整后不被后台刷新覆盖
  const mcpInitializedForRef = useRef<string | null>(null);
  const [detectGitRepo] = useLazyQuery<{ detectGitRepo: GitRepoInfoData }>(DETECT_GIT_REPO, {
    fetchPolicy: 'network-only',
  });

  const onlineControllers = controllers.filter(
    (c) =>
      c.status === 'online' &&
      (c.type !== 'cloud' || (c.cloudHost?.status === 'RUNNING' && !c.cloudHost.deletedAt)),
  );
  // 云电脑仅 RUNNING 可创建会话：当前选中/预选的云电脑不可用时给出提示
  const preselectedController = controllers.find((c) => c.id === existingControllerId);
  const preselectedControllerUnavailable =
    preselectedController?.type === 'cloud' &&
    !onlineControllers.some((c) => c.id === preselectedController?.id);
  const selectedControllerData = controllers.find((c) => c.id === selectedController);
  const selectedCloudHostUnavailable =
    selectedControllerData?.type === 'cloud' &&
    !onlineControllers.some((c) => c.id === selectedControllerData.id);
  const selectedControllerSelectable = onlineControllers.some((c) => c.id === selectedController);

  const { data: mcpData } = useQuery<GetMcpServersData>(GET_MCP_SERVERS);

  // 云会话由服务端自动并入 agent-cloud-host-tools，前端不作为可选项
  const enabledMcpServers = (mcpData?.mcpServers ?? []).filter(
    (s) => s.enabled && s.name !== AGENT_CLOUD_HOST_TOOLS_MCP,
  );
  const filteredMcpServers = mcpSearch
    ? enabledMcpServers.filter((s) => s.name.toLowerCase().includes(mcpSearch.toLowerCase()))
    : enabledMcpServers;
  const enabledMcpIds = useMemo(
    () => enabledMcpServers.map((s) => s.id),
    [enabledMcpServers],
  );

  const { data: acpData, loading: acpLoading } = useQuery<{ acpCapabilities: AcpCapability[] }>(
    GET_ACP_CAPABILITIES,
    {
      variables: { controllerId: selectedController },
      skip: !selectedController,
    },
  );

  const {
    data: wsData,
    loading: wsLoading,
    refetch: refetchWorkspaces,
  } = useQuery<{ controllerWorkspaces: ControllerWorkspaceData[] }>(
    GET_CONTROLLER_WORKSPACES_ENABLED,
    {
      variables: { controllerId: selectedController },
      skip: !selectedController,
      // 统一策略：缓存优先 + 打开/切控制器时后台刷新（Git 设置新增的工作区随即可见）
      fetchPolicy: 'cache-and-network',
    },
  );

  const acpServers = acpData?.acpCapabilities?.filter((s) => s.available) ?? [];
  const workspaces = wsData?.controllerWorkspaces ?? [];

  // 「+」打开 / 切换控制器时刷新工作区列表；失败保留旧列表并提示，不阻断提交
  useEffect(() => {
    if (!selectedController) return;
    setWorkspacesRefreshError(false);
    Promise.resolve(refetchWorkspaces?.())
      .then(() => setWorkspacesRefreshError(false))
      .catch(() => setWorkspacesRefreshError(true));
    // refetch 引用在 Apollo 中稳定；仅在控制器变化时刷新一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedController]);

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

  // 模式/模型：选定 ACP 服务后探测可选值（与工作流节点同源 acpServerOptions）
  const {
    data: optionsData,
    loading: optionsLoading,
  } = useQuery<GetAcpServerOptionsQuery>(GET_ACP_SERVER_OPTIONS, {
    variables: { controllerId: selectedController, acpServerType: selectedAcpServer },
    skip: !selectedController || !selectedAcpServer,
  });
  const [refreshOptions, { loading: refreshingOptions } = { loading: false }] =
    useMutation<RefreshAcpServerOptionsMutation>(REFRESH_ACP_SERVER_OPTIONS);

  // 切换控制器/ACP 服务时清空模式、模型与本地刷新结果
  useEffect(() => {
    setSelectedModeId('');
    setSelectedModelId('');
    setOptionsOverride(null);
    setOptionsError(null);
  }, [selectedController, selectedAcpServer]);

  const options = optionsOverride ?? optionsData?.acpServerOptions ?? null;
  const modes = options?.modes ?? [];
  const models = options?.models ?? [];
  const optionsProbing = Boolean(selectedAcpServer) && (optionsLoading || refreshingOptions);

  const handleRefreshOptions = async () => {
    if (!selectedController || !selectedAcpServer || refreshingOptions) return;
    setOptionsError(null);
    try {
      const { data } = await refreshOptions({
        variables: { controllerId: selectedController, acpServerType: selectedAcpServer },
      });
      if (data?.refreshAcpServerOptions) {
        setOptionsOverride(data.refreshAcpServerOptions);
      }
    } catch {
      setOptionsError('刷新失败，可重试');
    }
  };

  // 按控制器默认 MCP 预选：useAllEnabled → 全部已启用；否则取 serverIds 与已启用集合的交集
  useEffect(() => {
    if (!selectedController || mcpData === undefined) return;
    if (mcpInitializedForRef.current === selectedController) return;
    mcpInitializedForRef.current = selectedController;
    const configured = controllers.find((c) => c.id === selectedController)?.defaultMcp;
    if (!configured || configured.useAllEnabled !== false) {
      setSelectedMcpServerIds(enabledMcpIds);
      return;
    }
    setSelectedMcpServerIds(configured.serverIds.filter((id) => enabledMcpIds.includes(id)));
  }, [selectedController, mcpData, controllers, enabledMcpIds]);

  const selectedControllerUsesAllEnabledMcp =
    controllers.find((c) => c.id === selectedController)?.defaultMcp?.useAllEnabled !== false;

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
          const defaultSuffix = `feat-${Math.random().toString(36).slice(2, 8)}`;
          // C-16：后台workspaces 刷新不得覆盖用户已编辑的分支后缀
          setBranchSuffix((prev) => prev || defaultSuffix);
        }
      });
    }
    // workspaces 仅用于旧逻辑查找工作区名；不在依赖中，避免列表 refetch 重置 Worktree 开关
  }, [selectedWorkspace, selectedController, detectGitRepo, isPreselected]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedController && selectedAcpServer && selectedWorkspace) {
      onCreate(
        selectedController,
        selectedAcpServer,
        selectedWorkspace,
        enableWorktree,
        enableWorktree ? branchSuffix : undefined,
        // 显式传数组：空数组 = 不注入（undefined 才走控制器默认）
        selectedMcpServerIds,
        isPreselected ? existingWorktreePath : undefined,
        selectedModeId || undefined,
        selectedModelId || undefined,
      );
      onClose();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="新建会话"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    >
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
            {preselectedControllerUnavailable ? (
              <p className="mt-1 text-sm text-destructive" data-testid="cloud-host-unavailable-hint">
                该云电脑未运行，无法创建会话
              </p>
            ) : selectedCloudHostUnavailable ? (
              <p className="mt-1 text-sm text-muted-foreground" data-testid="cloud-host-unavailable-hint">
                云电脑未运行，暂不可创建会话
              </p>
            ) : null}
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

          {selectedController && selectedAcpServer && (
            <div className="mb-4 rounded-md border border-border p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-card-foreground">
                  模式与模型（可选）
                </span>
                <button
                  type="button"
                  onClick={() => { void handleRefreshOptions(); }}
                  disabled={optionsProbing}
                  className="rounded-md border border-input bg-background px-2 py-1 text-xs text-card-foreground hover:bg-accent disabled:opacity-50"
                >
                  {refreshingOptions ? '刷新中...' : '刷新'}
                </button>
              </div>
              <div className="space-y-3">
                <div>
                  <span className="mb-1 block text-xs text-muted-foreground">模式</span>
                  <SelectRoot
                    value={selectedModeId || DEFAULT_OPTION_VALUE}
                    onValueChange={(value) =>
                      setSelectedModeId(!value || value === DEFAULT_OPTION_VALUE ? '' : value)
                    }
                  >
                    <SelectTrigger className="w-full" aria-label="模式">
                      <SelectValue>
                        {selectedModeId
                          ? modes.find((m) => m.id === selectedModeId)?.name || selectedModeId
                          : '默认'}
                      </SelectValue>
                      <SelectIcon />
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value={DEFAULT_OPTION_VALUE}>
                        <SelectItemText>默认</SelectItemText>
                      </SelectItem>
                      {modes.map((mode) => (
                        <SelectItem key={mode.id} value={mode.id}>
                          <SelectItemText>{mode.name}</SelectItemText>
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </SelectRoot>
                </div>
                <div>
                  <span className="mb-1 block text-xs text-muted-foreground">模型</span>
                  <SelectRoot
                    value={selectedModelId || DEFAULT_OPTION_VALUE}
                    onValueChange={(value) =>
                      setSelectedModelId(!value || value === DEFAULT_OPTION_VALUE ? '' : value)
                    }
                  >
                    <SelectTrigger className="w-full" aria-label="模型">
                      <SelectValue>
                        {selectedModelId
                          ? models.find((m) => m.id === selectedModelId)?.name || selectedModelId
                          : '默认'}
                      </SelectValue>
                      <SelectIcon />
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value={DEFAULT_OPTION_VALUE}>
                        <SelectItemText>默认</SelectItemText>
                      </SelectItem>
                      {models.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          <SelectItemText>{model.name}</SelectItemText>
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </SelectRoot>
                </div>
              </div>
              {optionsProbing && (
                <p className="mt-2 text-xs text-muted-foreground">正在探测可选模式与模型…</p>
              )}
              {optionsError && (
                <p className="mt-2 text-xs text-destructive">{optionsError}</p>
              )}
            </div>
          )}

          {selectedController && (
            <div className="mb-6">
              <label className="mb-2 block text-sm font-medium text-card-foreground">
                工作目录
              </label>
              {wsLoading && !wsData ? (
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
                  <SelectTrigger
                    aria-label="工作区"
                    className={`w-full${isPreselected ? ' opacity-50 cursor-not-allowed' : ''}`}
                  >
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
              {workspacesRefreshError && (
                <p className="mt-1 text-xs text-muted-foreground">刷新失败，可重试</p>
              )}
            </div>
          )}

          {isPreselected && existingWorktreePath && (
            <div className="mb-6">
              <label className="mb-2 block text-sm font-medium text-card-foreground">
                Worktree 路径
              </label>
              <p className="rounded-md border border-input bg-muted px-3 py-2 text-sm text-muted-foreground break-all">
                {existingWorktreePath}
              </p>
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

          {selectedController && mcpData !== undefined && (
            <div className="mb-6">
              <label className="mb-2 block text-sm font-medium text-card-foreground">
                MCP 服务
              </label>
              <div className="rounded-md border border-border p-3">
                <p className="mb-2 text-xs text-muted-foreground">
                  {selectedControllerUsesAllEnabledMcp
                    ? '默认注入全部已启用的 MCP；可取消勾选'
                    : '按控制器默认设置预选，可调整；全部取消则不注入'}
                </p>
                {enabledMcpServers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">暂无已启用的 MCP 服务</p>
                ) : (
                  <>
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
                  </>
                )}
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
              disabled={!selectedController || !selectedAcpServer || !selectedWorkspace || !selectedControllerSelectable}
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
