import { gql } from '@apollo/client'
import { CLOUD_HOST_SETUP_OPERATION_FIELDS } from './queries'

export const CREATE_PROVIDER = gql`
  mutation CreateProvider($input: ProviderInput!) {
    createProvider(input: $input) {
      id
      name
      type
      endpoint
      credentialType
      credentialValue
      isEnabled
      models {
        id
        name
        isEnabled
        sortOrder
      }
      createdAt
      updatedAt
    }
  }
`

export const UPDATE_PROVIDER = gql`
  mutation UpdateProvider($id: ID!, $input: ProviderInput!) {
    updateProvider(id: $id, input: $input) {
      id
      name
      type
      endpoint
      credentialType
      credentialValue
      isEnabled
      models {
        id
        name
        isEnabled
        sortOrder
      }
      createdAt
      updatedAt
    }
  }
`

export const DELETE_PROVIDER = gql`
  mutation DeleteProvider($id: ID!) {
    deleteProvider(id: $id)
  }
`

export const TOGGLE_PROVIDER = gql`
  mutation ToggleProvider($id: ID!) {
    toggleProvider(id: $id) {
      id
      isEnabled
      models {
        id
        isEnabled
      }
    }
  }
`

export const BATCH_ENABLE_PROVIDERS = gql`
  mutation BatchEnableProviders($ids: [ID!]!) {
    batchEnableProviders(ids: $ids) {
      successCount
    }
  }
`

export const BATCH_DISABLE_PROVIDERS = gql`
  mutation BatchDisableProviders($ids: [ID!]!) {
    batchDisableProviders(ids: $ids) {
      successCount
    }
  }
`

export const BATCH_DELETE_PROVIDERS = gql`
  mutation BatchDeleteProviders($ids: [ID!]!) {
    batchDeleteProviders(ids: $ids) {
      successCount
    }
  }
`

export const CREATE_CUSTOM_MODEL = gql`
  mutation CreateCustomModel($input: CustomModelInput!) {
    createCustomModel(input: $input) {
      id
      providerId
      name
      isCustom
      isEnabled
      sortOrder
    }
  }
`

export const DELETE_CUSTOM_MODEL = gql`
  mutation DeleteCustomModel($id: ID!) {
    deleteCustomModel(id: $id) {
      id
    }
  }
`

export const TOGGLE_MODEL = gql`
  mutation ToggleModel($id: ID!) {
    toggleModel(id: $id) {
      id
      isEnabled
    }
  }
`

export const UPDATE_MODEL_SORT_ORDER = gql`
  mutation UpdateModelSortOrder($ids: [ID!]!) {
    updateModelSortOrder(ids: $ids) {
      id
      sortOrder
    }
  }
`

export const CREATE_SESSION = gql`
  mutation CreateSession($input: CreateSessionInput!) {
    createSession(input: $input) {
      session {
        id
        userId
        controllerId
        controllerName
        acpServerType
        status
        externalSessionId
        cwd
        createdAt
        updatedAt
        endedAt
      }
    }
  }
`

export const CREATE_WORKSPACE = gql`
  mutation CreateWorkspace($input: CreateWorkspaceInput!) {
    createWorkspace(input: $input) {
      id
      userId
      controllerId
      name
      path
      isEnabled
      createdAt
      updatedAt
    }
  }
`

export const DELETE_WORKSPACE = gql`
  mutation DeleteWorkspace($id: ID!) {
    deleteWorkspace(id: $id)
  }
`

export const CLEAR_WORKSPACES = gql`
  mutation ClearWorkspaces($controllerId: ID!) {
    clearWorkspaces(controllerId: $controllerId)
  }
`

export const TOGGLE_WORKSPACE = gql`
  mutation ToggleWorkspace($id: ID!) {
    toggleWorkspace(id: $id) {
      id
      isEnabled
    }
  }
`

export const CLOSE_SESSION = gql`
  mutation CloseSession($id: ID!) {
    closeSession(id: $id)
  }
`

export const DELETE_SESSION = gql`
  mutation DeleteSession($id: ID!) {
    deleteSession(id: $id)
  }
`

export const DELETE_HISTORY_SESSION = gql`
  mutation DeleteHistorySession($sessionId: ID!, $syncAgent: Boolean) {
    deleteHistorySession(sessionId: $sessionId, syncAgent: $syncAgent) {
      success
      syncedToAgent
      error
    }
  }
`

export const SEND_SESSION_MESSAGE = gql`
  mutation SendSessionMessage($sessionId: ID!, $content: String!, $type: AcpMessageType) {
    sendSessionMessage(sessionId: $sessionId, content: $content, type: $type) {
      id
      sessionId
      direction
      type
      content
      metadata
      createdAt
    }
  }
`

