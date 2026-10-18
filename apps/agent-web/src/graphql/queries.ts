import { gql } from '@apollo/client'

export const GET_PROVIDERS = gql`
  query GetProviders {
    providers {
      id
      name
      type
      endpoint
      credentialType
      credentialValue
      isEnabled
      models {
        id
        providerId
        name
        isCustom
        isEnabled
        sortOrder
      }
      createdAt
      updatedAt
    }
  }
`

export const GET_MODELS = gql`
  query GetModels {
    models {
      id
      providerId
      provider {
        id
        name
        type
        isEnabled
      }
      name
      isCustom
      isEnabled
      sortOrder
      createdAt
      updatedAt
    }
  }
`

export const GET_MODELS_BY_PROVIDER = gql`
  query GetModelsByProvider($providerId: ID!) {
    modelsByProvider(providerId: $providerId) {
      id
      providerId
      name
      isCustom
      isEnabled
      sortOrder
    }
  }
`

export const GET_SESSIONS = gql`
  query GetSessions {
    sessions {
      id
      userId
      controllerId
      controllerName
      acpServerType
      status
      title
      externalSessionId
      cwd
      worktreePath
      worktreeBranch
      createdAt
      updatedAt
      endedAt
    }
  }
`

export const GET_SESSION = gql`
  query GetSession($id: ID!) {
    session(id: $id) {
      id
      userId
      controllerId
      controllerName
      acpServerType
      status
      title
      externalSessionId
      cwd
      worktreePath
      worktreeBranch
      modes {
        id
        name
        description
      }
      currentModeId
      currentModel {
        id
        name
        provider
      }
      availableModels {
        id
        name
        provider
      }
      currentModelId
      configOptions {
        id
        name
        description
        category
        type
        currentValue
        options {
          value
          name
        }
      }
      promptCapabilities {
        image
        audio
        embeddedContext
      }
      agentInfo {
        name
        version
      }
      authRequired
      authMethods {
        id
        kind
        name
        description
        url
      }
      supportsAdditionalDirectories
      workflowInstanceId
      workflowNodeId
      createdAt
      updatedAt
      endedAt
    }
  }
`

export const GET_SESSION_MESSAGES = gql`
  query GetSessionMessages($sessionId: ID!, $before: ID, $limit: Int) {
    sessionMessages(sessionId: $sessionId, before: $before, limit: $limit) {
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

export const GET_ACP_CAPABILITIES = gql`
  query GetAcpCapabilities($controllerId: ID!) {
    acpCapabilities(controllerId: $controllerId) {
      type
      available
      version
      checkedAt
    }
  }
`

export const GET_ACP_SERVER_OPTIONS = gql`
  query GetAcpServerOptions($controllerId: ID!, $acpServerType: AcpServerType!) {
    acpServerOptions(controllerId: $controllerId, acpServerType: $acpServerType) {
      modes { id name description }
      models { id name provider }
      currentModeId
      currentModelId
      probedAt
    }
  }
`

export const GET_CONTROLLERS = gql`
  query GetControllers {
    controllers {
      id
      name
      hostname
      type
      status
      keyId
      version
      lastHeartbeatAt
      createdAt
      updatedAt
    }
  }
