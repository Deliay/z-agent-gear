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
    # 最长上下文大小（token）；null = 未设置。用户自有（scope=user）模型可经
    # updateModelContextLength 编辑；global 模型只读（后台管理）。与 admin-llm.graphql 同步演进。
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
    # 新增：最长上下文大小（token，正整数）；缺省/传 null = 未设置。
    # 缺省时服务端会尽力从供应商上游元数据自动补全（取不到则保持未设置）。
    contextLength: Int
  }

  # 供应商上游模型清单条目（用于新增自定义模型时预填上下文长度）。
  type ProviderModelOption {
    name: String!
    # 上游尽力提供的上下文长度（token）；取不到为 null。
    contextLength: Int
  }

  extend type Query {
    models: [Model!]!
    modelsByProvider(providerId: ID!): [Model!]!
    # 拉取用户自有供应商的上游模型清单（含尽力获取的上下文长度）；不在服务端缓存。
    providerModelOptions(providerId: ID!): [ProviderModelOption!]!
  }

  extend type Mutation {
    createCustomModel(input: CustomModelInput!): Model!
    deleteCustomModel(id: ID!): Model!
    toggleModel(id: ID!): Model!
    updateModelSortOrder(ids: [ID!]!): [Model!]!
    # 编辑用户自有模型的上下文长度（正整数；null = 清空）。
    # global 模型 / 他人工作区 / 不存在统一返回 Model not found。
    updateModelContextLength(modelId: ID!, contextLength: Int): Model!
  }

  # 运行期下发注记：上述用户侧模型/供应商 mutation 成功后，服务端会以 best-effort
  # fire-and-forget 方式把最新模型清单实时下发到该租户运行中的云电脑（失败只告警，
  # 不影响 mutation 返回）；部分 Harness 运行时不会重载模型配置，前端需在保存成功时提醒用户。
  # 模型启停对 OpenAI 兼容网关逐请求生效：禁用后新请求立即返回模型不可用，进行中的请求不受影响。
`;
