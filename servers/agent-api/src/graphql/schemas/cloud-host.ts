// 严格对齐 contracts/cloud-host.graphql
export const cloudHostTypeDefs = `#graphql
  enum HarnessType {
    OPENCODE
    KIMI_CODE
    DEEPSEEK_HARNESS
  }

  # 工作负载分类：standard = 运行环境/工具，harness = 云电脑 harness
  enum CloudWorkloadKind {
    STANDARD
    HARNESS
  }

  enum CloudHostStatus {
    STARTING
    RUNNING
    STOPPING
    STOPPED
    FAILED
  }

  type CloudHost {
    id: ID!
    name: String!
    controllerId: ID!
    status: CloudHostStatus!
    harnessTypes: [HarnessType!]!
    defaultSessionId: ID
    activeSessionCount: Int!
    containerId: String
    createdAt: String!
    readyAt: String
    stoppedAt: String
    failureReason: String
    deletedAt: String
    # 云电脑默认工作区路径（workspaceId → ControllerWorkspace.path；缺失回退 /home/worker/workspace）
    defaultWorkspace: String!
    # 是否已创建默认工作区（workspaceId != null）；创建期恒为 false，Git 项目设置 clone 成功后即创建默认工作区并回写 workspaceId（与 createSession 开关及会话创建成败无关）并翻转为 true。
    # 用于区分「未创建工作区」与「默认会话创建失败」。
    hasDefaultWorkspace: Boolean!
    # 当前正在 runtime 安装的工作负载名；null 表示空闲
    workloadInstalling: String
    # 云电脑锁定的 Github 帐号；null = 未选定（可在首次 Git 项目设置时选定一次），一经绑定不可修改
    githubAccountId: ID
    # 所属租户工作区 id（多租户二期；服务端取当前上下文，不入参）
    workspaceId: ID!
  }

  # 云电脑创建/运行报价（金额单位 credits，来自 admin-api 价目档）
  type CloudHostBillingQuote {
    createCredits: Float!
    perMinuteCredits: Float!
    availableBalance: Float
  }

  enum CloudHostSetupKind {
    INSTALL_WORKLOAD
    GITHUB_SETUP
  }

  enum CloudHostSetupStatus {
    RUNNING
    SUCCEEDED
    FAILED
  }

  enum CloudHostSetupStepStatus {
    PENDING
    RUNNING
    SUCCEEDED
    FAILED
    SKIPPED
  }

  type CloudHostWorkloadItem {
    workloadId: ID!
    name: String!
    workloadKind: CloudWorkloadKind!
    paramSchema: JSON!
    dependsOnWorkloadIds: [ID!]!
    isPreset: Boolean!
    installed: Boolean!
    installedAt: String
    source: String
  }

  type CloudHostSetupStep {
    key: String!
    status: CloudHostSetupStepStatus!
    detail: String
  }

  type CloudHostSetupOperation {
    id: ID!
    kind: CloudHostSetupKind!
    status: CloudHostSetupStatus!
    steps: [CloudHostSetupStep!]!
    sessionId: ID
    error: String
    createdAt: String!
    updatedAt: String!
  }

  type CloudHostSessionSummary {
    id: ID!
    title: String!
    status: String!
    acpServerType: String!
  }

  type CloudHostStopImpact {
    activeSessionCount: Int!
    sessionsWillBeLost: Boolean!
    sessions: [CloudHostSessionSummary!]!
  }

  type CloudHostCapabilities {
    enabled: Boolean!
    supportedHarnesses: [HarnessType!]!
  }

  # 云电脑 GitHub Issues 联动配置（每控制器多条）
  type CloudHostIssuesLinkage {
    id: ID!
    controllerId: ID!
    configuredWorkflowId: ID!
    configuredWorkflowName: String!
    labelName: String!
    repoFullNames: [String!]!
    createdAt: String!
    updatedAt: String!
  }

  input CloudHostIssuesLinkageInput {
    controllerId: ID!
    configuredWorkflowId: ID!
    labelName: String!
    repoFullNames: [String!]!
  }

  type CloudHostIssuesLabelCleanupResult {
    deleted: [String!]!
    failed: [String!]!
  }

  input CreateCloudHostInput {
    name: String!
    harnessTypes: [HarnessType!]!
    # 可选：创建时附加预装的 standard 负载（去重后 ≤5；依赖由服务端后序展开）
    workloadIds: [ID!]
    # false 时 ready 不自动建默认会话（由 setup 的 session 步骤建项目会话）
    createDefaultSession: Boolean = true
    # 可选：创建时锁定 Github 帐号（必须是当前用户已绑定帐号；缺省 = 未选定）
    githubAccountId: ID
  }

  input InstallCloudHostWorkloadInput {
    controllerId: ID!
    workloadId: ID!
    params: JSON
  }

  input SetupCloudHostGithubProjectInput {
    controllerId: ID!
    # 云电脑已锁定帐号时必须等于锁定帐号（否则 github account is locked）；未锁定时本次设置将其锁定
    accountId: ID!
    repoFullName: String!
    # 语义：clone 前缀地址（工作根目录），不是最终目录。
    # 支持 \`~\` 或 \`~/\` 开头：服务端展开为容器用户主目录（/home/worker）后再归一。
    # 最终目录 = <targetPath>/<repoFullName>，由服务端用 path.posix.join 权威拼接。
    targetPath: String!
    workloadIds: [ID!]
    # false 时 session 步骤记 SKIPPED（多 Harness 不自动创建会话）；工作区初始化照常执行，缺省 true
    createSession: Boolean = true
  }

  extend type Query {
    cloudHostCapabilities: CloudHostCapabilities!
    myCloudHosts: [CloudHost!]!
    # 进度对话框轮询云电脑启动状态（1.5s 级）；仅返回当前用户的云电脑（软删除仍返回）
    cloudHost(id: ID!): CloudHost
    cloudHostStopImpact(id: ID!): CloudHostStopImpact!
    cloudHostWorkloads(controllerId: ID!): [CloudHostWorkloadItem!]!
    # 无主机上下文的 standard 负载目录（创建云电脑时勾选；installed 固定 false）
    cloudHostWorkloadCatalog: [CloudHostWorkloadItem!]!
    cloudHostSetupOperation(id: ID!): CloudHostSetupOperation
    # 云电脑 GitHub Issues 联动配置列表（仅本人云电脑；无配置返回 []）
    cloudHostIssuesLinkages(controllerId: ID!): [CloudHostIssuesLinkage!]!
    # 云电脑创建/运行报价（计费不可用时 availableBalance=null、价格回退默认值）
    cloudHostBillingQuote: CloudHostBillingQuote!
  }

  extend type Mutation {
    createCloudHost(input: CreateCloudHostInput!): CloudHost!
    stopCloudHost(id: ID!, force: Boolean): CloudHost!
    deleteCloudHost(id: ID!): Boolean!
    installCloudHostWorkload(input: InstallCloudHostWorkloadInput!): CloudHostSetupOperation!
    setupCloudHostGithubProject(input: SetupCloudHostGithubProjectInput!): CloudHostSetupOperation!
    retryCloudHostSetupOperation(id: ID!): CloudHostSetupOperation!
    createCloudHostIssuesLinkage(input: CloudHostIssuesLinkageInput!): CloudHostIssuesLinkage!
    updateCloudHostIssuesLinkage(id: ID!, input: CloudHostIssuesLinkageInput!): CloudHostIssuesLinkage!
    deleteCloudHostIssuesLinkage(id: ID!): Boolean!
    cleanupCloudHostIssuesLabels(controllerId: ID!): CloudHostIssuesLabelCleanupResult!
  }

  extend type Controller {
    cloudHost: CloudHost
  }
`;
