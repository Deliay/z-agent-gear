// 与 contracts/admin-cloud-workload.graphql 逐字段一致。
// 鉴权：所有 Query/Mutation 需 admin JWT；未认证 UNAUTHENTICATED（由 resolver 守卫抛出）。
// 校验：name trim 后 1~64 且唯一；initScript/postScript 各自 ≤16 KiB 且至少其一非空；
//      paramSchema（≤20、key 正则、label 1~64、options 1~50 去重、defaultValue 按类型合法）；
//      dependsOnWorkloadIds（≤5、存在、非自身、去重、禁环）。
// `scalar JSON` 在 admin-api 全部 typeDefs 中仅声明一次（本文件）。
export const cloudWorkloadTypeDefs = `#graphql
  # 参数值、默认值使用的 JSON 标量（string | string[] | boolean）。
  # JSON scalar 会绕过 GraphQL 静态类型，服务端必须做运行时类型与取值校验。
  scalar JSON

  # 参数字段类型
  enum CloudWorkloadParamType {
    SELECT # 下拉单选
    MULTI_SELECT # 下拉多选
    TEXT # 文本
    BOOLEAN # 布尔
  }

  # 工作负载分类：standard = 运行环境/工具，harness = 云电脑 harness
  enum CloudWorkloadKind {
    STANDARD
    HARNESS
  }

  # 单个参数定义
  type CloudWorkloadParamField {
    key: String! # 参数标识，工作负载内唯一，用于脚本中引用（WORKLOAD_PARAM_<KEY_UPPER>）
    label: String! # 展示名称
    type: CloudWorkloadParamType!
    options: [String!]! # SELECT/MULTI_SELECT 的可选项；其他类型为 []
    defaultValue: JSON! # 必填：string | string[] | boolean
  }

  input CloudWorkloadParamFieldInput {
    key: String!
    label: String!
    type: CloudWorkloadParamType!
    options: [String!]
    defaultValue: JSON!
  }

  type CloudWorkload {
    id: ID!
    name: String!
    initScript: String
    postScript: String
    paramSchema: [CloudWorkloadParamField!]! # 空数组表示无参数配置
    dependsOnWorkloadIds: [ID!]! # 依赖的工作负载，按配置顺序初始化；一期最多 5 个
    isPreset: Boolean! # 是否为预制工作负载（仅展示用）
    workloadKind: CloudWorkloadKind! # 历史数据缺省 STANDARD
    harnessType: String # harness 负载类型（如 opencode）；standard 为 null
    createdAt: String!
    updatedAt: String!
  }

  input CreateCloudWorkloadInput {
    name: String!
    initScript: String
    postScript: String
    paramSchema: [CloudWorkloadParamFieldInput!]
    dependsOnWorkloadIds: [ID!]
  }

  input UpdateCloudWorkloadInput {
    name: String
    initScript: String
    postScript: String
    paramSchema: [CloudWorkloadParamFieldInput!]
    dependsOnWorkloadIds: [ID!]
  }

  # 启动容器时对单个工作负载的选择与参数值
  input CloudWorkloadSelectionInput {
    workloadId: ID!
    params: JSON # 缺省/缺字段 = 使用该字段默认值
    # 本次启动是否将该项视为「必须」：缺省 false；仅 true 生效；
    # 仅对含初始化脚本的工作负载产生硬失败语义；其失败/超时会中断初始化并强制注销容器。
    required: Boolean
  }

  enum CloudWorkloadLogPhase {
    INIT
    POST
  }

  enum CloudWorkloadLogStatus {
    PENDING
    RUNNING
    SUCCESS
    FAILED
    TIMEOUT
  }

  enum CloudWorkloadLogTrigger {
    START
    RUNTIME
  }

  enum CloudWorkloadLogSource {
    ADMIN
    USER
    MCP
    SYSTEM
  }

  type CloudWorkloadLog {
    id: ID!
    containerId: ID!
    workloadId: ID!
    workloadName: String!
    phase: CloudWorkloadLogPhase!
    status: CloudWorkloadLogStatus!
    script: String!
    params: JSON! # 本次执行实际使用的参数值快照（已归一，含默认值）；历史记录缺省为 {}
    required: Boolean! # 本次启动该项是否为「必须」；历史记录缺省 false
    trigger: CloudWorkloadLogTrigger
    source: CloudWorkloadLogSource
    exitCode: Int
    log: String!
    startedAt: String
    finishedAt: String
  }

  extend type Query {
    adminCloudWorkloads: [CloudWorkload!]!
    adminCloudContainerWorkloadLogs(containerId: ID!): [CloudWorkloadLog!]!
  }

  extend type Mutation {
    adminCreateCloudWorkload(input: CreateCloudWorkloadInput!): CloudWorkload!
    adminUpdateCloudWorkload(id: ID!, input: UpdateCloudWorkloadInput!): CloudWorkload!
    adminDeleteCloudWorkload(id: ID!): Boolean!
  }
`;
