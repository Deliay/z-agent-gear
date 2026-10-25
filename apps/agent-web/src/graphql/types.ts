import type { WorkflowInstanceSummaryData } from './workflow'

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

export type HarnessType = 'OPENCODE' | 'KIMI_CODE' | 'DEEPSEEK_HARNESS'

/** 工作负载分类：standard = 运行环境/工具，harness = 云电脑 harness */
export type CloudWorkloadKind = 'STANDARD' | 'HARNESS'

export type CloudHostStatus = 'STARTING' | 'RUNNING' | 'STOPPING' | 'STOPPED' | 'FAILED'

/** 前台云电脑（contracts/cloud-host.graphql）；非云电脑控制器为 null */
export interface CloudHostData {
  id: string
  name: string
  /** 归属控制器；HOME_OVERVIEW/GET_CONTROLLERS 的嵌套字段未选择时不返回 */
  controllerId?: string
  status: CloudHostStatus
  harnessTypes: HarnessType[]
  defaultSessionId?: string | null
  activeSessionCount: number
  containerId?: string | null
  createdAt?: string
  readyAt?: string | null
  stoppedAt?: string | null
  failureReason?: string | null
  /** 软删除时间；非空表示已从列表隐藏，仅用于前端只读判定 */
  deletedAt?: string | null
  /** 默认工作区路径（workspaceId → ControllerWorkspace.path；缺失回退 /root/workspace） */
  defaultWorkspace?: string
  /** 是否已创建默认工作区（workspaceId != null）；用于区分「未创建工作区」与「默认会话创建失败」 */
  hasDefaultWorkspace?: boolean
  /** 当前正在 runtime 安装的工作负载名；null 表示空闲 */
  workloadInstalling?: string | null
}

export type CloudHostSetupKind = 'INSTALL_WORKLOAD' | 'GITHUB_SETUP'

export type CloudHostSetupStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED'

export type CloudHostSetupStepStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED'

/** `cloudHostWorkloads` 参数定义（对齐 admin-api 的 paramSchema） */
export interface CloudHostWorkloadParamFieldData {
  key: string
  label: string
  type: string
  options?: string[] | null
  defaultValue?: unknown
}

export interface CloudHostWorkloadItemData {
  workloadId: string
  name: string
  /** 工作负载分类：STANDARD（运行环境/工具）或 HARNESS */
  workloadKind?: CloudWorkloadKind
  paramSchema: CloudHostWorkloadParamFieldData[]
  dependsOnWorkloadIds: string[]
  isPreset: boolean
  installed: boolean
  installedAt?: string | null
  source?: string | null
}

export interface CloudHostSetupStepData {
  key: string
  status: CloudHostSetupStepStatus
  detail?: string | null
}

export interface CloudHostSetupOperationData {
  id: string
  kind: CloudHostSetupKind
  status: CloudHostSetupStatus
  steps: CloudHostSetupStepData[]
  sessionId?: string | null
  error?: string | null
  createdAt: string
  updatedAt: string
}

export interface CloudHostWorkloadsQuery {
  cloudHostWorkloads: CloudHostWorkloadItemData[]
}

export interface CloudHostWorkloadCatalogQuery {
  cloudHostWorkloadCatalog: CloudHostWorkloadItemData[]
}

export interface CloudHostSetupOperationQuery {
  cloudHostSetupOperation: CloudHostSetupOperationData | null
}

export interface InstallCloudHostWorkloadMutation {
  installCloudHostWorkload: CloudHostSetupOperationData
}

export interface SetupCloudHostGithubProjectMutation {
  setupCloudHostGithubProject: CloudHostSetupOperationData
}

export interface RetryCloudHostSetupOperationMutation {
  retryCloudHostSetupOperation: CloudHostSetupOperationData
}

export interface CloudHostCapabilitiesData {
  enabled: boolean
  supportedHarnesses: HarnessType[]
}

export interface CloudHostSessionSummaryData {
  id: string
  title: string
  status: string
  acpServerType: string
}

export interface CloudHostStopImpactData {
  activeSessionCount: number
  sessionsWillBeLost: boolean
  sessions: CloudHostSessionSummaryData[]
}

export interface GetCloudHostCapabilitiesQuery {
  cloudHostCapabilities: CloudHostCapabilitiesData
}

export interface MyCloudHostsQuery {
  myCloudHosts: CloudHostData[]
}

export interface CloudHostStopImpactQuery {
  cloudHostStopImpact: CloudHostStopImpactData
}

export interface CreateCloudHostMutation {
  createCloudHost: CloudHostData
}

export interface StopCloudHostMutation {
  stopCloudHost: CloudHostData
}

export interface DeleteCloudHostMutation {
  deleteCloudHost: boolean
}

export interface ControllerDefaultMcpData {
  useAllEnabled: boolean
  serverIds: string[]
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
  /** 新建会话默认注入的 MCP（历史控制器归一为 useAllEnabled=true） */
  defaultMcp?: ControllerDefaultMcpData | null
  /** cloud 类型主机返回其云电脑；local/github 为 null */
  cloudHost?: CloudHostData | null
}

