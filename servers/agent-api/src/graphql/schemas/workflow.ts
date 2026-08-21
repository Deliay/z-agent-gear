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

  type WorkflowInstance {
    id: ID!
    # 统一实例化三来源（CONFIGURED/TEMPLATE/BLANK）中仅 CONFIGURED 来源保证存在，故可空
    configuredWorkflowId: ID
    controllerId: ID!
    workspaceId: ID!
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
    # 展示顺序（仅影响 UI 排列，不影响执行顺序）
    sortOrder: Int
  }

  # ---------- Query / Mutation ----------

  extend type Query {
    workflowTemplates: [WorkflowTemplate!]!
    workflowTemplate(id: ID!): WorkflowTemplate
    configuredWorkflows(controllerId: ID): [ConfiguredWorkflow!]!
    configuredWorkflow(id: ID!): ConfiguredWorkflow
    workflowInstances(workspaceId: ID!, archived: Boolean): [WorkflowInstance!]!
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
  }
`;
