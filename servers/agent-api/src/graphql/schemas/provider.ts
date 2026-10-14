export const providerTypeDefs = `#graphql
  enum ProviderType {
    OpenAI
    Anthropic
  }

  enum CredentialType {
    api_key
  }

  # 配置归属：user 为用户侧配置，global 为管理后台全局配置。
  # global 且 isEnabled 的模型对所有用户可用。
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
    providers: [Provider!]!
  }

  extend type Mutation {
    createProvider(input: ProviderInput!): Provider!
    updateProvider(id: ID!, input: ProviderInput!): Provider!
    deleteProvider(id: ID!): Boolean!
    toggleProvider(id: ID!): Provider!
    batchEnableProviders(ids: [ID!]!): ProviderBatchPayload!
    batchDisableProviders(ids: [ID!]!): ProviderBatchPayload!
    batchDeleteProviders(ids: [ID!]!): ProviderBatchPayload!
  }
`;
