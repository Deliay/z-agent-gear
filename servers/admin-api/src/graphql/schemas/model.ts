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
    # 最长上下文大小（token）；null = 未设置（与 llm.graphql 同步演进）
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

  input ModelPricingInput {
    inputPerMillion: Float!
    cachedInputPerMillion: Float!
    outputPerMillion: Float!
    isBillable: Boolean! = true
  }

  input CustomModelInput {
    providerId: ID!
    name: String!
    # 可选：新增时即设置最长上下文（token，正整数）；缺省 = 未设置
    contextLength: Int
  }

  # 上游模型清单条目（导入弹窗数据源）
  type ProviderModelOption {
    name: String! # 上游模型名（已 trim/去重，保持上游顺序）
    contextLength: Int # 上游尽力提供的上下文长度（token）；取不到为 null
    isImported: Boolean! # 该供应商下已存在
    isDuplicate: Boolean! # 已被其他供应商的 global 模型占用（全局唯一冲突）
  }

  # 历史重名整理台账（迁移 005 写入，只读）
  type ModelRenameRecord {
    id: ID!
    modelId: ID!
    providerId: ID!
    providerName: String!
    oldName: String!
    newName: String!
    batchId: String!
    renamedAt: String!
  }

  extend type Query {
    adminModels: [Model!]!
    adminModelsByProvider(providerId: ID!): [Model!]!
    listGlobalProviderModels(providerId: ID!): [ProviderModelOption!]!
    modelRenameRecords: [ModelRenameRecord!]!
  }

  extend type Mutation {
    createGlobalCustomModel(input: CustomModelInput!): Model!
    importGlobalModels(providerId: ID!, names: [String!]!): [Model!]!
    deleteGlobalModel(id: ID!): Model!
    toggleGlobalModel(id: ID!): Model!
    updateGlobalModelSortOrder(ids: [ID!]!): [Model!]!
    # 更新模型最长上下文（token）；传 null 表示清空（回到「未设置」）
    updateModelContextLength(modelId: ID!, contextLength: Int): Model!
  }

  # 运行期下发注记（与 contracts/admin-llm.graphql 逐字对齐）：
  # 上述 global 模型 mutation 成功后，服务端会以 best-effort fire-and-forget 方式通知 agent-api
  # 把最新模型清单实时下发到运行中的云电脑（失败只告警，不影响 mutation 返回）；
  # 部分 Harness 运行时不会重载模型配置，云电脑内已运行会话可能需要重启后生效。
  # 模型启停对 OpenAI 兼容网关逐请求生效：禁用后新请求立即返回模型不可用，进行中的请求不受影响。
`;
