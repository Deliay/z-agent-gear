export const todoTypeDefs = `#graphql
  enum PermissionOptionKind {
    allow_once
    allow_always
    reject_once
    reject_always
  }

  enum TodoPriority {
    immediate
    urgent
    medium
    low
  }

  enum TodoType {
    permission_request
    elicitation_request
    workflow_intervention
  }

  enum PermissionTimeoutAction {
    use_global
    allow_once
    reject
    cancel
  }

  enum GlobalPermissionTimeoutAction {
    allow_once
    reject
    cancel
  }

  type PermissionOption {
    optionId: String!
    name: String!
    kind: PermissionOptionKind!
  }

  type PermissionToolCall {
    toolCallId: String!
    title: String
    kind: String
    rawInput: JSON
    locations: JSON
  }

  type PermissionRequestData {
    requestId: String!
    sessionId: ID!
    toolCallId: String!
    toolCall: PermissionToolCall
    options: [PermissionOption!]!
  }

  enum ElicitationMode {
    form
    url
  }

  enum ElicitationAction {
    accept
    decline
    cancel
  }

  type ElicitationRequestData {
    requestId: String!
    sessionId: ID!
    toolCallId: String
    mode: ElicitationMode!
    message: String!
    requestedSchema: JSON
    elicitationId: String
    url: String
  }

  type TodoItem {
    id: ID!
    type: TodoType!
    priority: TodoPriority!
    title: String!
    description: String
    isRead: Boolean!
    data: PermissionRequestData
    elicitationData: ElicitationRequestData
    createdAt: String!
  }

  extend type Query {
    getTodoList: [TodoItem!]!
    getUnreadTodoCount: Int!
  }

  extend type Mutation {
    respondPermission(requestId: String!, outcome: String!, optionId: String): Boolean!
    respondElicitation(requestId: String!, action: ElicitationAction!, values: JSON): Boolean!
    markTodoRead(todoId: ID!): Boolean!
    markAllTodoRead: Boolean!
    updatePermissionTimeout(sessionId: ID, timeoutAction: PermissionTimeoutAction!): Boolean!
    updateGlobalPermissionTimeout(timeoutAction: GlobalPermissionTimeoutAction!): Boolean!
  }
`;
