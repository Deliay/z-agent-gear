import { useState, useEffect } from 'react';
import { useQuery, useLazyQuery } from '@apollo/client/react';
import { GET_ACP_CAPABILITIES, GET_CONTROLLER_WORKSPACES_ENABLED, DETECT_GIT_REPO } from '../../graphql/queries';
import type { ControllerWorkspaceData, GitRepoInfoData } from '../../graphql/types';

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

interface NewSessionDialogProps {
  controllers: Controller[];
  onClose: () => void;
  onCreate: (controllerId: string, acpServerType: string, workspaceId: string, enableWorktree?: boolean, worktreeBranchSuffix?: string) => void;
}

export default function NewSessionDialog({ controllers, onClose, onCreate }: NewSessionDialogProps) {
  const [selectedController, setSelectedController] = useState<string>('');
  const [selectedAcpServer, setSelectedAcpServer] = useState<string>('');
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>('');
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [enableWorktree, setEnableWorktree] = useState(false);
  const [branchSuffix, setBranchSuffix] = useState('');
  const [detectGitRepo] = useLazyQuery<{ detectGitRepo: GitRepoInfoData }>(DETECT_GIT_REPO, {
    fetchPolicy: 'network-only',
  });

  const onlineControllers = controllers.filter((c) => c.status === 'online');

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

  // Auto-select first enabled workspace
  useEffect(() => {
    if (workspaces.length > 0 && !selectedWorkspace) {
      setSelectedWorkspace(workspaces[0].id);
    }
  }, [workspaces, selectedWorkspace]);

  // Detect Git repo when workspace is selected
  useEffect(() => {
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
  }, [selectedWorkspace, selectedController]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedController && selectedAcpServer && selectedWorkspace) {
      onCreate(selectedController, selectedAcpServer, selectedWorkspace, enableWorktree, enableWorktree ? branchSuffix : undefined);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg bg-card p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold text-foreground">New Session</h2>
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label htmlFor="controller" className="mb-2 block text-sm font-medium text-card-foreground">
              Controller
            </label>
            <select
              id="controller"
              value={selectedController}
              onChange={(e) => {
                setSelectedController(e.target.value);
                setSelectedAcpServer('');
                setSelectedWorkspace('');
              }}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              required
            >
              <option value="">Select a controller</option>
              {onlineControllers.map((controller) => (
                <option key={controller.id} value={controller.id}>
                  {controller.name}
                </option>
              ))}
            </select>
            {onlineControllers.length === 0 && (
              <p className="mt-1 text-sm text-destructive">No online controllers available</p>
            )}
          </div>

          {selectedController && (
            <div className="mb-4">
              <div className="mb-2 block text-sm font-medium text-card-foreground">
                ACP Server
              </div>
              {acpLoading ? (
                <p className="text-sm text-muted-foreground">Detecting ACP servers...</p>
              ) : (
                <div className="space-y-2">
                  {(acpServers.length > 0 ? acpServers : [{ type: 'opencode', available: true }]).map((server) => (
                    <label
                      key={server.type}
                      className={`flex cursor-pointer items-center gap-3 rounded-md border p-3 ${
                        selectedAcpServer === server.type
                          ? 'border-blue-500 bg-accent'
                          : 'border-border bg-card hover:bg-accent/50'
                      }`}
                    >
                      <input
                        type="radio"
                        name="acp-server"
                        value={server.type}
                        checked={selectedAcpServer === server.type}
                        onChange={(e) => setSelectedAcpServer(e.target.value)}
                        className="h-4 w-4 text-blue-600"
                      />
                      <div>
                        <span className="text-sm font-medium text-card-foreground">{server.type}</span>
                        {server.version && (
                          <span className="ml-2 text-xs text-muted-foreground">v{server.version}</span>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {selectedController && (
            <div className="mb-6">
              <div className="mb-2 block text-sm font-medium text-card-foreground">
                Working Directory
              </div>
              {wsLoading ? (
                <p className="text-sm text-muted-foreground">Loading workspaces...</p>
              ) : workspaces.length === 0 ? (
                <div className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                  暂无工作区，请先在设置中管理工作区
                </div>
              ) : (
                <div className="space-y-2">
                  {workspaces.map((ws) => (
                    <label
                      key={ws.id}
                      className={`flex cursor-pointer items-center gap-3 rounded-md border p-3 ${
                        selectedWorkspace === ws.id
                          ? 'border-blue-500 bg-accent'
                          : 'border-border bg-card hover:bg-accent/50'
                      }`}
                    >
                      <input
                        type="radio"
                        name="workspace"
                        value={ws.id}
                        checked={selectedWorkspace === ws.id}
                        onChange={(e) => setSelectedWorkspace(e.target.value)}
                        className="h-4 w-4 text-blue-600"
                      />
                      <div>
                        <span className="text-sm font-medium text-card-foreground">{ws.name}</span>
                        <div className="text-xs text-muted-foreground">{ws.path}</div>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {isGitRepo && (
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
                <span className="text-sm">启用 Git Worktree 隔离工作目录</span>
              </label>
              {enableWorktree && (
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">分支名称</label>
                  <div className="flex items-center gap-0">
                    <span className="rounded-l-md border border-r-0 bg-muted px-2 py-1.5 text-sm text-muted-foreground">
                      {workspaces.find((w) => w.id === selectedWorkspace)?.name || ''}/
                    </span>
                    <input
                      type="text"
                      value={branchSuffix}
                      onChange={(e) => setBranchSuffix(e.target.value)}
                      className="w-full rounded-r-md border px-2 py-1.5 text-sm text-foreground"
                      placeholder="分支后缀"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-input bg-background px-4 py-2 text-sm text-card-foreground hover:bg-accent"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!selectedController || !selectedAcpServer || !selectedWorkspace}
              className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Create Session
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
