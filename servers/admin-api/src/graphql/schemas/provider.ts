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
`;