export const CANCEL_GENERATION = gql`
  mutation CancelGeneration($sessionId: ID!) {
    cancelGeneration(sessionId: $sessionId)
  }
`

export const RESUME_SESSION = gql`
  mutation ResumeSession($id: ID!) {
    resumeSession(id: $id) {
      success
      status
      error
    }
  }
`

export const SET_SESSION_MODE = gql`
  mutation SetSessionMode($sessionId: ID!, $modeId: String!) {
    setSessionMode(sessionId: $sessionId, modeId: $modeId)
  }
`

export const SET_SESSION_MODEL = gql`
  mutation SetSessionModel($sessionId: ID!, $modelId: String!) {
    setSessionModel(sessionId: $sessionId, modelId: $modelId)
  }
`;

export const SET_SESSION_CONFIG_OPTION = gql`
  mutation SetSessionConfigOption($sessionId: ID!, $configId: String!, $value: String!) {
    setSessionConfigOption(sessionId: $sessionId, configId: $configId, value: $value)
  }
`;

export const IMPORT_HISTORY_SESSIONS = gql`
  mutation ImportHistorySessions($controllerId: ID!, $workspaceId: ID!, $acpServerType: AcpServerType = opencode, $sessionIds: [String!]!) {
    importHistorySessions(controllerId: $controllerId, workspaceId: $workspaceId, acpServerType: $acpServerType, sessionIds: $sessionIds) {
      sessionId
      acpSessionId
      title
      success
      error
      messageCount
    }
  }
`

export const REFRESH_ACP_CAPABILITIES = gql`
  mutation RefreshAcpCapabilities($controllerId: ID!) {
    refreshAcpCapabilities(controllerId: $controllerId) {
      type
      available
      version
      checkedAt
    }
  }
`

export const INIT_GIT_REPO = gql`
  mutation InitGitRepo($controllerId: ID!, $workspaceId: ID!) {
    initGitRepo(controllerId: $controllerId, workspaceId: $workspaceId)
  }
`

export const SET_WORKSPACE_DEFAULT_BRANCH = gql`
  mutation SetWorkspaceDefaultBranch($id: ID!, $defaultBranch: String!) {
    setWorkspaceDefaultBranch(id: $id, defaultBranch: $defaultBranch) {
      id
      defaultBranch
    }
  }
`

export const SET_CONTROLLER_WORKTREE_DIR = gql`
  mutation SetControllerWorktreeDir($controllerId: ID!, $worktreeDir: String!) {
    setControllerWorktreeDir(controllerId: $controllerId, worktreeDir: $worktreeDir) {
      id
      worktreeDir
    }
  }
`

export const CREATE_FOLDER = gql`
  mutation CreateFolder($controllerId: ID!, $parentPath: String!, $folderName: String!) {
    createFolder(controllerId: $controllerId, parentPath: $parentPath, folderName: $folderName) {
      name
      path
    }
  }
`

export const CREATE_GATEWAY = gql`
  mutation CreateGateway($controllerId: ID!, $name: String!, $port: Int!) {
    createGateway(controllerId: $controllerId, name: $name, port: $port) {
      id
      controllerId
      name
      port
      status
      createdAt
    }
  }
`

export const DELETE_GATEWAY = gql`
  mutation DeleteGateway($controllerId: ID!, $name: String!) {
    deleteGateway(controllerId: $controllerId, name: $name)
  }
`

export const RESPOND_PERMISSION = gql`
  mutation RespondPermission($requestId: String!, $outcome: String!, $optionId: String) {
    respondPermission(requestId: $requestId, outcome: $outcome, optionId: $optionId)
  }
`

export const RESPOND_ELICITATION = gql`
  mutation RespondElicitation($requestId: String!, $action: ElicitationAction!, $values: JSON) {
    respondElicitation(requestId: $requestId, action: $action, values: $values)
  }
`

export const RESPOND_HARNESS_LOGIN = gql`
  mutation RespondHarnessLogin($requestId: String!, $action: HarnessLoginAction!) {
    respondHarnessLogin(requestId: $requestId, action: $action)
  }
`

export const MARK_TODO_READ = gql`
  mutation MarkTodoRead($todoId: ID!) {
    markTodoRead(todoId: $todoId)
  }
`

export const MARK_ALL_TODO_READ = gql`
  mutation MarkAllTodoRead {
    markAllTodoRead
  }
`

export const UPDATE_PERMISSION_TIMEOUT = gql`
  mutation UpdatePermissionTimeout($sessionId: ID, $timeoutAction: PermissionTimeoutAction!) {
    updatePermissionTimeout(sessionId: $sessionId, timeoutAction: $timeoutAction)
  }
`

export const UNBIND_GITHUB_ACCOUNT = gql`
  mutation UnbindGitHubAccount($accountId: ID!) {
    unbindGitHubAccount(accountId: $accountId)
  }
`

