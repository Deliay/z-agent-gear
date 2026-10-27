import { gql } from '@apollo/client'

export const ADMIN_ME = gql`
  query AdminMe {
    adminMe {
      id
      username
      mustChangePassword
      createdAt
      updatedAt
    }
  }
`

export const ADMIN_PROVIDERS = gql`
  query AdminProviders {
    adminProviders {
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
    }
  }
`

export const ADMIN_MODELS = gql`
  query AdminModels {
    adminModels {
      id
      providerId
      provider {
        id
        name
        type
        isEnabled
        scope
      }
      name
      isCustom
      isEnabled
      sortOrder
      scope
      contextLength
      pricing {
        inputPerMillion
        cachedInputPerMillion
        outputPerMillion
        isBillable
      }
      createdAt
      updatedAt
    }
  }
`

export const ADMIN_MODELS_BY_PROVIDER = gql`
  query AdminModelsByProvider($providerId: ID!) {
    adminModelsByProvider(providerId: $providerId) {
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

export const LIST_GLOBAL_PROVIDER_MODELS = gql`
  query ListGlobalProviderModels($providerId: ID!) {
    listGlobalProviderModels(providerId: $providerId) {
      name
      isImported
      isDuplicate
    }
  }
`

export const MODEL_RENAME_RECORDS = gql`
  query ModelRenameRecords {
    modelRenameRecords {
      id
      modelId
      providerId
      providerName
      oldName
      newName
      batchId
      renamedAt
    }
  }
`

export const BASE_IMAGES = gql`
  query BaseImages {
    baseImages {
      id
      name
      description
      dockerfile
      createdAt
      updatedAt
    }
  }
`

export const BASE_IMAGE = gql`
  query BaseImage($id: ID!) {
    baseImage(id: $id) {
      id
      name
      description
      dockerfile
      createdAt
      updatedAt
    }
  }
`

export const ADMIN_CLOUD_CONTAINERS = gql`
  query AdminCloudContainers {
    adminCloudContainers {
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
    }
    adminCloudContainerControlPlane {
      online
      message
    }
  }
`

export const ADMIN_CLOUD_WORKLOADS = gql`
  query AdminCloudWorkloads {
    adminCloudWorkloads {
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
      workloadKind
      harnessType
      createdAt
      updatedAt
    }
  }
`

export const ADMIN_CLOUD_WORKLOAD_LOGS = gql`
  query AdminCloudContainerWorkloadLogs($containerId: ID!) {
    adminCloudContainerWorkloadLogs(containerId: $containerId) {
      id
      containerId
      workloadId
      workloadName
      phase
      status
      script
      params
      required
      exitCode
      log
      startedAt
      finishedAt
    }
  }
`

// ---------- 费用中心（contracts/admin-billing.graphql） ----------

const BILLING_ACCOUNT_FIELDS = `
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
`

const BILLING_INVOICE_FIELDS = `
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
  items { productId quantity unitPrice amount meteringRef segment }
  receiptId
  createdAt
`

const BILLING_RECEIPT_FIELDS = `
  id
  receiptNo
  invoiceId
  accountId
  amount
  balanceAfter
  issuedAt
`

export const ADMIN_BILLING_ACCOUNTS = gql`
  query AdminBillingAccounts($keyword: String, $ownerType: BillingOwnerType, $page: Int, $pageSize: Int) {
    adminBillingAccounts(keyword: $keyword, ownerType: $ownerType, page: $page, pageSize: $pageSize) {
      ${BILLING_ACCOUNT_FIELDS}
    }
  }
`

export const ADMIN_BILLING_ACCOUNT = gql`
  query AdminBillingAccount($id: ID!) {
    adminBillingAccount(id: $id) {
      ${BILLING_ACCOUNT_FIELDS}
    }
  }
`

export const ADMIN_BILLING_INVOICES = gql`
  query AdminBillingInvoices($accountId: ID!, $from: String, $to: String, $type: BillingLedgerType, $category: BillingCategory, $page: Int, $pageSize: Int) {
    adminBillingInvoices(accountId: $accountId, from: $from, to: $to, type: $type, category: $category, page: $page, pageSize: $pageSize) {
      ${BILLING_INVOICE_FIELDS}
    }
  }
`

export const ADMIN_BILLING_RECEIPTS = gql`
  query AdminBillingReceipts($accountId: ID!, $page: Int, $pageSize: Int) {
    adminBillingReceipts(accountId: $accountId, page: $page, pageSize: $pageSize) {
      ${BILLING_RECEIPT_FIELDS}
    }
  }
`

// D-1：按账单直查收据，避免「账单分页 rank 与收据分页 rank 不一致」导致误报暂无收据。
export const ADMIN_BILLING_RECEIPT = gql`
  query AdminBillingReceipt($invoiceId: ID!) {
    adminBillingReceipt(invoiceId: $invoiceId) {
      ${BILLING_RECEIPT_FIELDS}
    }
  }
`

export const ADMIN_BILLING_ROLLUPS = gql`
  query AdminBillingRollups($accountId: ID!, $granularity: BillingRollupGranularity!, $from: String!, $to: String!) {
    adminBillingRollups(accountId: $accountId, granularity: $granularity, from: $from, to: $to) {
      bucketStart
      chargeTotal
      rechargeTotal
      chargeCount
    }
  }
`

export const ADMIN_BILLING_RESERVATIONS = gql`
  query AdminBillingReservations($accountId: ID, $status: ReservationStatus) {
    adminBillingReservations(accountId: $accountId, status: $status) {
      id
      accountId
      resourceId
      status
      reservedTotal
      settledTotal
      releasedTotal
      startedAt
      lastSettleAt
    }
  }
`

export const ADMIN_RECONCILIATION_REPORTS = gql`
  query AdminReconciliationReports($line: String) {
    adminReconciliationReports(line: $line) {
      line
      ranAt
      checkedCount
      errorCount
      errors
    }
  }
`

export const ADMIN_BILLING_API_KEYS = gql`
  query AdminBillingApiKeys {
    adminBillingApiKeys {
      id
      name
      keyPrefix
      status
      lastUsedAt
      createdAt
    }
  }
`

export const ADMIN_BILLING_API_CALLS = gql`
  query AdminBillingApiCalls($accountId: ID!, $status: String, $page: Int, $pageSize: Int) {
    adminBillingApiCalls(accountId: $accountId, status: $status, page: $page, pageSize: $pageSize) {
      id
      requestId
      modelId
      modelName
      inputTokens
      cachedInputTokens
      outputTokens
      cost
      status
      estimated
      invoiceSeq
      startedAt
      finishedAt
    }
  }
`

// ---------- 租户管理（contracts/admin-tenant.graphql，只读视图 + 开户） ----------

export const ADMIN_TENANTS = gql`
  query AdminTenants($keyword: String, $page: Int, $pageSize: Int) {
    adminTenants(keyword: $keyword, page: $page, pageSize: $pageSize) {
      id
      name
      type
      memberCount
      balance
      createdAt
    }
  }
`

export const ADMIN_TENANT = gql`
  query AdminTenant($id: ID!) {
    adminTenant(id: $id) {
      id
      name
      type
      createdAt
      users {
        id
        name
        username
        createdAt
      }
    }
  }
`
