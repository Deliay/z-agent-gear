// 严格对齐 contracts/cloud-host.graphql
export const cloudHostTypeDefs = `#graphql
  enum HarnessType {
    OPENCODE
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
    # 云电脑默认工作区路径（workspaceId → ControllerWorkspace.path；缺失回退 /root/workspace）
    defaultWorkspace: String!
    # 当前正在 runtime 安装的工作负载名；null 表示空闲
    workloadInstalling: String
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

  input CreateCloudHostInput {
    name: String!
    harnessTypes: [HarnessType!]!
    # 可选：创建时附加预装的 standard 负载（去重后 ≤5；依赖由服务端后序展开）
    workloadIds: [ID!]
  }

  input InstallCloudHostWorkloadInput {
    controllerId: ID!
    workloadId: ID!
    params: JSON
  }

  input SetupCloudHostGithubProjectInput {
    controllerId: ID!
    accountId: ID!
    repoFullName: String!
    # 语义：clone 前缀地址（工作根目录）；最终目录 = <targetPath>/<repoFullName>
    targetPath: String!
    workloadIds: [ID!]
  }

  extend type Query {
    cloudHostCapabilities: CloudHostCapabilities!
    myCloudHosts: [CloudHost!]!
    cloudHostStopImpact(id: ID!): CloudHostStopImpact!
    cloudHostWorkloads(controllerId: ID!): [CloudHostWorkloadItem!]!
    # 无主机上下文的 standard 负载目录（创建云电脑时勾选；installed 固定 false）
    cloudHostWorkloadCatalog: [CloudHostWorkloadItem!]!
    cloudHostSetupOperation(id: ID!): CloudHostSetupOperation
  }

  extend type Mutation {
    createCloudHost(input: CreateCloudHostInput!): CloudHost!
    stopCloudHost(id: ID!, force: Boolean): CloudHost!
    deleteCloudHost(id: ID!): Boolean!
    installCloudHostWorkload(input: InstallCloudHostWorkloadInput!): CloudHostSetupOperation!
    setupCloudHostGithubProject(input: SetupCloudHostGithubProjectInput!): CloudHostSetupOperation!
    retryCloudHostSetupOperation(id: ID!): CloudHostSetupOperation!
  }

  extend type Controller {
    cloudHost: CloudHost
  }
`;
