// 与 contracts/admin-cloud-container.graphql 逐字段一致。
// 鉴权：所有 Query/Mutation 需 admin JWT；未认证 UNAUTHENTICATED（由 resolver 守卫抛出）。
export const cloudContainerTypeDefs = `#graphql
  type CloudContainer {
    id: ID!
    name: String!
    status: CloudContainerStatus!
    purpose: CloudContainerPurpose!
    refId: String
    createdAt: String!
    connectedAt: String
    exitedAt: String
    exitReason: String
    # 容器启动时挂载的工作负载，按选择顺序返回；已删除的工作负载会被省略（不返回空占位）
    workloads: [CloudWorkload!]!
    # 初始化中（INITIALIZING）当前正在执行的工作负载脚本名称；非初始化中为 null
    currentWorkloadName: String
  }

  type CloudContainerControlPlane {
    online: Boolean!
    message: String
  }

  enum CloudContainerStatus {
    CREATING
    CONNECTING
    INITIALIZING
    ONLINE
    EXITED
    DESTROYING
    FAILED
  }

  enum CloudContainerPurpose {
    IDLE
    ADMIN_TASK
    WORKFLOW
    SESSION
  }

  extend type Query {
    adminCloudContainers: [CloudContainer!]!
    adminCloudContainerControlPlane: CloudContainerControlPlane!
  }

  extend type Mutation {
    # 启动一个工作容器；本期 purpose 仅支持 IDLE。
    # workloadIds 与 workloads 二选一，同时非空返回错误
    # "workloadIds and workloads cannot both be provided"：
    # - workloadIds（兼容旧调用）：等价于所有工作负载使用默认参数；
    # - workloads（新调用）：每项携带 params（缺省字段使用默认值），服务端展开隐式依赖、
    #   去重、按拓扑序排序并归一参数后下发（展开后 >10 → "expanded workloads exceed 10"，
    #   重复 → "duplicate workload selection"，依赖不存在 → "dependency workload not found"）。
    adminStartCloudContainer(
      purpose: CloudContainerPurpose!
      workloadIds: [ID!]
      workloads: [CloudWorkloadSelectionInput!]
    ): CloudContainer!
    adminDestroyCloudContainer(id: ID!): Boolean!
  }
`;
