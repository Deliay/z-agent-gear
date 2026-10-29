export const modelTypeDefs = `#graphql
  type Model {
    id: ID!
    # 后台（scope=global）模型掩蔽来源 providerId（返回 null），避免按 id 反查后台供应商；
    # user 模型仍返回自身 providerId。悬空 providerId 亦可能为 null。
    providerId: ID
    # provider 可为空：global 模型（系统内置）不暴露后台供应商摘要，固定返回 null；
    # user 模型在 providerId 悬空（关联供应商已不存在）时返回 null，
    # 避免非空违规导致整条 models 查询失败。
    provider: ProviderSummary
    name: String!
    isCustom: Boolean!
    isEnabled: Boolean!
    sortOrder: Int!
    scope: ConfigScope!
    # 所属租户工作区 id（scope=global 恒 null）；读 = 当前 ∪ 本租户全局，写仅当前
    workspaceId: ID
    # 模型定价（只读展示）；与 admin-llm.graphql 逐字一致。
    pricing: ModelPricing
    # 最长上下文大小（token）；null = 未设置（只读，与 admin-llm.graphql 同步演进）
    contextLength: Int
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
