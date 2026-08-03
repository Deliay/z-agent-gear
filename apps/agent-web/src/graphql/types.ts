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

export interface SessionConfigOptionValueData {
  value: string
  name?: string | null
}

export interface SessionConfigOptionData {
  id: string
  name: string
  description?: string | null
  category?: string | null
  type: string
  currentValue?: string | null
  options?: SessionConfigOptionValueData[] | null
}

export interface PromptCapabilitiesData {
  image: boolean
  audio: boolean
  embeddedContext: boolean
}

export interface AgentInfoData {
  name: string
  version?: string | null
}

export interface AuthMethodInfoData {
  id: string
  kind: string
  name?: string | null
  description?: string | null
  url?: string | null
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
  configOptions?: SessionConfigOptionData[] | null
  promptCapabilities?: PromptCapabilitiesData | null
  agentInfo?: AgentInfoData | null
  authRequired?: boolean | null
  authMethods?: AuthMethodInfoData[] | null
  supportsAdditionalDirectories?: boolean | null
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

export interface GatewayData {
  id: string
  controllerId: string
  name: string
  port: number
  status: string
  createdAt: string
}

export interface GatewayListData {
  gateways: GatewayData[]
  total: number
  limit: number
}

export interface GetGatewaysQuery {
  gateways: GatewayListData
}

export interface CreateGatewayMutation {
  createGateway: GatewayData
}

export interface DeleteGatewayMutation {
  deleteGateway: boolean
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

export interface GitHubRepoPermissionsData {
  read: boolean
  write: boolean
}

export interface GitHubRepoData {
  id: string
  repoId: number
  repoName: string
  fullName: string
  private: boolean
  permissions: GitHubRepoPermissionsData
}

export interface GitHubInstallationData {
  id: string
  installationId: number
  managementUrl: string
  repos?: GitHubRepoData[] | null
  createdAt: string
}

export interface GitHubAccountData {
  id: string
  githubUserId: number
  githubLogin: string
  githubAvatarUrl?: string | null
  installations?: GitHubInstallationData[] | null
  createdAt: string
}

export interface GitHubAppUrlData {
  url: string
  state: string
}

export interface GetGithubAccountsQuery {
  githubAccounts: GitHubAccountData[]
}

export interface GetGithubAppUrlQuery {
  githubAppUrl: GitHubAppUrlData
}

export interface UnbindGitHubAccountMutation {
  unbindGitHubAccount: boolean
}

export interface RefreshGitHubInstallationsMutation {
  refreshGitHubInstallations: GitHubAccountData
}
