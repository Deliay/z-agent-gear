// 对齐 contracts/workflow.graphql（已定稿契约，字段逐一对齐）
export const workflowTypeDefs = `#graphql
  enum WorkflowNodeType {
    HUMAN
    AI
    FLAG
  }

  enum ResourceCreatedBy {
    HUMAN
    AI
  }

  enum InstantiateSource {
    CONFIGURED
    TEMPLATE
    BLANK
  }

  enum WorkflowNodeStatus {
    INITIALIZING
    READY
    RUNNING
    DONE
    REJECT
    REWORK
    FAILED
  }

  # ---------- 工作流模板 ----------

  type WorkflowTemplateNode {
    nodeKey: String!
    type: WorkflowNodeType!
    name: String!
    description: String
    stage: String!
    prompts: [String!]
    artifactTitles: [String!]
    dependsOn: [String!]!
    requiresWorktree: Boolean!
    # 人类节点：是否联动上游 Pull Request
    linkUpstreamPullRequest: Boolean!
    # 展示顺序（仅影响 UI 排列，不影响执行顺序）
    sortOrder: Int
  }

  type WorkflowTemplate {
    id: ID!
    name: String!
    description: String
    version: Int!
    nodes: [WorkflowTemplateNode!]!
    isBuiltin: Boolean!
    createdBy: ResourceCreatedBy!
    resourceWorkspaceId: ID
    createdAt: String!
    updatedAt: String!
  }

  # ---------- 已配置工作流（模板快照副本） ----------

  type AgentNodeConfig {
    acpServerType: String!
    modeId: String
    modelId: String
    initNewWorktree: Boolean!
  }

  type ConfiguredWorkflowNode {
    nodeKey: String!
    type: WorkflowNodeType!
    name: String!
    description: String
    stage: String!
    prompts: [String!]
    artifactTitles: [String!]
    dependsOn: [String!]!
    requiresWorktree: Boolean!
    agentConfig: AgentNodeConfig
    # 人类节点：是否联动上游 Pull Request
    linkUpstreamPullRequest: Boolean!
    # 展示顺序（仅影响 UI 排列，不影响执行顺序）
    sortOrder: Int
  }

  type ConfiguredWorkflow {
    id: ID!
    name: String!
    controllerId: ID!
    sourceTemplateId: ID
    sourceTemplateVersion: Int
    nodes: [ConfiguredWorkflowNode!]!
    createdBy: ResourceCreatedBy!
    resourceWorkspaceId: ID!
    createdAt: String!
    updatedAt: String!
  }

  # ---------- 工作流实例 ----------

  type WorkflowNodeRejectInfo {
    reason: String!
    fromNodeId: String
    at: String!
  }

  type WorkflowNodeFailInfo {
    reason: String!
    source: String!
    at: String!
  }

  type WorkflowNode {
    id: ID!
    nodeKey: String!
    type: WorkflowNodeType!
    name: String!
    description: String
    status: WorkflowNodeStatus!
    stage: String!
    sessionId: ID
    # 实例快照字段（实例化时复制；旧实例可能缺失）
    prompts: [String!]
    artifactTitles: [String!]
    agentConfig: AgentNodeConfig
    dependsOn: [String!]
    requiresWorktree: Boolean
    # 人类节点：是否联动上游 Pull Request（实例快照）
    linkUpstreamPullRequest: Boolean!
    # 展示顺序（仅影响 UI 排列，不影响执行顺序）
    sortOrder: Int
    createdAt: String!
    startedAt: String
    reworkedAt: String
    reworkCount: Int!
    rejectInfo: WorkflowNodeRejectInfo
    failInfo: WorkflowNodeFailInfo
  }

  type BlackboardEntry {
    key: String!
    value: String!
    updatedAt: String!
  }

  # 工作流级追加提示词（key 去重，同 key 只插入一次；系统键 github-pr / github-pr-review）
  type WorkflowAdditionalPrompt {
    key: String!
    value: String!
  }

  # 当前实例关联的 Pull Request（工作流完成/归档/删除后为空）
  type WorkflowPullRequestLink {
    pullRequestId: String!
    prUrl: String
    nodeId: String!
    nodeName: String
    # ISO 字符串（本仓库无 DateTime scalar）
    registeredAt: String!
    # ---- 本期新增：check-run 同步状态（只读投影） ----
    # 最近写入的 check-run 页面地址
    checkRunUrl: String
    # 上次写入 check-run 的 commit
    lastSyncedCommitSha: String
    # 最近同步时间（ISO 字符串，与 registeredAt 同口径）
    lastSyncAt: String
    # 最近同步失败提示（白名单短文案，不含凭据）
    lastSyncError: String
  }

  type WorkflowInstance {
    id: ID!
    # 统一实例化三来源（CONFIGURED/TEMPLATE/BLANK）中仅 CONFIGURED 来源保证存在，故可空
    configuredWorkflowId: ID
    controllerId: ID!
    workspaceId: ID!
    resourceWorkspaceId: ID!
    name: String!
    currentNodeNames: [String!]!
    lastNodeName: String
    lastNodeStatus: String
    archived: Boolean!
    # 工作流 Worktree 路径（createWorkflowWorktree=true 且 Git 工作区时存在）
    workflowWorktreePath: String
    # 工作流 Worktree 分支名（createWorkflowWorktree=true 且 Git 工作区时存在）
    workflowWorktreeBranch: String
    nodes: [WorkflowNode!]!
    blackboard: [BlackboardEntry!]!
    blackboardTrash: [BlackboardEntry!]!
    # 工作流级追加提示词（只读展示）
    additionalPrompts: [WorkflowAdditionalPrompt!]!
    # 当前实例关联的 Pull Request
    pullRequestLinks: [WorkflowPullRequestLink!]!
    # 归属对象（供集中列表展示所属工作区/控制器）；可能已被删除，消费方须判空
    workspace: ControllerWorkspace
    controller: Controller
    createdAt: String!
    updatedAt: String!
  }

  # ---------- Input ----------

  input WorkflowTemplateNodeInput {
    nodeKey: String!
    type: WorkflowNodeType!
    name: String!
    description: String
    stage: String!
    prompts: [String!]
    artifactTitles: [String!]
    dependsOn: [String!]!
    requiresWorktree: Boolean!
    # 人类节点：是否联动上游 Pull Request
    linkUpstreamPullRequest: Boolean
    # 展示顺序（仅影响 UI 排列，不影响执行顺序）
    sortOrder: Int
  }

  input WorkflowTemplateInput {
    name: String!
    description: String
    nodes: [WorkflowTemplateNodeInput!]!
  }

  input AgentNodeConfigInput {
    acpServerType: String!
    modeId: String
    modelId: String
    initNewWorktree: Boolean!
  }

  input ConfiguredWorkflowNodeInput {
    nodeKey: String!
    type: WorkflowNodeType!
    name: String!
    description: String
    stage: String!
    prompts: [String!]
    artifactTitles: [String!]
    dependsOn: [String!]!
    requiresWorktree: Boolean!
    agentConfig: AgentNodeConfigInput
    # 人类节点：是否联动上游 Pull Request
    linkUpstreamPullRequest: Boolean
    # 展示顺序（仅影响 UI 排列，不影响执行顺序）
    sortOrder: Int
  }

  input ConfigureWorkflowInput {
    name: String!
    controllerId: ID!
    nodes: [ConfiguredWorkflowNodeInput!]!
  }

  # ---------- 统一实例化 ----------

  input InstantiateWorkflowInput {
    source: InstantiateSource!
    configuredWorkflowId: ID
    templateId: ID
    controllerId: ID!
    workspaceId: ID!
    name: String!
    nodes: [ConfiguredWorkflowNodeInput!]!
    # 是否为工作流创建独立 Worktree（默认 false）
    createWorkflowWorktree: Boolean
  }

  # ---------- 实例节点编辑 ----------

  input WorkflowNodeUpdateInput {
    name: String
    description: String
    stage: String
    prompts: [String!]
    artifactTitles: [String!]
    requiresWorktree: Boolean
    agentConfig: AgentNodeConfigInput
    # 人类节点：是否联动上游 Pull Request
    linkUpstreamPullRequest: Boolean
    # 展示顺序（仅影响 UI 排列，不影响执行顺序）
    sortOrder: Int
  }

  # ---------- Query / Mutation ----------

  extend type Query {
    workflowTemplates: [WorkflowTemplate!]!
    workflowTemplate(id: ID!): WorkflowTemplate
    configuredWorkflows(controllerId: ID): [ConfiguredWorkflow!]!
    configuredWorkflow(id: ID!): ConfiguredWorkflow
    # workspaceId / controllerId 均可选：都不传 = 当前用户全部实例；二者同传取交集
    workflowInstances(workspaceId: ID, controllerId: ID, archived: Boolean): [WorkflowInstance!]!
    workflowInstance(id: ID!): WorkflowInstance
  }

  extend type Mutation {
    createWorkflowTemplate(input: WorkflowTemplateInput!): WorkflowTemplate!
    updateWorkflowTemplate(id: ID!, input: WorkflowTemplateInput!): WorkflowTemplate!
    deleteWorkflowTemplate(id: ID!): Boolean!
    configureWorkflow(templateId: ID!, input: ConfigureWorkflowInput!): ConfiguredWorkflow!
    updateConfiguredWorkflow(id: ID!, input: ConfigureWorkflowInput!): ConfiguredWorkflow!
    deleteConfiguredWorkflow(id: ID!): Boolean!
    instantiateWorkflow(input: InstantiateWorkflowInput!): WorkflowInstance!
    updateWorkflowNode(instanceId: ID!, nodeId: ID!, input: WorkflowNodeUpdateInput!): WorkflowNode!
    completeHumanNode(instanceId: ID!, nodeId: ID!, input: String): WorkflowNode!
    rejectNode(instanceId: ID!, nodeId: ID!, reason: String!): WorkflowNode!
    # 重启节点（RUNNING/REWORK/FAILED 会话失败或卡住时人工触发，关闭旧会话拉起全新会话）
    restartNode(instanceId: ID!, nodeId: ID!, agentConfig: AgentNodeConfigInput): WorkflowNode!
    deleteWorkflowInstance(id: ID!): Boolean!
    archiveWorkflowInstance(id: ID!, archived: Boolean!): Boolean!
    # 写入/覆盖工作流追加提示词（同 key 覆盖）；系统键拒绝人工写入
    setWorkflowAdditionalPrompt(instanceId: ID!, key: String!, value: String!): WorkflowInstance!
    # 删除工作流追加提示词（不存在时幂等成功）；系统键拒绝人工删除
    removeWorkflowAdditionalPrompt(instanceId: ID!, key: String!): WorkflowInstance!
  }
`;
