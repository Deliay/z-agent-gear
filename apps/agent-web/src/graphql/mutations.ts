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
