export const modelTypeDefs = `#graphql
  type Model {
    id: ID!
    providerId: ID!
    # provider 可为空：providerId 悬空（关联供应商已不存在）时返回 null，
    # 避免非空违规导致整条 models 查询失败。
    provider: ProviderSummary
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
