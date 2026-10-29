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
      contextLength
    }
  }
`

export const UPDATE_MODEL_CONTEXT_LENGTH = gql`
  mutation UpdateModelContextLength($modelId: ID!, $contextLength: Int) {
    updateModelContextLength(modelId: $modelId, contextLength: $contextLength) {
      id
      name
      contextLength
    }
  }
`

export const DELETE_GLOBAL_MODEL = gql`
  mutation DeleteGlobalModel($id: ID!) {
    deleteGlobalModel(id: $id) {
      id
    }
  }
`

export const IMPORT_GLOBAL_MODELS = gql`
  mutation ImportGlobalModels($providerId: ID!, $names: [String!]!) {
    importGlobalModels(providerId: $providerId, names: $names) {
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
  mutation AdminStartCloudContainer(
    $purpose: CloudContainerPurpose!
    $workloadIds: [ID!]
    $workloads: [CloudWorkloadSelectionInput!]
  ) {
    adminStartCloudContainer(purpose: $purpose, workloadIds: $workloadIds, workloads: $workloads) {
      ${CLOUD_CONTAINER_FIELDS}
    }
  }
`

export const ADMIN_DESTROY_CLOUD_CONTAINER = gql`
  mutation AdminDestroyCloudContainer($id: ID!) {
    adminDestroyCloudContainer(id: $id)
  }
`

const CLOUD_WORKLOAD_FIELDS = `
  id
  name
  initScript
  postScript
  paramSchema {
    key
    label
    type
    options
    defaultValue
  }
  dependsOnWorkloadIds
  isPreset
  createdAt
  updatedAt
`

export const CREATE_CLOUD_WORKLOAD = gql`
  mutation AdminCreateCloudWorkload($input: CreateCloudWorkloadInput!) {
    adminCreateCloudWorkload(input: $input) {
      ${CLOUD_WORKLOAD_FIELDS}
    }
  }
`

export const UPDATE_CLOUD_WORKLOAD = gql`
  mutation AdminUpdateCloudWorkload($id: ID!, $input: UpdateCloudWorkloadInput!) {
    adminUpdateCloudWorkload(id: $id, input: $input) {
      ${CLOUD_WORKLOAD_FIELDS}
    }
  }
`

export const DELETE_CLOUD_WORKLOAD = gql`
  mutation AdminDeleteCloudWorkload($id: ID!) {
    adminDeleteCloudWorkload(id: $id)
  }
`

// ---------- 费用中心（contracts/admin-billing.graphql） ----------

export const RECHARGE_BILLING_ACCOUNT = gql`
  mutation RechargeBillingAccount($accountId: ID!, $amount: Float!, $note: String) {
    rechargeBillingAccount(accountId: $accountId, amount: $amount, note: $note) {
      id
      accountId
      seq
      type
      category
      amount
      balanceAfter
      description
      createdAt
    }
  }
`

export const SET_BILLING_ACCOUNT_CREDIT_LIMIT = gql`
  mutation SetBillingAccountCreditLimit($accountId: ID!, $creditLimit: Float!) {
    setBillingAccountCreditLimit(accountId: $accountId, creditLimit: $creditLimit) {
      id
      creditLimit
      availableBalance
    }
  }
`

export const SET_BILLING_ACCOUNT_STATUS = gql`
  mutation SetBillingAccountStatus($accountId: ID!, $status: String!) {
    setBillingAccountStatus(accountId: $accountId, status: $status) {
      id
      status
    }
  }
`

export const RECONCILE_BILLING_ACCOUNT = gql`
  mutation ReconcileBillingAccount($accountId: ID!) {
    reconcileBillingAccount(accountId: $accountId) {
      id
      cashBalance
      frozenAmount
      availableBalance
    }
  }
`

export const RUN_RECONCILIATION = gql`
  mutation RunReconciliation($line: String) {
    runReconciliation(line: $line) {
      line
      ranAt
      checkedCount
      errorCount
      errors
    }
  }
`

export const UPDATE_MODEL_PRICING = gql`
  mutation UpdateModelPricing($modelId: ID!, $pricing: ModelPricingInput!) {
    updateModelPricing(modelId: $modelId, pricing: $pricing) {
      id
      name
      pricing {
        inputPerMillion
        cachedInputPerMillion
        outputPerMillion
        isBillable
      }
    }
  }
`

export const CREATE_BILLING_API_KEY = gql`
  mutation CreateBillingApiKey($name: String!) {
    createBillingApiKey(name: $name) {
      apiKey { id name keyPrefix status lastUsedAt createdAt }
      secret
    }
  }
`

export const REVOKE_BILLING_API_KEY = gql`
  mutation RevokeBillingApiKey($id: ID!) {
    revokeBillingApiKey(id: $id) {
      id
      name
      keyPrefix
      status
      lastUsedAt
      createdAt
    }
  }
`

// ---------- 租户开户 / team 租户与成员管理（contracts/admin-tenant.graphql） ----------

export const ADMIN_CREATE_FRONT_USER = gql`
  mutation AdminCreateFrontUser($username: String!, $password: String!) {
    adminCreateFrontUser(username: $username, password: $password) {
      id
      name
      username
      role
      createdAt
    }
  }
`

export const ADMIN_CREATE_TEAM_TENANT = gql`
  mutation AdminCreateTeamTenant($name: String!) {
    adminCreateTeamTenant(name: $name) {
      id
      name
      type
      memberCount
      balance
      createdAt
    }
  }
`

export const ADMIN_ADD_TENANT_MEMBER = gql`
  mutation AdminAddTenantMember($tenantId: ID!, $username: String!, $role: TenantRole) {
    adminAddTenantMember(tenantId: $tenantId, username: $username, role: $role) {
      id
      name
      username
      role
      createdAt
    }
  }
`

export const ADMIN_REMOVE_TENANT_MEMBER = gql`
  mutation AdminRemoveTenantMember($tenantId: ID!, $userId: ID!) {
    adminRemoveTenantMember(tenantId: $tenantId, userId: $userId)
  }
`
