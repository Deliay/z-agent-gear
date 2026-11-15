export const authTypeDefs = `#graphql
  type AdminUser {
    id: ID!
    username: String!
    mustChangePassword: Boolean!
    createdAt: String!
    updatedAt: String!
  }

  type AdminAuthPayload {
    token: String!
    admin: AdminUser!
  }

  # ===== 后台第三方登录（自定义 OIDC / GitHub OAuth）=====
  # 后台外部身份必须先绑定才可登录；配置唯一写方在 admin-api（contracts/admin-auth-provider.graphql）。

  enum AuthProviderType {
    oidc
    github_oauth
  }

  type AdminAuthProviderInfo {
    id: ID!
    type: AuthProviderType!
    displayName: String!
  }

  type AdminExternalLogin {
    id: ID!
    providerId: ID!
    providerDisplayName: String!
    externalUsername: String!
    createdAt: String!
  }

  extend type Query {
    adminMe: AdminUser
    # 免登录（登录页前置查询）；仅返回 enabled 且 enableAdminLogin=true 的配置
    adminAuthProviders: [AdminAuthProviderInfo!]!
    # 需管理员登录；当前管理员已绑定的外部身份
    adminExternalLogins: [AdminExternalLogin!]!
  }

  extend type Mutation {
    # 登录；不存在注册 mutation
    adminLogin(username: String!, password: String!): AdminAuthPayload!
    # 修改密码（需已登录）；成功后 mustChangePassword=false 并签发新 token
    changeAdminPassword(oldPassword: String!, newPassword: String!): AdminAuthPayload!
    # 一次性登录票据兑换（免登录，同前台口径：GETDEL、60s TTL）
    adminExchangeLoginTicket(ticket: String!): AdminAuthPayload!
    # 需管理员登录；为当前管理员创建绑定票据（10 分钟有效），前端携票据跳转 agent-api 发起绑定
    createAdminBindTicket(providerId: ID!): String!
    # 需管理员登录；解除本人一条绑定
    unbindAdminExternalLogin(id: ID!): Boolean!
  }
`;
