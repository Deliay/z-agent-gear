// 与 contracts/admin-tenant.graphql 逐字段一致（后台租户只读视图 + 开户/team 开通/成员初始化转发）。
export const tenantTypeDefs = `#graphql
  enum TenantType {
    personal
    team
  }

  enum WorkspaceType {
    global
    normal
  }

  enum TenantRole {
    admin
    developer
  }

  type AdminTenant {
    id: ID!
    name: String!
    type: TenantType!
    memberCount: Int!
    balance: Float
    createdAt: String!
  }

  # 租户工作区只读视图（写方仅 agent-api）
  type AdminWorkspace {
    id: ID!
    name: String!
    type: WorkspaceType!
    memberCount: Int!
    createdAt: String!
  }

  type AdminTenantUser {
    id: ID!
    name: String!
    username: String!
    role: TenantRole! # 租户内角色（personal 恒 admin）
    createdAt: String!
  }

  type AdminTenantDetail {
    id: ID!
    name: String!
    type: TenantType!
    # 口径变更：改经 tenantmembers 展开（含 role；personal 恒 1 且 admin）
    users: [AdminTenantUser!]!
    # 只读工作区列表
    workspaces: [AdminWorkspace!]!
    createdAt: String!
  }

  extend type Query {
    adminTenants(keyword: String, page: Int, pageSize: Int): [AdminTenant!]!
    adminTenant(id: ID!): AdminTenantDetail
  }

  extend type Mutation {
    # 后台开户：创建登录账户+用户+同名个人专属租户+零余额租户费用账户（经 agent-api 转发）
    adminCreateFrontUser(username: String!, password: String!): AdminTenantUser!
    # 创建 team 租户（全局工作区与零余额租户计费账户由 agent-api 一并创建）
    adminCreateTeamTenant(name: String!): AdminTenant!
    # 成员初始化：成员必须是已存在账户（按登录名）；仅 team 租户；role 缺省 developer
    adminAddTenantMember(tenantId: ID!, username: String!, role: TenantRole): AdminTenantUser!
    # 移除成员：仅 team 租户；last-admin 保护同样生效
    adminRemoveTenantMember(tenantId: ID!, userId: ID!): Boolean!
  }
`;