`

export const GET_CONTROLLER_WORKSPACES = gql`
  query GetControllerWorkspaces($controllerId: ID!) {
    controllerWorkspaces(controllerId: $controllerId) {
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

export const GET_CONTROLLER_WORKSPACES_ENABLED = gql`
  query GetControllerWorkspacesEnabled($controllerId: ID!) {
    controllerWorkspaces(controllerId: $controllerId) {
      id
      name
      path
      isEnabled
      isGitRepo
    }
  }
`

export const GET_WORKSPACES = gql`
  query GetWorkspaces {
    workspaces {
      id
      controllerId
      name
      path
      isEnabled
      isGitRepo
    }
  }
`

export const BROWSE_FOLDER = gql`
  query BrowseFolder($controllerId: ID!, $path: String) {
    browseFolder(controllerId: $controllerId, path: $path) {
      name
      path
      isDirectory
    }
  }
`

export const GET_HOME_DIRECTORY = gql`
  query GetHomeDirectory($controllerId: ID!) {
    getHomeDirectory(controllerId: $controllerId)
  }
`

export const LIST_HISTORY_SESSIONS = gql`
  query ListHistorySessions($controllerId: ID!, $workspaceId: ID!, $acpServerType: AcpServerType = opencode) {
    listHistorySessions(controllerId: $controllerId, workspaceId: $workspaceId, acpServerType: $acpServerType) {
      sessionId
      title
      cwd
      updatedAt
    }
  }
`

export const DETECT_GIT_REPO = gql`
  query DetectGitRepo($controllerId: ID!, $workspaceId: ID!) {
    detectGitRepo(controllerId: $controllerId, workspaceId: $workspaceId) {
      isGitRepo
      currentBranch
      branches
      defaultBranch
    }
  }
`

export const GET_GATEWAYS = gql`
  query GetGateways($controllerId: ID!) {
    gateways(controllerId: $controllerId) {
      gateways {
        id
        controllerId
        name
        port
        status
        createdAt
      }
      total
      limit
    }
  }
`

export const GET_TODO_LIST = gql`
  query GetTodoList {
    getTodoList {
      id
      type
      priority
      title
      description
      isRead
      data {
        requestId
        sessionId
        toolCallId
        toolCall {
          toolCallId
          title
          kind
          rawInput
          locations
        }
        options {
          optionId
          name
          kind
        }
      }
      elicitationData {
        requestId
        sessionId
        toolCallId
        mode
        message
        requestedSchema
        elicitationId
        url
      }
      createdAt
    }
  }
`

export const GET_UNREAD_TODO_COUNT = gql`
  query GetUnreadTodoCount {
    getUnreadTodoCount
  }
`

export const GET_MCP_SERVERS = gql`
  query GetMcpServers {
    mcpServers {
      id
      name
      transport
      source
      enabled
      command
      url
      hostname
      status
      tools {
        name
        description
      }
      toolsSyncedAt
      lastHeartbeatAt
      createdAt
      updatedAt
    }
  }
`

export const GET_GITHUB_ACCOUNTS = gql`
  query GetGithubAccounts {
    githubAccounts {
      id
      githubUserId
      githubLogin
      githubAvatarUrl
      createdAt
      installations {
        id
        installationId
        managementUrl
        repos {
          id
          repoId
          repoName
          fullName
          private
          permissions {
            read
            write
          }
        }
      }
    }
  }
`

export const GET_GITHUB_APP_URL = gql`
  query GetGithubAppUrl {
    githubAppUrl {
      url
      state
    }
  }
`

export const WORKSPACE_WORKTREES = gql`
  query WorkspaceWorktrees($controllerId: ID!, $workspaceId: ID!) {
    workspaceWorktrees(controllerId: $controllerId, workspaceId: $workspaceId) {
      path
      branch
      sessionCount
      sessions {
        id
        title
        status
        worktreePath
      }
    }
  }
`

export const GET_MCP_SERVER = gql`
  query GetMcpServer($id: ID!) {
    mcpServer(id: $id) {
      id
      name
      transport
      source
      enabled
      command
      url
      hostname
      status
      tools {
        name
        description
      }
      toolsSyncedAt
      lastHeartbeatAt
      createdAt
      updatedAt
    }
  }
`

// ---------- 我的费用（contracts/billing.graphql） ----------

export const MY_BILLING_ACCOUNT = gql`
  query MyBillingAccount {
    myBillingAccount {
      id
      ownerType
      ownerId
      ownerName
      cashBalance
      giftBalance
      creditLimit
      frozenAmount
      availableBalance
      status
      insufficientSince
      ledgerCount
      createdAt
      updatedAt
    }
  }
`

export const MY_BILLING_INVOICES = gql`
  query MyBillingInvoices($from: String, $to: String, $type: BillingLedgerType, $category: BillingCategory, $page: Int, $pageSize: Int) {
    myBillingInvoices(from: $from, to: $to, type: $type, category: $category, page: $page, pageSize: $pageSize) {
      id
      accountId
      seq
      type
      category
      amount
      balanceAfter
      refType
      refId
      description
      items { productId quantity unitPrice amount meteringRef }
      receiptId
      createdAt
    }
  }
`

export const MY_BILLING_RECEIPTS = gql`
  query MyBillingReceipts($page: Int, $pageSize: Int) {
    myBillingReceipts(page: $page, pageSize: $pageSize) {
      id
      receiptNo
      invoiceId
      accountId
      amount
      balanceAfter
      issuedAt
    }
  }
`

export const MY_BILLING_ROLLUPS = gql`
  query MyBillingRollups($granularity: BillingRollupGranularity!, $from: String!, $to: String!) {
    myBillingRollups(granularity: $granularity, from: $from, to: $to) {
      bucketStart
      chargeTotal
      rechargeTotal
      chargeCount
    }
  }
`

export const MY_BILLING_API_KEYS = gql`
  query MyBillingApiKeys {
    myBillingApiKeys {
      id
      name
      keyPrefix
      status
      lastUsedAt
      createdAt
    }
  }
`
