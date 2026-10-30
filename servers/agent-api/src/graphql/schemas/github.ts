export const githubTypeDefs = `#graphql
  type GitHubRepoPermissions {
    read: Boolean!
    write: Boolean!
  }

  type GitHubRepo {
    id: ID!
    repoId: Int!
    repoName: String!
    fullName: String!
    private: Boolean!
    permissions: GitHubRepoPermissions!
  }

  type GitHubInstallation {
    id: ID!
    installationId: Int!
    managementUrl: String!
    repos: [GitHubRepo!]
    createdAt: String!
  }

  type GitHubAccount {
    id: ID!
    githubUserId: Int!
    githubLogin: String!
    githubAvatarUrl: String
    installations: [GitHubInstallation!]
    workspaceId: ID!
    createdAt: String!
  }

  type GitHubAppUrl {
    url: String!
    state: String!
  }

  # Commit 设置（成员级提交人设置；仅对云容器环境生效）
  # 成员独立、无共享/继承：每个成员一份设置，任何工作区下均为同一份。
  # 从未保存返回 committerType=UNSET 的默认值；服务端权威校验白名单仅一条：
  #   invalid custom committer
  # 归一规则：UNSET 清空 customName / customEmail。
  enum CommitterType {
    CUSTOM
    UNSET
  }

  """成员级提交人设置"""
  type CommitSettings {
    committerType: CommitterType!
    customName: String
    customEmail: String
  }

  input CommitSettingsInput {
    committerType: CommitterType!
    customName: String
    customEmail: String
  }

  extend type Query {
    githubAccounts: [GitHubAccount!]!
    githubAppUrl: GitHubAppUrl!
    """当前成员的提交人设置（仅对云容器环境生效）；从未保存返回 UNSET 默认值"""
    commitSettings: CommitSettings!
    """当前账户对应的个人租户绑定的全部 GitHub 帐号（「导入Github帐号信息」弹窗数据源）"""
    personalGithubAccounts: [GitHubAccount!]!
  }

  extend type Mutation {
    unbindGitHubAccount(accountId: ID!): Boolean!
    refreshGitHubInstallations(accountId: ID!): GitHubAccount!
    """保存当前成员的提交人设置；非法输入返回白名单错误文案"""
    updateCommitSettings(input: CommitSettingsInput!): CommitSettings!
  }
`;
