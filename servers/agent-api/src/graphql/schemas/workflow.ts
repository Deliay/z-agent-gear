// 对齐 contracts/workflow.graphql（已定稿契约，字段逐一对齐）
export const workflowTypeDefs = `#graphql
  enum WorkflowNodeType {
    HUMAN
    AI
    FLAG
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
  }

  type WorkflowTemplate {
    id: ID!
    name: String!
    description: String
    version: Int!
    nodes: [WorkflowTemplateNode!]!
    isBuiltin: Boolean!
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
  }

  type ConfiguredWorkflow {
    id: ID!
    name: String!
    controllerId: ID!
    sourceTemplateId: ID
    sourceTemplateVersion: Int
    nodes: [ConfiguredWorkflowNode!]!
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
    configuredWorkflowId: ID!
    controllerId: ID!
    workspaceId: ID!
    name: String!
    currentNodeNames: [String!]!
    lastNodeName: String
    lastNodeStatus: String
    archived: Boolean!
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
    agentConfig: AgentNodeConfigInput
  }

  input ConfigureWorkflowInput {
    name: String!
    controllerId: ID!
    nodes: [ConfiguredWorkflowNodeInput!]!
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
    instantiateWorkflow(configuredWorkflowId: ID!, workspaceId: ID!, name: String!): WorkflowInstance!
    completeHumanNode(instanceId: ID!, nodeId: ID!, input: String): WorkflowNode!
    rejectNode(instanceId: ID!, nodeId: ID!, reason: String!): WorkflowNode!
    deleteWorkflowInstance(id: ID!): Boolean!
    archiveWorkflowInstance(id: ID!, archived: Boolean!): Boolean!
  }
`;
