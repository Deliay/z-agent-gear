export const modelTypeDefs = `#graphql
  type Model {
    id: ID!
    providerId: ID!
    # provider 可为空：providerId 悬空（关联供应商已不存在）时返回 null，
    # 避免非空违规导致整条 adminModels 查询失败。
    provider: Provider
    name: String!
    isCustom: Boolean!
    isEnabled: Boolean!
    sortOrder: Int!
    scope: ConfigScope!
    # 费用中心模型定价（便捷编辑视图）；价目真相在 productprices。
    pricing: ModelPricing
    createdAt: String!
    updatedAt: String!
  }

  # credits / 百万 token（边界展示为 credits，持久层整数分）
  type ModelPricing {
    inputPerMillion: Float!
    cachedInputPerMillion: Float!
    outputPerMillion: Float!
    isBillable: Boolean!
  }

  input ModelPricingInput {
    inputPerMillion: Float!
    cachedInputPerMillion: Float!
    outputPerMillion: Float!
    isBillable: Boolean! = true
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
