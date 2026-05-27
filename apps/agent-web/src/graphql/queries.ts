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
      createdAt
      updatedAt
      endedAt
    }
  }
`

export const GET_SESSION_MESSAGES = gql`
  query GetSessionMessages($sessionId: ID!, $limit: Int, $offset: Int) {
    sessionMessages(sessionId: $sessionId, limit: $limit, offset: $offset) {
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
  query ListHistorySessions($controllerId: ID!, $workspaceId: ID!) {
    listHistorySessions(controllerId: $controllerId, workspaceId: $workspaceId) {
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

export const GET_PORT_FORWARDS = gql`
  query GetPortForwards($controllerId: ID!) {
    portForwards(controllerId: $controllerId) {
      portForwards {
        id
        controllerId
        port
        status
        createdAt
      }
      total
      limit
    }
  }
`
