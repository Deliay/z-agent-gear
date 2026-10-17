import { gql } from '@apollo/client'

export const ADMIN_LOGIN = gql`
  mutation AdminLogin($username: String!, $password: String!) {
    adminLogin(username: $username, password: $password) {
      token
      admin {
        id
        username
        mustChangePassword
      }
    }
  }
`

export const CHANGE_ADMIN_PASSWORD = gql`
  mutation ChangeAdminPassword($oldPassword: String!, $newPassword: String!) {
    changeAdminPassword(oldPassword: $oldPassword, newPassword: $newPassword) {
      token
      admin {
        id
        username
        mustChangePassword
      }
    }
  }
`

const PROVIDER_FIELDS = `
  id
  name
  type
  endpoint
  credentialType
  credentialValue
  isEnabled
  scope
  models {
    id
    providerId
    name
    isCustom
    isEnabled
    sortOrder
    scope
  }
  createdAt
  updatedAt
`

export const CREATE_GLOBAL_PROVIDER = gql`
  mutation CreateGlobalProvider($input: ProviderInput!) {
    createGlobalProvider(input: $input) {
      ${PROVIDER_FIELDS}
    }
  }
`

export const UPDATE_GLOBAL_PROVIDER = gql`
  mutation UpdateGlobalProvider($id: ID!, $input: ProviderInput!) {
    updateGlobalProvider(id: $id, input: $input) {
      ${PROVIDER_FIELDS}
    }
  }
`

export const DELETE_GLOBAL_PROVIDER = gql`
  mutation DeleteGlobalProvider($id: ID!) {
    deleteGlobalProvider(id: $id)
  }
`

export const TOGGLE_GLOBAL_PROVIDER = gql`
  mutation ToggleGlobalProvider($id: ID!) {
    toggleGlobalProvider(id: $id) {
      id
      isEnabled
      models {
        id
        isEnabled
      }
    }
  }
`

export const BATCH_ENABLE_GLOBAL_PROVIDERS = gql`
  mutation BatchEnableGlobalProviders($ids: [ID!]!) {
    batchEnableGlobalProviders(ids: $ids) {
      successCount
    }
  }
`

export const BATCH_DISABLE_GLOBAL_PROVIDERS = gql`
  mutation BatchDisableGlobalProviders($ids: [ID!]!) {
    batchDisableGlobalProviders(ids: $ids) {
      successCount
    }
  }
`

export const BATCH_DELETE_GLOBAL_PROVIDERS = gql`
  mutation BatchDeleteGlobalProviders($ids: [ID!]!) {
    batchDeleteGlobalProviders(ids: $ids) {
      successCount
    }
  }
`

export const CREATE_GLOBAL_CUSTOM_MODEL = gql`
  mutation CreateGlobalCustomModel($input: CustomModelInput!) {
    createGlobalCustomModel(input: $input) {
      id
      providerId
      name
      isCustom
      isEnabled
      sortOrder
      scope
    }
  }
`

export const DELETE_GLOBAL_CUSTOM_MODEL = gql`
  mutation DeleteGlobalCustomModel($id: ID!) {
    deleteGlobalCustomModel(id: $id) {
      id
    }
  }
`

export const TOGGLE_GLOBAL_MODEL = gql`
  mutation ToggleGlobalModel($id: ID!) {
    toggleGlobalModel(id: $id) {
      id
      isEnabled
    }
  }
`

export const UPDATE_GLOBAL_MODEL_SORT_ORDER = gql`
  mutation UpdateGlobalModelSortOrder($ids: [ID!]!) {
    updateGlobalModelSortOrder(ids: $ids) {
      id
      sortOrder
    }
  }
`

export const CREATE_BASE_IMAGE = gql`
  mutation CreateBaseImage($input: BaseImageInput!) {
    createBaseImage(input: $input) {
      id
      name
      description
      dockerfile
      createdAt
      updatedAt
    }
  }
`

export const UPDATE_BASE_IMAGE = gql`
  mutation UpdateBaseImage($id: ID!, $input: BaseImageInput!) {
    updateBaseImage(id: $id, input: $input) {
      id
      name
      description
      dockerfile
      createdAt
      updatedAt
    }
  }
`

export const DELETE_BASE_IMAGE = gql`
  mutation DeleteBaseImage($id: ID!) {
    deleteBaseImage(id: $id)
  }
`

const CLOUD_CONTAINER_FIELDS = `
  id
  name
  status
  purpose
  refId
  createdAt
  connectedAt
  exitedAt
  exitReason
  workloads {
    id
    name
  }
  currentWorkloadName
`

export const ADMIN_START_CLOUD_CONTAINER = gql`
  mutation AdminStartCloudContainer($purpose: CloudContainerPurpose!, $workloadIds: [ID!]) {
    adminStartCloudContainer(purpose: $purpose, workloadIds: $workloadIds) {
      ${CLOUD_CONTAINER_FIELDS}
    }
  }
`

export const ADMIN_DESTROY_CLOUD_CONTAINER = gql`
  mutation AdminDestroyCloudContainer($id: ID!) {
    adminDestroyCloudContainer(id: $id)
  }
`

export const CREATE_CLOUD_WORKLOAD = gql`
  mutation AdminCreateCloudWorkload($input: CreateCloudWorkloadInput!) {
    adminCreateCloudWorkload(input: $input) {
      id
      name
      initScript
      postScript
      createdAt
      updatedAt
    }
  }
`

export const UPDATE_CLOUD_WORKLOAD = gql`
  mutation AdminUpdateCloudWorkload($id: ID!, $input: UpdateCloudWorkloadInput!) {
    adminUpdateCloudWorkload(id: $id, input: $input) {
      id
      name
      initScript
      postScript
      createdAt
      updatedAt
    }
  }
`

export const DELETE_CLOUD_WORKLOAD = gql`
  mutation AdminDeleteCloudWorkload($id: ID!) {
    adminDeleteCloudWorkload(id: $id)
  }
`
