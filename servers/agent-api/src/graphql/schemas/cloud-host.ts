// 严格对齐 contracts/cloud-host.graphql
export const cloudHostTypeDefs = `#graphql
  enum HarnessType {
    OPENCODE
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
    targetPath: String!
    workloadIds: [ID!]
  }

  extend type Query {
    cloudHostCapabilities: CloudHostCapabilities!
    myCloudHosts: [CloudHost!]!
    cloudHostStopImpact(id: ID!): CloudHostStopImpact!
    cloudHostWorkloads(controllerId: ID!): [CloudHostWorkloadItem!]!
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
