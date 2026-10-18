// 与 contracts/admin-billing.graphql 逐字段一致（Model / ModelPricing 复用 admin-llm schema 定义）。
export const billingTypeDefs = `#graphql
  enum BillingOwnerType {
    front_user
    admin_user
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
    adminBillingRollups(
      accountId: ID!
      granularity: BillingRollupGranularity!
      from: String!
      to: String!
    ): [BillingRollup!]!
    adminBillingReservations(accountId: ID, status: ReservationStatus): [BillingReservation!]!
    adminReconciliationReports(line: String): [ReconciliationReport!]!
    adminBillingApiKeys: [BillingApiKey!]!
  }

  extend type Mutation {
    rechargeBillingAccount(accountId: ID!, amount: Float!, note: String): BillingInvoice!
    setBillingAccountCreditLimit(accountId: ID!, creditLimit: Float!): BillingAccount!
    setBillingAccountStatus(accountId: ID!, status: String!): BillingAccount!
    reconcileBillingAccount(accountId: ID!): BillingAccount!
    runReconciliation(line: String): [ReconciliationReport!]!
    updateModelPricing(modelId: ID!, pricing: ModelPricingInput!): Model!
    createBillingApiKey(name: String!): BillingApiKeyPayload!
    revokeBillingApiKey(id: ID!): BillingApiKey!
  }
`;
