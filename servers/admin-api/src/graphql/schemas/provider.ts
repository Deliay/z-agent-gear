// ConfigScope 全局仅定义一次（model.ts 复用，避免重复定义报错）
export const providerTypeDefs = `#graphql
  enum ProviderType {
    OpenAI
    Anthropic
  }

  enum CredentialType {
    api_key
  }

  enum ConfigScope {
    user
    global
  }

  type Provider {
    id: ID!
    name: String!
    type: ProviderType!
    endpoint: String!
    credentialType: CredentialType!
    credentialValue: String!
    isEnabled: Boolean!
    scope: ConfigScope!
    models: [Model!]!
    createdAt: String!
    updatedAt: String!
  }

  input ProviderInput {
    name: String!
    type: ProviderType!
    endpoint: String!
    credentialType: CredentialType! = api_key
    credentialValue: String!
  }

  type ProviderBatchPayload {
    successCount: Int!
  }

  extend type Query {
    adminProviders: [Provider!]!
  }

  extend type Mutation {
    createGlobalProvider(input: ProviderInput!): Provider!
    updateGlobalProvider(id: ID!, input: ProviderInput!): Provider!
    deleteGlobalProvider(id: ID!): Boolean!
    toggleGlobalProvider(id: ID!): Provider!
    batchEnableGlobalProviders(ids: [ID!]!): ProviderBatchPayload!
    batchDisableGlobalProviders(ids: [ID!]!): ProviderBatchPayload!
    batchDeleteGlobalProviders(ids: [ID!]!): ProviderBatchPayload!
  }

  # 运行期下发注记（与 contracts/admin-llm.graphql 逐字对齐）：
  # 上述 global 供应商 mutation 成功后，服务端会以 best-effort fire-and-forget 方式通知 agent-api
  # 把最新模型清单（含供应商显示名）实时下发到运行中的云电脑；失败只告警，不影响 mutation 返回。
  # 部分 Harness 运行时不会重载模型配置；模型启停/供应商禁用对网关逐请求立即生效。
`;
