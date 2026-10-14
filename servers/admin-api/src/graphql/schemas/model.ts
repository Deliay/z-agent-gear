export const modelTypeDefs = `#graphql
  type Model {
    id: ID!
    providerId: ID!
    provider: Provider!
    name: String!
    isCustom: Boolean!
    isEnabled: Boolean!
    sortOrder: Int!
    scope: ConfigScope!
    createdAt: String!
    updatedAt: String!
  }

  input CustomModelInput {
    providerId: ID!
    name: String!
  }

  extend type Query {
    adminModels: [Model!]!
    adminModelsByProvider(providerId: ID!): [Model!]!
  }

  extend type Mutation {
    createGlobalCustomModel(input: CustomModelInput!): Model!
    deleteGlobalCustomModel(id: ID!): Model!
    toggleGlobalModel(id: ID!): Model!
    updateGlobalModelSortOrder(ids: [ID!]!): [Model!]!
  }
`;
