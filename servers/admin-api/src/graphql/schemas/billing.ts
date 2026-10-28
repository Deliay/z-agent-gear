// 与 contracts/admin-billing.graphql 逐字段一致（Model / ModelPricing 复用 admin-llm schema 定义）。
export const billingTypeDefs = `#graphql
  enum BillingOwnerType {
    front_user
    admin_user
    tenant
  }

  enum BillingLedgerType {
    charge
    recharge
    adjust
  }

  enum BillingCategory {
    container
    model
    manual
  }

  enum BillingRollupGranularity {
    minute
    hour
    day
  }

  enum ReservationStatus {
    PENDING
    ACTIVE
    SETTLING
    SETTLED
    RELEASE_PENDING
  }

  enum BillingApiKeyScope {
    ACCOUNT
    CLOUD_HOST
  }

  type BillingAccount {
    id: ID!
    ownerType: BillingOwnerType!
    ownerId: ID!
    ownerName: String!
    cashBalance: Float!
    giftBalance: Float!
    creditLimit: Float!
    frozenAmount: Float!
    availableBalance: Float!
    status: String!
    insufficientSince: String
    ledgerCount: Int!
    createdAt: String!
    updatedAt: String!
  }

  type BillingInvoice {
    id: ID!
    accountId: ID!
    seq: Int!
    type: BillingLedgerType!
    category: BillingCategory!
    amount: Float!
    balanceAfter: Float!
    refType: String
    refId: String
    description: String!
    items: [InvoiceItem!]!
    receiptId: ID
    createdAt: String!
  }

  type InvoiceItem {
    productId: String!
    quantity: Float!
    unitPrice: Float!
    amount: Float!
    meteringRef: ID
    segment: String
  }

  type BillingReceipt {
    id: ID!
    receiptNo: String!
    invoiceId: ID!
    accountId: ID!
    amount: Float!
    balanceAfter: Float!
    issuedAt: String!
  }

  type BillingRollup {
    bucketStart: String!
    chargeTotal: Float!
    rechargeTotal: Float!
    chargeCount: Int!
  }

  type BillingReservation {
    id: ID!
    accountId: ID!
    resourceId: String!
    status: ReservationStatus!
    reservedTotal: Float!
    settledTotal: Float!
    releasedTotal: Float!
    startedAt: String!
    lastSettleAt: String
  }

  type BillingApiKey {
    id: ID!
    name: String!
    keyPrefix: String!
    status: String!
    scope: BillingApiKeyScope!
    cloudHostId: ID
    expiresAt: String
    lastUsedAt: String
    createdAt: String!
  }

  type BillingApiKeyPayload {
    apiKey: BillingApiKey!
    secret: String!
  }

  type ReconciliationReport {
    line: String!
    ranAt: String!
    checkedCount: Int!
    errorCount: Int!
    errors: [JSON!]!
  }

  type BillingApiCall {
    id: ID!
    requestId: String!
    accountId: ID!
    cloudHostId: ID
    billable: Boolean!
    modelId: String!
    modelName: String!
    inputTokens: Int!
    cachedInputTokens: Int!
    outputTokens: Int!
    cost: Float!
    status: String!
    estimated: Boolean!
    invoiceSeq: Int
    startedAt: String!
    finishedAt: String
  }

  type BillingDeadLetter {
    id: ID!
    queue: String!
    routingKey: String!
    eventId: String
    error: String
    attempts: Int!
    createdAt: String!
  }

  extend type Query {
    adminBillingAccounts(
      keyword: String
      ownerType: BillingOwnerType
      page: Int
      pageSize: Int
    ): [BillingAccount!]!
    adminBillingAccount(id: ID!): BillingAccount!
    adminBillingInvoices(
      accountId: ID!
      from: String
      to: String
      type: BillingLedgerType
      category: BillingCategory
      page: Int
      pageSize: Int
    ): [BillingInvoice!]!
    adminBillingReceipts(accountId: ID!, page: Int, pageSize: Int): [BillingReceipt!]!
    adminBillingReceipt(invoiceId: ID!): BillingReceipt
    adminBillingRollups(
      accountId: ID!
      granularity: BillingRollupGranularity!
      from: String!
      to: String!
    ): [BillingRollup!]!
    adminBillingReservations(accountId: ID, status: ReservationStatus): [BillingReservation!]!
    adminReconciliationReports(line: String): [ReconciliationReport!]!
    adminBillingApiKeys: [BillingApiKey!]!
    adminBillingDeadLetters(limit: Int): [BillingDeadLetter!]!
    adminBillingApiCalls(
      accountId: ID!
      status: String
      page: Int
      pageSize: Int
    ): [BillingApiCall!]!
  }

  extend type Mutation {
    rechargeBillingAccount(accountId: ID!, amount: Float!, note: String, idempotencyKey: String): BillingInvoice!
    setBillingAccountCreditLimit(accountId: ID!, creditLimit: Float!): BillingAccount!
    setBillingAccountStatus(accountId: ID!, status: String!): BillingAccount!
    reconcileBillingAccount(accountId: ID!): BillingAccount!
    runReconciliation(line: String): [ReconciliationReport!]!
    updateModelPricing(modelId: ID!, pricing: ModelPricingInput!): Model!
    createBillingApiKey(name: String!): BillingApiKeyPayload!
    revokeBillingApiKey(id: ID!): BillingApiKey!
  }
`;