export interface ControllerWorkspaceData {
  id: string
  userId: string
  controllerId: string
  name: string
  path: string
  isEnabled: boolean
  isGitRepo?: boolean | null
  defaultBranch?: string | null
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
  /** global（系统内置）模型由服务端掩蔽为 null */
  providerId: string | null
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
  scope: 'user' | 'global'
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
  source?: AgentModelSource | null
  sourceProvider?: string | null
  group?: string | null
  basis?: string | null
}

export type AgentFeatureStatus = 'supported' | 'partial' | 'unsupported'
export type AgentModelSource = 'platform' | 'agent' | 'custom' | 'unknown'

export interface AgentFeatureSupportData {
  id: string
  status: AgentFeatureStatus
  detail?: string | null
}

export interface AgentCapabilitySnapshotData {
  protocolVersion?: number | null
  agentInfo?: AgentInfoData | null
  features: AgentFeatureSupportData[]
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
  /** 控制器类型；云电脑软删除后 controller 可能不在列表结果中，以此判定只读 */
  controllerType?: string | null
  /** 会话所属云电脑（含软删除留档）；普通主机为 null */
  cloudHost?: CloudHostData | null
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
  agentCapabilities?: AgentCapabilitySnapshotData | null
  features?: AgentFeatureSupportData[] | null
  promptCapabilities?: PromptCapabilitiesData | null
  agentInfo?: AgentInfoData | null
  authRequired?: boolean | null
  authMethods?: AuthMethodInfoData[] | null
  supportsAdditionalDirectories?: boolean | null
  /** 工作流节点会话才有，普通会话为 null */
  workflowInstanceId?: string | null
  workflowNodeId?: string | null
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

export interface AcpModeOptionData {
  id: string
  name: string
  description: string | null
}

export interface AcpModelOptionData {
  id: string
  name: string
  provider: string | null
}

export interface AcpServerOptionsData {
  modes: AcpModeOptionData[]
  models: AcpModelOptionData[]
  currentModeId: string | null
  currentModelId: string | null
  probedAt: string | null
}

export interface GetAcpServerOptionsQuery {
  acpServerOptions: AcpServerOptionsData
}

export interface RefreshAcpServerOptionsMutation {
  refreshAcpServerOptions: AcpServerOptionsData
}

export interface CloudHostQuery {
  cloudHost: CloudHostData | null
}

export interface SetControllerDefaultMcpMutation {
  setControllerDefaultMcp: ControllerData
}

export interface CreateControllerKeyMutation {
  createControllerKey: {
    key: ControllerKeyData
    rawKey: string
  }
}

export interface RegenerateControllerKeyMutation {
  regenerateControllerKey: {
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

export interface SetSessionConfigOptionMutation {
  setSessionConfigOption: boolean
}

export interface DeleteHistorySessionMutation {
  deleteHistorySession: {
    success: boolean
    syncedToAgent: boolean
    error: string | null
  }
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

export interface PermissionToolCallData {
  toolCallId: string
  title?: string
  kind?: string
  rawInput?: Record<string, unknown>
  locations?: Array<{ path: string; line?: number }>
}

export interface PermissionRequestDataFields {
  requestId: string
  sessionId: string
  toolCallId: string
  toolCall?: PermissionToolCallData
  options: PermissionOptionData[]
}

export type ElicitationAction = 'accept' | 'decline' | 'cancel'

export interface ElicitationSchemaOneOfOption {
  const: unknown
  title?: string
  description?: string
}

export interface ElicitationSchemaProperty {
  type?: string
  title?: string
  description?: string
  enum?: unknown[]
  oneOf?: ElicitationSchemaOneOfOption[]
  format?: string
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  default?: unknown
  items?: {
    enum?: unknown[]
    oneOf?: ElicitationSchemaOneOfOption[]
  }
}

export interface ElicitationRequestedSchema {
  type: 'object'
  title?: string
  description?: string
  properties?: Record<string, ElicitationSchemaProperty>
  required?: string[]
}

export interface ElicitationRequestDataFields {
  requestId: string
  sessionId: string
  toolCallId?: string | null
  mode: 'form' | 'url'
  message: string
  requestedSchema?: ElicitationRequestedSchema | null
  elicitationId?: string | null
  url?: string | null
}

/** Kimi Code（Harness）登录引导数据（contracts/agent-session.graphql） */
export interface HarnessLoginRequestDataFields {
  requestId: string
  controllerId: string
  serverType: string
  /** 触发登录检查的使用动作：probe-options / acp:start / acp:resume */
  trigger: string
  /** `kimi login` stdio 原文登录链接（http(s)） */
  url: string
  /** `kimi login` stdio 原文设备码 */
  userCode: string
  expiresAt: string
}

/** 登录引导弹窗动作（本期仅取消） */
export type HarnessLoginAction = 'cancel'

export interface RespondHarnessLoginMutation {
  respondHarnessLogin: boolean
}

export interface TodoItemData {
  id: string
  type: string
  priority: string
  title: string
  description: string | null
  isRead: boolean
  data: PermissionRequestDataFields | null
  elicitationData?: ElicitationRequestDataFields | null
  /** type=harness_login_request 时存在 */
  harnessLoginData?: HarnessLoginRequestDataFields | null
  resolution?: ElicitationResolution | null
  resolvedAt?: string | null
  expiresAt?: string | null
  createdAt: string
}

export type ElicitationResolution = 'accepted' | 'declined' | 'cancelled' | 'expired' | 'failed'

export interface GetTodoListQuery {
  getTodoList: TodoItemData[]
}

export interface GetUnreadTodoCountQuery {
  getUnreadTodoCount: number
}

export interface RespondPermissionMutation {
  respondPermission: boolean
}

export interface RespondElicitationMutation {
  respondElicitation: boolean
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

export interface WorkspaceWorktreeSessionData {
  id: string
  title: string | null
  status: string
  worktreePath: string | null
}

export interface WorkspaceWorktreeData {
  path: string
  branch: string | null
  sessionCount: number
  sessions: WorkspaceWorktreeSessionData[]
}

export interface GetWorkspaceWorktreesQuery {
  workspaceWorktrees: WorkspaceWorktreeData[]
}

export interface WorktreeDeleteFailureData {
  sessionId: string
  error: string
}

export interface DeleteWorktreeResultData {
  success: boolean
  closedSessionIds: string[]
  failures: WorktreeDeleteFailureData[]
  error: string | null
}

export interface DeleteWorktreeMutation {
  deleteWorktree: DeleteWorktreeResultData
}

export interface RegenerateControllerKeyMutation {
  regenerateControllerKey: {
    key: ControllerKeyData
    rawKey: string
  }
}

// ---------- 首页聚合查询（HOME_OVERVIEW，对齐 contracts/home.graphql） ----------

export interface HomeOverviewControllerData extends ControllerData {
  /** 嵌套惰性字段：纯 DB 查询，不随控制器在线状态降级；失败为空列表 */
  gateways: GatewayListData
}

export interface HomeOverviewWorkspaceData extends ControllerWorkspaceData {
  /** 嵌套惰性字段：经 Redis relay 扇出，离线或失败/超时为空列表 */
  worktrees: WorkspaceWorktreeData[]
}

export interface HomeOverviewData {
  controllers: HomeOverviewControllerData[]
  sessions: SessionData[]
  sessionTotalCount: number
  workspaces: HomeOverviewWorkspaceData[]
  workflowInstances: WorkflowInstanceSummaryData[]
  archivedWorkflowInstances: WorkflowInstanceSummaryData[]
  todos: TodoItemData[]
  unreadTodoCount: number
}

export interface HomeOverviewQuery {
  homeOverview: HomeOverviewData
}

// ---------- 我的费用（contracts/billing.graphql） ----------

export type BillingRollupGranularity = 'minute' | 'hour' | 'day'

export interface MyBillingAccountData {
  id: string
  ownerType: 'front_user' | 'admin_user'
  ownerId: string
  ownerName: string
  cashBalance: number
  giftBalance: number
  creditLimit: number
  frozenAmount: number
  availableBalance: number
  status: string
  insufficientSince: string | null
  ledgerCount: number
  createdAt: string
  updatedAt: string
}

export interface MyInvoiceItemData {
  productId: string
  quantity: number
  unitPrice: number
  amount: number
  meteringRef: string | null
  segment?: string | null
}

export interface MyBillingInvoiceData {
  id: string
  accountId: string
  seq: number
  type: 'charge' | 'recharge' | 'adjust'
  category: 'container' | 'model' | 'manual'
  amount: number
  balanceAfter: number
  refType: string | null
  refId: string | null
  description: string
  items: MyInvoiceItemData[]
  receiptId: string | null
  createdAt: string
}

export interface MyBillingReceiptData {
  id: string
  receiptNo: string
  invoiceId: string
  accountId: string
  amount: number
  balanceAfter: number
  issuedAt: string
}

export interface MyBillingRollupData {
  bucketStart: string
  chargeTotal: number
  rechargeTotal: number
  chargeCount: number
}

export interface MyBillingApiKeyData {
  id: string
  name: string
  keyPrefix: string
  status: string
  lastUsedAt: string | null
  createdAt: string
}

export interface GetMyBillingAccountQuery {
  myBillingAccount: MyBillingAccountData
}

export interface GetMyBillingInvoicesQuery {
  myBillingInvoices: MyBillingInvoiceData[]
}

export interface GetMyBillingReceiptsQuery {
  myBillingReceipts: MyBillingReceiptData[]
}

export interface GetMyBillingReceiptQuery {
  myBillingReceipt: MyBillingReceiptData | null
}

export interface GetMyBillingRollupsQuery {
  myBillingRollups: MyBillingRollupData[]
}

export interface GetMyBillingApiKeysQuery {
  myBillingApiKeys: MyBillingApiKeyData[]
}

export interface MyBillingApiCallData {
  id: string
  requestId: string
  modelId: string
  modelName: string
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  cost: number
  status: string
  estimated: boolean
  invoiceSeq: number | null
  startedAt: string
  finishedAt: string | null
}

export interface GetMyBillingApiCallsQuery {
  myBillingApiCalls: MyBillingApiCallData[]
}