export const UPDATE_COMMIT_SETTINGS = gql`
  mutation UpdateCommitSettings($input: CommitSettingsInput!) {
    updateCommitSettings(input: $input) {
      committerMode
      committerType
      githubAccountId
      customName
      customEmail
    }
  }
`

export const REFRESH_GITHUB_INSTALLATIONS = gql`
  mutation RefreshGitHubInstallations($accountId: ID!) {
    refreshGitHubInstallations(accountId: $accountId) {
      id
      installations {
        id
        repos {
          id
          repoName
          fullName
          permissions {
            read
            write
          }
        }
      }
    }
  }
`

export const UPDATE_GLOBAL_PERMISSION_TIMEOUT = gql`
  mutation UpdateGlobalPermissionTimeout($timeoutAction: GlobalPermissionTimeoutAction!) {
    updateGlobalPermissionTimeout(timeoutAction: $timeoutAction)
  }
`

export const DELETE_WORKTREE = gql`
  mutation DeleteWorktree($controllerId: ID!, $workspaceId: ID!, $worktreePath: String!) {
    deleteWorktree(controllerId: $controllerId, workspaceId: $workspaceId, worktreePath: $worktreePath) {
      success
      closedSessionIds
      failures {
        sessionId
        error
      }
      error
    }
  }
`

export const SET_MCP_SERVER_ENABLED = gql`
  mutation SetMcpServerEnabled($id: ID!, $enabled: Boolean!) {
    setMcpServerEnabled(id: $id, enabled: $enabled) {
      id
      name
      enabled
      status
    }
  }
`

export const REGENERATE_CONTROLLER_KEY = gql`
  mutation RegenerateControllerKey($input: RegenerateControllerKeyInput!) {
    regenerateControllerKey(input: $input) {
      key {
        id
        name
        type
        keyPrefix
        status
        rawKey
        lastUsedAt
        createdAt
        updatedAt
      }
      rawKey
    }
  }
`

// ---------- 云电脑（contracts/cloud-host.graphql） ----------

export const CREATE_CLOUD_HOST = gql`
  mutation CreateCloudHost($input: CreateCloudHostInput!) {
    createCloudHost(input: $input) {
      id
      name
      controllerId
      status
      harnessTypes
      defaultSessionId
      activeSessionCount
      failureReason
      deletedAt
      hasDefaultWorkspace
    }
  }
`

export const STOP_CLOUD_HOST = gql`
  mutation StopCloudHost($id: ID!, $force: Boolean) {
    stopCloudHost(id: $id, force: $force) {
      id
      name
      controllerId
      status
      harnessTypes
      defaultSessionId
      activeSessionCount
      failureReason
      deletedAt
    }
  }
`

export const DELETE_CLOUD_HOST = gql`
  mutation DeleteCloudHost($id: ID!) {
    deleteCloudHost(id: $id)
  }
`

export const INSTALL_CLOUD_HOST_WORKLOAD = gql`
  mutation InstallCloudHostWorkload($input: InstallCloudHostWorkloadInput!) {
    installCloudHostWorkload(input: $input) {
      ...CloudHostSetupOperationFields
    }
  }
  ${CLOUD_HOST_SETUP_OPERATION_FIELDS}
`

export const SETUP_CLOUD_HOST_GITHUB_PROJECT = gql`
  mutation SetupCloudHostGithubProject($input: SetupCloudHostGithubProjectInput!) {
    setupCloudHostGithubProject(input: $input) {
      ...CloudHostSetupOperationFields
    }
  }
  ${CLOUD_HOST_SETUP_OPERATION_FIELDS}
`

export const RETRY_CLOUD_HOST_SETUP_OPERATION = gql`
  mutation RetryCloudHostSetupOperation($id: ID!) {
    retryCloudHostSetupOperation(id: $id) {
      ...CloudHostSetupOperationFields
    }
  }
  ${CLOUD_HOST_SETUP_OPERATION_FIELDS}
`

// ---------- 控制器默认 MCP / ACP 选项刷新 ----------

export const SET_CONTROLLER_DEFAULT_MCP = gql`
  mutation SetControllerDefaultMcp($controllerId: ID!, $useAllEnabled: Boolean!, $serverIds: [ID!]) {
    setControllerDefaultMcp(
      controllerId: $controllerId
      useAllEnabled: $useAllEnabled
      serverIds: $serverIds
    ) {
      id
      defaultMcp {
        useAllEnabled
        serverIds
      }
    }
  }
`

export const REFRESH_ACP_SERVER_OPTIONS = gql`
  mutation RefreshAcpServerOptions($controllerId: ID!, $acpServerType: AcpServerType!) {
    refreshAcpServerOptions(controllerId: $controllerId, acpServerType: $acpServerType) {
      modes { id name description }
      models { id name provider }
      currentModeId
      currentModelId
      probedAt
    }
  }
`

