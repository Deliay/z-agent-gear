export const sessionTypeDefs = `#graphql
  scalar JSON
  enum SessionStatus {
    creating
    connecting
    idling
    running
    disconnected
    ended
  }

  enum AcpServerType {
    opencode
    github_copilot
    claude_code
    gemini_cli
    codex
    mimo_code
    kimi_code
  }

  enum AcpMessageDirection {
    input
    output
  }

  enum AcpMessageType {
    text
    image
    tool_call
    tool_result
    plan
    error
  }

  type AgentMode {
    id: String!
    name: String!
    description: String
  }

  type AgentModelInfo {
    id: String!
    name: String!
    provider: String
  }

  type SessionConfigOptionValue {
    value: String!
    name: String
  }

  type SessionConfigOption {
    id: String!
    name: String!
    description: String
    category: String
    type: String!
    currentValue: String
    options: [SessionConfigOptionValue!]
  }

  type PromptCapabilities {
    image: Boolean!
    audio: Boolean!
    embeddedContext: Boolean!
  }

  type AgentInfo {
    name: String!
    version: String
  }

  enum AuthMethodKind {
    env_var
    terminal
    agent
  }

  type AuthMethodInfo {
    id: String!
    kind: AuthMethodKind
    name: String
    description: String
    url: String
  }

  type Session {
    id: ID!
    userId: ID!
    controllerId: ID!
    controllerName: String!
    acpServerType: AcpServerType!
    status: SessionStatus!
    title: String
    externalSessionId: String
    cwd: String
    worktreePath: String
    worktreeBranch: String
    modes: [AgentMode!]
    currentModeId: String
    currentModel: AgentModelInfo
    availableModels: [AgentModelInfo!]
    currentModelId: String
    configOptions: [SessionConfigOption!]
    promptCapabilities: PromptCapabilities
    agentInfo: AgentInfo
    authRequired: Boolean!
    authMethods: [AuthMethodInfo!]
    supportsAdditionalDirectories: Boolean!
    permissionTimeoutAction: PermissionTimeoutAction
    workflowInstanceId: ID
    workflowNodeId: String
    createdAt: String!
    updatedAt: String!
    endedAt: String
  }

  type AcpMessage {
    id: ID!
    sessionId: ID!
    direction: AcpMessageDirection!
    type: AcpMessageType!
    content: JSON!
    metadata: String
    messageId: String
    createdAt: String!
  }

  type AcpCapability {
    type: AcpServerType!
    available: Boolean!
    version: String
    checkedAt: String
  }

  type AcpModeOption {
    id: String!
    name: String!
    description: String
  }

  type AcpModelOption {
    id: String!
    name: String!
    provider: String
  }

  # 指定 ACP 工具的 Mode/模型选项（由 controller 拉起空实例探测）
  type AcpServerOptions {
    modes: [AcpModeOption!]!
    models: [AcpModelOption!]!
    currentModeId: String
    currentModelId: String
    probedAt: String
  }

  type HistorySessionInfo {
    sessionId: String!
    title: String
    cwd: String!
    updatedAt: String
  }

  type ImportSessionResult {
    sessionId: ID!
    acpSessionId: String!
    title: String
    success: Boolean!
    error: String
    messageCount: Int
  }

  type DeleteHistorySessionPayload {
    success: Boolean!
    syncedToAgent: Boolean!
    error: String
  }

  type CreateSessionPayload {
    session: Session!
  }

  type ResumeSessionPayload {
    success: Boolean!
    status: SessionStatus!
    error: String
  }

  input CreateSessionInput {
    controllerId: ID!
    acpServerType: AcpServerType! = opencode
    workspaceId: ID!
    enableWorktree: Boolean = false
    worktreeBranchSuffix: String
    mcpServerIds: [ID!]
  }

  extend type Query {
    sessions(includeWorkflowSessions: Boolean): [Session!]!
    session(id: ID!): Session
    sessionMessages(sessionId: ID!, before: ID, limit: Int): [AcpMessage!]!
    acpCapabilities(controllerId: ID!): [AcpCapability!]!
    acpServerOptions(controllerId: ID!, acpServerType: AcpServerType!): AcpServerOptions!
    listHistorySessions(controllerId: ID!, workspaceId: ID!, acpServerType: AcpServerType = opencode): [HistorySessionInfo!]!
  }

  extend type Mutation {
    createSession(input: CreateSessionInput!): CreateSessionPayload!
    closeSession(id: ID!): Boolean!
    deleteSession(id: ID!): Boolean!
    sendSessionMessage(sessionId: ID!, content: String!, type: AcpMessageType = text): AcpMessage!
    cancelGeneration(sessionId: ID!): Boolean!
    resumeSession(id: ID!): ResumeSessionPayload!
    importHistorySessions(controllerId: ID!, workspaceId: ID!, acpServerType: AcpServerType = opencode, sessionIds: [String!]!): [ImportSessionResult!]!
    setSessionMode(sessionId: ID!, modeId: String!): Boolean!
    setSessionModel(sessionId: ID!, modelId: String!): Boolean!
    setSessionConfigOption(sessionId: ID!, configId: String!, value: String!): Boolean!
    deleteHistorySession(sessionId: ID!, syncAgent: Boolean = true): DeleteHistorySessionPayload!
    refreshAcpCapabilities(controllerId: ID!): [AcpCapability!]!
  }
`;