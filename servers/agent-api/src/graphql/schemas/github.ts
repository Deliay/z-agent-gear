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
    createdAt: String!
  }

  type GitHubAppUrl {
    url: String!
    state: String!
  }

  # Commit 设置（仅对云容器环境生效）
  # 从未保存返回双 UNSET 默认值；服务端权威校验白名单：
  #   committer is required for the selected mode
  #   invalid github account
  #   invalid custom committer
  # 归一规则按 committerType 清理（committerMode=UNSET 不清空提交人）。
  enum CommitterMode {
    AGENT_ONLY
    CO_AUTHOR
    HUMAN_ONLY
    UNSET
  }

  enum CommitterType {
    GITHUB_ACCOUNT
    CUSTOM
    UNSET
  }

  type CommitSettings {
    committerMode: CommitterMode!
    committerType: CommitterType!
    githubAccountId: ID
    customName: String
    customEmail: String
  }

  input CommitSettingsInput {
    committerMode: CommitterMode!
    committerType: CommitterType!
    githubAccountId: ID
    customName: String
    customEmail: String
  }

  extend type Query {
    githubAccounts: [GitHubAccount!]!
    githubAppUrl: GitHubAppUrl!
    """当前用户的 Commit 设置（仅对云容器环境生效）；从未保存返回双 UNSET 默认值"""
    commitSettings: CommitSettings!
  }

  extend type Mutation {
    unbindGitHubAccount(accountId: ID!): Boolean!
    refreshGitHubInstallations(accountId: ID!): GitHubAccount!
    """保存 Commit 设置；非法组合返回白名单错误文案"""
    updateCommitSettings(input: CommitSettingsInput!): CommitSettings!
  }
`;
