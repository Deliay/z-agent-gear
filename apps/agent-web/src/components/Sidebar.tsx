import { useState } from 'react';
import { NavLink, useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@apollo/client/react';
import { GET_SESSIONS, GET_CONTROLLERS, GET_WORKSPACES } from '../graphql/queries';
import { CREATE_SESSION } from '../graphql/mutations';
import type {
  GetSessionsQuery,
  GetControllersQuery,
  GetWorkspacesQuery,
  CreateSessionMutation,
  SessionData,
} from '../graphql/types';
import NewSessionDialog from './session/NewSessionDialog';
import { getStatusDotColor } from './session/status-colors';
import { TodoListPanel } from './TodoListPanel';
import ThemeToggle from './ThemeToggle';
import GatewaySection from './GatewaySection';
import { Button } from './ui/button';
import {
  ChevronDown,
  ChevronRight,
  Settings,
  GitFork,
  FolderOpen,
  Plus,
} from 'lucide-react';

interface SidebarProps {
  username: string;
  mobile?: boolean;
}

export default function Sidebar({ username, mobile }: SidebarProps) {
  const { id: activeId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [expandedControllers, setExpandedControllers] = useState<Set<string>>(new Set());
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(new Set());
  const [showNewDialog, setShowNewDialog] = useState(false);

  const { data: sessionsData } = useQuery<GetSessionsQuery>(GET_SESSIONS, {
    pollInterval: 15000,
  });
  const { data: controllersData } = useQuery<GetControllersQuery>(GET_CONTROLLERS, {
    pollInterval: 15000,
  });
  const { data: workspacesData } = useQuery<GetWorkspacesQuery>(GET_WORKSPACES, {
    pollInterval: 15000,
  });

  const [createSession] = useMutation<CreateSessionMutation>(CREATE_SESSION);

  const sessions = sessionsData?.sessions ?? [];
  const controllers = controllersData?.controllers ?? [];
  const allWorkspaces = workspacesData?.workspaces ?? [];

  const getWorkspacePath = (session: SessionData): string => {
    if (session.worktreePath) {
      const parts = session.worktreePath.split('/').filter(Boolean);
      const wsName = parts[parts.length - 2];
      const ws = allWorkspaces.find(
        (w) => w.name === wsName && w.controllerId === session.controllerId,
      );
      return ws?.path || wsName || session.cwd || '';
    }
    return session.cwd || '';
  };

  const getWorkspacePaths = (controllerId: string) => {
    const fromSessions = new Set(
      sessions
        .filter((s) => s.controllerId === controllerId)
        .map((s) => getWorkspacePath(s))
        .filter(Boolean),
    );
    const fromConfig = new Set(
      allWorkspaces
        .filter((w) => w.controllerId === controllerId && w.isEnabled)
        .map((w) => w.path),
    );
    return new Set([...fromSessions, ...fromConfig]);
  };

  const handleCreateSession = async (
    controllerId: string,
    acpServerType: string,
    workspaceId: string,
    enableWorktree?: boolean,
    worktreeBranchSuffix?: string,
  ) => {
    try {
      const { data } = await createSession({
        variables: {
          input: {
            controllerId,
            acpServerType,
            workspaceId,
            enableWorktree: enableWorktree || false,
            worktreeBranchSuffix: worktreeBranchSuffix || null,
          },
        },
        refetchQueries: [{ query: GET_SESSIONS }],
      });
      if (data?.createSession?.session?.id) {
        navigate(`/sessions/${data.createSession.session.id}`);
        setShowNewDialog(false);
      }
    } catch (error) {
      console.error('Failed to create session:', error);
    }
  };

  // Group sessions by controllerId + workspace path
  const sessionsByController = new Map<string, typeof sessions>();
  const sessionsByWorkspace = new Map<string, typeof sessions>();

  for (const session of sessions) {
    // Group by controller
    const controllerSessions = sessionsByController.get(session.controllerId) || [];
    controllerSessions.push(session);
    sessionsByController.set(session.controllerId, controllerSessions);

    // Group by workspace (resolve worktree sessions to original workspace)
    const wsPath = getWorkspacePath(session);
    if (wsPath) {
      const workspaceKey = `${session.controllerId}:${wsPath}`;
      const workspaceSessions = sessionsByWorkspace.get(workspaceKey) || [];
      workspaceSessions.push(session);
      sessionsByWorkspace.set(workspaceKey, workspaceSessions);
    }
  }

  const toggleController = (controllerId: string) => {
    setExpandedControllers((prev) => {
      const next = new Set(prev);
      if (next.has(controllerId)) {
        next.delete(controllerId);
      } else {
        next.add(controllerId);
      }
      return next;
    });
  };

  const toggleWorkspace = (workspaceKey: string) => {
    setExpandedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(workspaceKey)) {
        next.delete(workspaceKey);
      } else {
        next.add(workspaceKey);
      }
      return next;
    });
  };

  const getWorkspaceName = (path: string) => {
    return path.split('/').filter(Boolean).pop() || path;
  };

  return (
    <nav className={`flex flex-col bg-sidebar text-sidebar-foreground ${mobile ? 'h-full' : 'h-screen'}`} aria-label="Sidebar">
      <div className="flex-1 overflow-y-auto p-4">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">会话</h2>
          <Button size="xs" onClick={() => setShowNewDialog(true)}>
            <Plus className="size-3" />
            新建
          </Button>
        </div>

        <ul className="space-y-1">
          {controllers.map((controller) => {
            const isExpanded = expandedControllers.has(controller.id);
            const isOffline = controller.status !== 'online';

            // Get unique workspace paths for this controller
            const workspacePaths = getWorkspacePaths(controller.id);

            return (
              <li key={controller.id}>
                <button
                  type="button"
                  className={`flex w-full items-center gap-2 rounded px-3 py-2 text-sm transition-colors hover:bg-sidebar-accent ${
                    isOffline ? 'opacity-50' : ''
                  }`}
                  onClick={() => toggleController(controller.id)}
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${
                    controller.status === 'online' ? 'bg-success' : 'bg-muted-foreground'
                  }`} />
                  <span className="flex-1 truncate text-left font-medium">
                    {controller.name || controller.hostname}
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/settings?controllerId=${controller.id}`);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation();
                        navigate(`/settings?controllerId=${controller.id}`);
                      }
                    }}
                    className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
                    title="控制器配置"
                  >
                    <Settings className="size-3.5" />
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                  </span>
                </button>

                {isExpanded && (
                  <ul className="ml-4 space-y-1">
                    {controller.status === 'online' && (
                      <li>
                        <GatewaySection controllerId={controller.id} />
                      </li>
                    )}
                    {workspacePaths.size === 0 ? (
                      <li className="px-3 py-1 text-xs text-muted-foreground">无工作区</li>
                    ) : (
                      Array.from(workspacePaths).map((workspacePath) => {
                        const workspaceKey = `${controller.id}:${workspacePath}`;
                        const isWsExpanded = expandedWorkspaces.has(workspaceKey);
                        const wsSessions = sessionsByWorkspace.get(workspaceKey) || [];

                        return (
                          <li key={workspaceKey}>
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-sm transition-colors hover:bg-sidebar-accent"
                              onClick={() => toggleWorkspace(workspaceKey)}
                            >
                              <span className="text-xs text-muted-foreground">
                                {isWsExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                              </span>
                              <span className="flex-1 truncate text-left text-sidebar-foreground">
                                <FolderOpen className="size-3.5 inline" /> {getWorkspaceName(workspacePath)}
                              </span>
                            </button>

                            {isWsExpanded && (
                              <ul className="ml-4 space-y-1">
                                {wsSessions.map((session) => (
                                  <li key={session.id}>
                                    <NavLink
                                      to={`/sessions/${session.id}`}
                                      className={`flex items-center gap-2 rounded px-3 py-1.5 text-sm transition-colors ${
                                        activeId === session.id
                                          ? 'bg-sidebar-accent text-sidebar-foreground'
                                          : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground'
                                      }`}
                                    >
                                      <span className={`h-2 w-2 shrink-0 rounded-full ${getStatusDotColor(session.status)}`} />
                                      {session.worktreePath && (
                                        <GitFork className="size-3 shrink-0 text-info" />
                                      )}
                                      <div className="min-w-0 flex-1">
                                        <div className="truncate">
                                          {session.title || 'New Session'}
                                        </div>
                                      </div>
                                    </NavLink>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </li>
                        );
                      })
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {showNewDialog && (
        <NewSessionDialog
          controllers={controllers}
          onClose={() => setShowNewDialog(false)}
          onCreate={handleCreateSession}
        />
      )}

      {mobile && (
        <NavLink
          to="/settings"
          className="flex items-center gap-2 border-t border-sidebar-border px-4 py-3 text-sm text-sidebar-foreground hover:text-sidebar-foreground"
        >
          <Settings className="size-4" />
          <span>设置</span>
        </NavLink>
      )}

      <div className="sticky bottom-0 border-t border-sidebar-border p-4">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">{username}</span>
          <div className="flex items-center gap-1">
            <TodoListPanel />
            <ThemeToggle />
            <NavLink
              to="/settings"
              aria-label="Settings"
              className={({ isActive }) =>
                `rounded p-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                  isActive ? 'bg-sidebar-accent text-sidebar-foreground' : 'text-muted-foreground hover:text-sidebar-foreground'
                }`
              }
            >
              <Settings className="size-4" />
            </NavLink>
          </div>
        </div>
      </div>
    </nav>
  );
}