// ---------- 我的费用（contracts/billing.graphql） ----------

export const CREATE_MY_BILLING_API_KEY = gql`
  mutation CreateMyBillingApiKey($name: String!) {
    createMyBillingApiKey(name: $name) {
      apiKey { id name keyPrefix status lastUsedAt createdAt }
      secret
    }
  }
`

export const REVOKE_MY_BILLING_API_KEY = gql`
  mutation RevokeMyBillingApiKey($id: ID!) {
    revokeMyBillingApiKey(id: $id) {
      id
      name
      keyPrefix
      status
      lastUsedAt
      createdAt
    }
  }
`

export const CREATE_CLOUD_HOST_ISSUES_LINKAGE = gql`
  mutation CreateCloudHostIssuesLinkage($input: CloudHostIssuesLinkageInput!) {
    createCloudHostIssuesLinkage(input: $input) {
      id
      controllerId
      configuredWorkflowId
      configuredWorkflowName
      labelName
      repoFullNames
      createdAt
      updatedAt
    }
  }
`

export const UPDATE_CLOUD_HOST_ISSUES_LINKAGE = gql`
  mutation UpdateCloudHostIssuesLinkage($id: ID!, $input: CloudHostIssuesLinkageInput!) {
    updateCloudHostIssuesLinkage(id: $id, input: $input) {
      id
      controllerId
      configuredWorkflowId
      configuredWorkflowName
      labelName
      repoFullNames
      createdAt
      updatedAt
    }
  }
`

export const DELETE_CLOUD_HOST_ISSUES_LINKAGE = gql`
  mutation DeleteCloudHostIssuesLinkage($id: ID!) {
    deleteCloudHostIssuesLinkage(id: $id)
  }
`

export const CLEANUP_CLOUD_HOST_ISSUES_LABELS = gql`
  mutation CleanupCloudHostIssuesLabels($controllerId: ID!) {
    cleanupCloudHostIssuesLabels(controllerId: $controllerId) {
      deleted
      failed
    }
  }
`

// ---------- 多租户二期：工作区 CRUD / 成员管理（仅租户 admin） ----------

const WORKSPACE_FIELDS = gql`
  fragment WorkspaceFields on Workspace {
    id
    name
    type
    tenant {
      id
      name
      type
      memberCount
    }
    memberCount
    myRole
    readOnly
    createdAt
  }
`

export const CREATE_TENANT_WORKSPACE = gql`
  mutation CreateTenantWorkspace($name: String!) {
    createTenantWorkspace(name: $name) {
      ...WorkspaceFields
    }
  }
  ${WORKSPACE_FIELDS}
`

export const RENAME_TENANT_WORKSPACE = gql`
  mutation RenameTenantWorkspace($id: ID!, $name: String!) {
    renameTenantWorkspace(id: $id, name: $name) {
      ...WorkspaceFields
    }
  }
  ${WORKSPACE_FIELDS}
`

export const DELETE_TENANT_WORKSPACE = gql`
  mutation DeleteTenantWorkspace($id: ID!) {
    deleteTenantWorkspace(id: $id)
  }
`

export const ADD_WORKSPACE_MEMBER = gql`
  mutation AddWorkspaceMember($workspaceId: ID!, $userId: ID!) {
    addTenantWorkspaceMember(workspaceId: $workspaceId, userId: $userId) {
      ...WorkspaceFields
    }
  }
  ${WORKSPACE_FIELDS}
`

export const REMOVE_WORKSPACE_MEMBER = gql`
  mutation RemoveWorkspaceMember($workspaceId: ID!, $userId: ID!) {
    removeTenantWorkspaceMember(workspaceId: $workspaceId, userId: $userId) {
      ...WorkspaceFields
    }
  }
  ${WORKSPACE_FIELDS}
`

export const ADD_TENANT_MEMBER = gql`
  mutation AddTenantMember($tenantId: ID!, $username: String!, $role: TenantRole) {
    addTenantMember(tenantId: $tenantId, username: $username, role: $role) {
      id
      name
      username
      role
      createdAt
    }
  }
`

export const REMOVE_TENANT_MEMBER = gql`
  mutation RemoveTenantMember($tenantId: ID!, $userId: ID!) {
    removeTenantMember(tenantId: $tenantId, userId: $userId)
  }
`

export const CHANGE_TENANT_MEMBER_ROLE = gql`
  mutation ChangeTenantMemberRole($tenantId: ID!, $userId: ID!, $role: TenantRole!) {
    changeTenantMemberRole(tenantId: $tenantId, userId: $userId, role: $role) {
      id
      name
      username
      role
      createdAt
    }
  }
`
