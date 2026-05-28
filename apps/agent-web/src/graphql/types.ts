export interface ControllerKeyData {
  id: string
  name: string
  type: string
  keyPrefix: string
  status: string
  rawKey: string | null
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ControllerData {
  id: string
  name: string
  hostname: string
  type: string
  status: string
  keyId: string
  version: string
  lastHeartbeatAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ControllerWorkspaceData {
  id: string
  userId: string
  controllerId: string
  name: string
  path: string
  isEnabled: boolean
  createdAt: string
  updatedAt: string
}

export interface GitRepoInfoData {
  isGitRepo: boolean
  currentBranch?: string | null
  branches?: string[] | null
  defaultBranch?: string | null
}

export interface GitInitResultData {
  success: boolean
}

export interface FolderEntryData {
  name: string
  path: string
  isDirectory: boolean
}

export interface ProviderData {
  id: string
  name: string
  type: string
  endpoint: string
  credentialType: string
  credentialValue: string
  isEnabled: boolean
  models: Array<{
    id: string
    name: string
    isEnabled: boolean
    sortOrder: number
  }>
  createdAt: string
  updatedAt: string
}

export interface ModelData {
  id: string
  providerId: string
  provider?: {
    id: string
    name: string
    type: string
    isEnabled: boolean
  }
  name: string
  isCustom: boolean
  isEnabled: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface AgentModeData {
  id: string
  name: string
  description?: string | null
}

export interface AgentModelInfoData {
  id: string
  name: string
  provider?: string | null
}

export interface SessionData {
  id: string
  userId: string
  controllerId: string
  controllerName: string
  acpServerType: string
  status: string
  title: string | null
  externalSessionId: string | null
  cwd: string | null
  worktreePath: string | null
  worktreeBranch: string | null
  modes?: AgentModeData[] | null
  currentModeId?: string | null
  availableModels?: AgentModelInfoData[] | null
  currentModelId?: string | null
  createdAt: string
  updatedAt: string
  endedAt: string | null
}

export interface AcpMessageData {
  id: string
  sessionId: string
  direction: string
  type: string
  content: string
  metadata: string | null
  createdAt: string
}

export interface AcpCapabilityData {
  type: string
  available: boolean
  version: string | null
  checkedAt: string | null
}

export interface RefreshAcpCapabilitiesMutation {
  refreshAcpCapabilities: AcpCapabilityData[]
}

export interface GetControllerKeysQuery {
  controllerKeys: ControllerKeyData[]
}

export interface GetControllersQuery {
  controllers: ControllerData[]
}

export interface GetControllerWorkspacesQuery {
  controllerWorkspaces: ControllerWorkspaceData[]
}

export interface GetWorkspacesQuery {
  workspaces: ControllerWorkspaceData[]
}

export interface GetProvidersQuery {
  providers: ProviderData[]
}

export interface GetModelsQuery {
  models: ModelData[]
}

export interface GetSessionsQuery {
  sessions: SessionData[]
}

export interface GetSessionQuery {
  session: SessionData | null
}

export interface GetSessionMessagesQuery {
  sessionMessages: AcpMessageData[]
}

export interface GetAcpCapabilitiesQuery {
  acpCapabilities: AcpCapabilityData[]
}

export interface CreateControllerKeyMutation {
  createControllerKey: {
    key: ControllerKeyData
    rawKey: string
  }
}

export interface CreateWorkspaceMutation {
  createWorkspace: ControllerWorkspaceData
}

export interface ToggleWorkspaceMutation {
  toggleWorkspace: ControllerWorkspaceData
}

export interface CreateSessionMutation {
  createSession: {
    session: SessionData
  }
}

export interface SendSessionMessageMutation {
  sendSessionMessage: AcpMessageData
}

export interface ResumeSessionMutation {
  resumeSession: {
    success: boolean
    status: string
    error: string | null
  }
}

export interface HistorySessionInfoData {
  sessionId: string
  title: string | null
  cwd: string
  updatedAt: string | null
}

export interface ImportSessionResultData {
  sessionId: string
  acpSessionId: string
  title: string | null
  success: boolean
  error: string | null
  messageCount: number
}

export interface ListHistorySessionsQuery {
  listHistorySessions: HistorySessionInfoData[]
}

export interface ImportHistorySessionsMutation {
  importHistorySessions: ImportSessionResultData[]
}

export interface GetControllerWorkspacesQuery {
  controllerWorkspaces: ControllerWorkspaceData[]
}

export interface CreateWorkspaceMutation {
  createWorkspace: ControllerWorkspaceData
}

export interface ToggleWorkspaceMutation {
  toggleWorkspace: ControllerWorkspaceData
}

export interface SetWorkspaceDefaultBranchMutation {
  setWorkspaceDefaultBranch: ControllerWorkspaceData
}

export interface DetectGitRepoQuery {
  detectGitRepo: GitRepoInfoData
}

export interface CreateFolderMutation {
  createFolder: {
    name: string
    path: string
  } | null
}

export interface PortForwardData {
  id: string
  controllerId: string
  port: number
  status: string
  createdAt: string
}

export interface PortForwardListData {
  portForwards: PortForwardData[]
  total: number
  limit: number
}

export interface GetPortForwardsQuery {
  portForwards: PortForwardListData
}

export interface CreatePortForwardMutation {
  createPortForward: PortForwardData
}

export interface DeletePortForwardMutation {
  deletePortForward: boolean
}

export interface PermissionOptionData {
  optionId: string
  name: string
  kind: string
}

export interface PermissionRequestDataFields {
  requestId: string
  sessionId: string
  toolCallId: string
  options: PermissionOptionData[]
}

export interface TodoItemData {
  id: string
  type: string
  priority: string
  title: string
  description: string | null
  isRead: boolean
  data: PermissionRequestDataFields | null
  createdAt: string
}

export interface GetTodoListQuery {
  getTodoList: TodoItemData[]
}

export interface GetUnreadTodoCountQuery {
  getUnreadTodoCount: number
}

export interface RespondPermissionMutation {
  respondPermission: boolean
}

export interface MarkTodoReadMutation {
  markTodoRead: boolean
}

export interface MarkAllTodoReadMutation {
  markAllTodoRead: boolean
}

export interface UpdatePermissionTimeoutMutation {
  updatePermissionTimeout: boolean
}

export interface UpdateGlobalPermissionTimeoutMutation {
  updateGlobalPermissionTimeout: boolean
}
