// 对齐 contracts/settings.graphql（设置页聚合查询，已定稿契约）
export const settingsTypeDefs = `#graphql
  type SettingsOverview {
    # 替代 commitSettings
    commitSettings: CommitSettings!
    # 替代 providers（设置页两处共用，聚合后只取一次）
    providers: [Provider!]!
    # 替代 models
    models: [Model!]!
    # 替代 controllerKeys
    controllerKeys: [ControllerKey!]!
    # 替代 mcpServers
    mcpServers: [McpServer!]!
    # 替代 valutEntries
    valutEntries: [ValutNamespaceGroup!]!
    # 替代 customMcpServers
    customMcpServers: [CustomMcpServer!]!
    # 替代 customTools
    customTools: [CustomTool!]!
    # 替代 githubAccounts
    githubAccounts: [GitHubAccount!]!
    # 替代 githubAppUrl（{url,state}；只读上下文求值失败时 degrade 为 {url:'',state:''}）
    githubAppUrl: GitHubAppUrl!
    # 替代 myExternalLogins
    myExternalLogins: [ExternalLoginInfo!]!
    # 替代 authProviders
    authProviders: [AuthProviderInfo!]!
    # 替代 cloudStorageCapabilities
    cloudStorageCapabilities: CloudStorageCapabilities!
    # 替代 cloudStorages(includeDestroyed:false)
    cloudStorages: [CloudStorage!]!
  }

  extend type Query {
    settingsOverview: SettingsOverview!
  }
`;
