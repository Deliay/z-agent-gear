export const providerTypeDefs = `#graphql
  enum ProviderType {
    OpenAI
    Anthropic
  }

  enum CredentialType {
    api_key
  }

  type Provider {
    id: ID!
    name: String!
    type: ProviderType!
    endpoint: String!
    credentialType: CredentialType!
    credentialValue: String!
    isEnabled: Boolean!
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
