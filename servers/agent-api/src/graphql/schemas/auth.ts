export const authTypeDefs = `#graphql
  enum TenantType {
    personal
    team
  }

  type Tenant {
    id: ID!
    name: String!
    type: TenantType!
    memberCount: Int!
  }

  type User {
    id: ID!
    name: String!
    tenant: Tenant!
    createdAt: String!
  }

  type AuthPayload {
    token: String!
    user: User!
  }

  # ===== 第三方登录（自定义 OIDC / GitHub OAuth）=====
  # 配置唯一写方在 admin-api；本服务仅暴露免登录入口信息与一次性票据兑换。

  enum AuthProviderType {
    oidc
    github_oauth
  }

  type AuthProviderInfo {
    id: ID!
    type: AuthProviderType!
    displayName: String!
  }

  extend type Query {
    me: User
    # 免登录；仅返回 enabled 且 enableFrontLogin=true 的配置；无配置返回 []
    authProviders: [AuthProviderInfo!]!
  }

  extend type Mutation {
    login(username: String!, password: String!): AuthPayload!
    # 一次性登录票据兑换（GETDEL 60s）；失败 BAD_USER_INPUT('invalid or expired ticket')
    exchangeLoginTicket(ticket: String!): AuthPayload!
  }
`;
