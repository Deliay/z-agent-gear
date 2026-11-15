export const authProviderTypeDefs = `#graphql
  # 第三方登录类型（与 contracts/auth.graphql、contracts/admin-auth.graphql 值域逐字一致）
  enum AuthProviderType {
    oidc
    github_oauth
  }

  # 登录认证配置（authproviders 集合，admin-api 唯一写方，agent-api 只读镜像）
  # - secret 仅写入不回显：出参恒不含 secret；更新时省略 = 保持不变
  # - github_oauth 全平台仅一条（部分唯一索引）
  # - enabled=false 或两端 scope 均 false ⇒ 不出现在任何登录页
  type OidcProvider {
    id: ID!
    type: AuthProviderType!
    displayName: String!
    issuer: String!
    clientId: String!
    scopes: String!
    enabled: Boolean!
    enableFrontLogin: Boolean!
    enableAdminLogin: Boolean!
    hasSecret: Boolean!
    callbackUrl: String!
    createdAt: String!
    updatedAt: String!
  }

  type GithubOauthConfig {
    id: ID!
    type: AuthProviderType!
    clientId: String!
    enabled: Boolean!
    enableFrontLogin: Boolean!
    enableAdminLogin: Boolean!
    hasSecret: Boolean!
    callbackUrl: String!
    createdAt: String!
    updatedAt: String!
  }

  input OidcProviderInput {
    displayName: String
    issuer: String
    clientId: String
    clientSecret: String
    scopes: String
    enabled: Boolean
    enableFrontLogin: Boolean
    enableAdminLogin: Boolean
  }

  input GithubOauthInput {
    clientId: String
    clientSecret: String
    enabled: Boolean
    enableFrontLogin: Boolean
    enableAdminLogin: Boolean
  }

  extend type Query {
    oidcProviders: [OidcProvider!]!
    githubOauthConfig: GithubOauthConfig
  }

  extend type Mutation {
    createOidcProvider(input: OidcProviderInput!): OidcProvider!
    updateOidcProvider(id: ID!, input: OidcProviderInput!): OidcProvider!
    deleteOidcProvider(id: ID!): Boolean!
    upsertGithubOauthConfig(input: GithubOauthInput!): GithubOauthConfig!
  }
`;
