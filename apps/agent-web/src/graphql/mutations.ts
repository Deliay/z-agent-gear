import { gql } from '@apollo/client'

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
