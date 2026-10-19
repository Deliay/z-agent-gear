// 与 contracts/billing.graphql 逐字段一致。
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

  type BillingApiCall {
    id: ID!
    requestId: String!
    accountId: ID!
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

  extend type Query {
    myBillingAccount: BillingAccount!
    myBillingInvoices(
      from: String
      to: String
      type: BillingLedgerType
      category: BillingCategory
      page: Int
      pageSize: Int
    ): [BillingInvoice!]!
    myBillingReceipts(page: Int, pageSize: Int): [BillingReceipt!]!
    myBillingReceipt(invoiceId: ID!): BillingReceipt
    myBillingRollups(
      granularity: BillingRollupGranularity!
      from: String!
      to: String!
    ): [BillingRollup!]!
    myBillingApiKeys: [BillingApiKey!]!
    myBillingApiCalls(status: String, page: Int, pageSize: Int): [BillingApiCall!]!
  }

  extend type Mutation {
    createMyBillingApiKey(name: String!): BillingApiKeyPayload!
    revokeMyBillingApiKey(id: ID!): BillingApiKey!
  }
`;
