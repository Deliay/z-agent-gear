import { useState } from 'react';
import { NavLink, useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@apollo/client/react';
import { GET_SESSIONS, GET_CONTROLLERS, GET_WORKSPACES } from '../graphql/queries';
import { CREATE_SESSION } from '../graphql/mutations';
import type { GetSessionsQuery, GetControllersQuery, GetWorkspacesQuery, CreateSessionMutation } from '../graphql/types';
import NewSessionDialog from './session/NewSessionDialog';

interface SidebarProps {
  username: string;
}

const statusColors: Record<string, string> = {
  running: 'bg-green-500',
  connecting: 'bg-yellow-500',
  creating: 'bg-yellow-500',
  ended: 'bg-gray-500',
};

export default function Sidebar({ username }: SidebarProps) {
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

  const getWorkspacePaths = (controllerId: string) => {
    const fromSessions = new Set(
      sessions
        .filter((s) => s.cwd && s.controllerId === controllerId)
        .map((s) => s.cwd!)
    );
    const fromConfig = new Set(
      allWorkspaces
        .filter((w) => w.controllerId === controllerId && w.isEnabled)
        .map((w) => w.path)
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

  // Group sessions by controllerId + cwd (workspace path)
  const sessionsByController = new Map<string, typeof sessions>();
  const sessionsByWorkspace = new Map<string, typeof sessions>();

  for (const session of sessions) {
    // Group by controller
    const controllerSessions = sessionsByController.get(session.controllerId) || [];
    controllerSessions.push(session);
    sessionsByController.set(session.controllerId, controllerSessions);

    // Group by workspace (using cwd as workspace path)
    if (session.cwd) {
      const workspaceKey = `${session.controllerId}:${session.cwd}`;
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
    <nav className="flex h-screen flex-col bg-gray-900 text-white" aria-label="Sidebar">
      <div className="flex-1 overflow-y-auto p-4">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Sessions</h2>
          <button
            type="button"
            onClick={() => setShowNewDialog(true)}
            className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700"
          >
            新建
          </button>
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
                  className={`flex w-full items-center gap-2 rounded px-3 py-2 text-sm transition-colors hover:bg-gray-800 ${
                    isOffline ? 'opacity-50' : ''
                  }`}
                  onClick={() => toggleController(controller.id)}
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${
                    controller.status === 'online' ? 'bg-green-500' : 'bg-gray-500'
                  }`} />
                  <span className="flex-1 truncate text-left font-medium">
                    {controller.name || controller.hostname}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/settings?controllerId=${controller.id}`);
                    }}
                    className="rounded p-0.5 text-gray-400 hover:text-white"
                    title="控制器配置"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  </button>
                  <span className="text-xs text-gray-400">
                    {isExpanded ? '▼' : '▶'}
                  </span>
                </button>

                {isExpanded && (
                  <ul className="ml-4 space-y-1">
                    {workspacePaths.size === 0 ? (
                      <li className="px-3 py-1 text-xs text-gray-500">无工作区</li>
                    ) : (
                      Array.from(workspacePaths).map((workspacePath) => {
                        const workspaceKey = `${controller.id}:${workspacePath}`;
                        const isWsExpanded = expandedWorkspaces.has(workspaceKey);
                        const wsSessions = sessionsByWorkspace.get(workspaceKey) || [];

                        return (
                          <li key={workspaceKey}>
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-sm transition-colors hover:bg-gray-800"
                              onClick={() => toggleWorkspace(workspaceKey)}
                            >
                              <span className="text-xs text-gray-400">
                                {isWsExpanded ? '▼' : '▶'}
                              </span>
                              <span className="flex-1 truncate text-left text-gray-300">
                                📁 {getWorkspaceName(workspacePath)}
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
                                          ? 'bg-gray-700 text-white'
                                          : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                                      }`}
                                    >
                                      {(session as any).worktreePath ? (
                                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-blue-400">
                                          <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                                          <path d="M21 3h-3a2 2 0 0 0-2 2v3" />
                                          <path d="M21 15v3a2 2 0 0 1-2 2h-3" />
                                          <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
                                          <polyline points="7 9 12 4 17 9" />
                                          <polyline points="7 15 12 20 17 15" />
                                        </svg>
                                      ) : (
                                        <span className={`h-2 w-2 shrink-0 rounded-full ${statusColors[session.status] ?? 'bg-gray-500'}`} />
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

      <div className="sticky bottom-0 border-t border-gray-700 p-4">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">{username}</span>
          <NavLink
            to="/settings"
            aria-label="Settings"
            className={({ isActive }) =>
              `rounded p-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 ${
                isActive ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'
              }`
            }
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </NavLink>
        </div>
      </div>
    </nav>
  );
}
