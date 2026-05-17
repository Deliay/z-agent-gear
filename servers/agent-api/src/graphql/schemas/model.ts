export const modelTypeDefs = `#graphql
  type Model {
    id: ID!
    providerId: ID!
    provider: Provider!
    name: String!
    isCustom: Boolean!
    isEnabled: Boolean!
    sortOrder: Int!
    createdAt: String!
    updatedAt: String!
  }

  input CustomModelInput {
    providerId: ID!
    name: String!
  }

  type ModelBatchPayload {
    successCount: Int!
  }

  extend type Query {
    models: [Model!]!
    modelsByProvider(providerId: ID!): [Model!]!
  }

  extend type Mutation {
    createCustomModel(input: CustomModelInput!): Model!
    deleteCustomModel(id: ID!): Model!
    toggleModel(id: ID!): Model!
    updateModelSortOrder(ids: [ID!]!): [Model!]!
  }
`;
