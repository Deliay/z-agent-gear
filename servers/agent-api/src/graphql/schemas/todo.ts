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
    harness_login_request
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

  enum ElicitationResolution {
    accepted
    declined
    cancelled
    expired
    failed
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

  # harness 登录引导数据（required 事件落库；链接/验证码为 kimi login stdio 原文）
  type HarnessLoginRequestData {
    requestId: String!
    controllerId: ID!
    serverType: AcpServerType!
    # 触发登录检查的使用动作：probe-options / acp:start / acp:resume
    trigger: String!
    url: String!
    userCode: String!
    expiresAt: String!
  }

  # 登录引导弹窗动作（本期仅支持取消；关闭弹窗等同取消）
  enum HarnessLoginAction {
    cancel
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
    # Kimi Code（Harness）登录引导；type=harness_login_request 时存在
    harnessLoginData: HarnessLoginRequestData
    # 问询终态：null = 仍待处理；expired = 超时未响应；failed = 链路不支持
    resolution: ElicitationResolution
    resolvedAt: String
    expiresAt: String
    createdAt: String!
  }

  extend type Query {
    getTodoList: [TodoItem!]!
    getUnreadTodoCount: Int!
  }

  extend type Mutation {
    respondPermission(requestId: String!, outcome: String!, optionId: String): Boolean!
    respondElicitation(requestId: String!, action: ElicitationAction!, values: JSON): Boolean!
    # 响应用户侧的 harness 登录引导（本期仅 cancel）；未命中/非本人/已收敛抛错
    respondHarnessLogin(requestId: String!, action: HarnessLoginAction!): Boolean!
    markTodoRead(todoId: ID!): Boolean!
    markAllTodoRead: Boolean!
    updatePermissionTimeout(sessionId: ID, timeoutAction: PermissionTimeoutAction!): Boolean!
    updateGlobalPermissionTimeout(timeoutAction: GlobalPermissionTimeoutAction!): Boolean!
  }
`;
