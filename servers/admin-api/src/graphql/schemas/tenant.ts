// 与 contracts/admin-tenant.graphql 逐字段一致（后台租户只读视图 + 开户转发）。
export const tenantTypeDefs = `#graphql
  enum TenantType {
    personal
    team
  }

  type AdminTenant {
    id: ID!
    name: String!
    type: TenantType!
    memberCount: Int!
    balance: Float
    createdAt: String!
  }

  type AdminTenantUser {
    id: ID!
    name: String!
    username: String!
    createdAt: String!
  }

  type AdminTenantDetail {
    id: ID!
    name: String!
    type: TenantType!
    users: [AdminTenantUser!]!
    createdAt: String!
  }

  extend type Query {
    adminTenants(keyword: String, page: Int, pageSize: Int): [AdminTenant!]!
    adminTenant(id: ID!): AdminTenantDetail
  }

  extend type Mutation {
    # 后台开户：创建登录账户+用户+同名个人专属租户+零余额租户费用账户（经 agent-api 转发）
    adminCreateFrontUser(username: String!, password: String!): AdminTenantUser!
  }
`;
