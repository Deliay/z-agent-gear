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
    permissionTimeoutAction: PermissionTimeoutAction
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
    createdAt: String!
  }

  type AcpCapability {
    type: AcpServerType!
    available: Boolean!
    version: String
    checkedAt: String
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
  }

  extend type Query {
    sessions: [Session!]!
    session(id: ID!): Session
    sessionMessages(sessionId: ID!, before: ID, limit: Int): [AcpMessage!]!
    acpCapabilities(controllerId: ID!): [AcpCapability!]!
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
    refreshAcpCapabilities(controllerId: ID!): [AcpCapability!]!
  }
`;