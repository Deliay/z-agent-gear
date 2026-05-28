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

  type PermissionRequestData {
    requestId: String!
    sessionId: ID!
    toolCallId: String!
    options: [PermissionOption!]!
  }

  type TodoItem {
    id: ID!
    type: TodoType!
    priority: TodoPriority!
    title: String!
    description: String
    isRead: Boolean!
    data: PermissionRequestData
    createdAt: String!
  }

  extend type Query {
    getTodoList: [TodoItem!]!
    getUnreadTodoCount: Int!
  }

  extend type Mutation {
    respondPermission(requestId: String!, outcome: String!, optionId: String): Boolean!
    markTodoRead(todoId: ID!): Boolean!
    markAllTodoRead: Boolean!
    updatePermissionTimeout(sessionId: ID, timeoutAction: PermissionTimeoutAction!): Boolean!
    updateGlobalPermissionTimeout(timeoutAction: GlobalPermissionTimeoutAction!): Boolean!
  }
`;
