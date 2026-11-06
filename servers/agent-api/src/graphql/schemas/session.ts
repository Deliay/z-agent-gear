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
    deepseek_harness
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
    # 来源推断（仅 Session.availableModels 解析器填充，其余位置为 null）
    source: AgentModelSource
    sourceProvider: String
    group: String
    basis: String
  }

  enum AgentFeatureStatus {
    supported
    partial
    unsupported
  }

  enum AgentModelSource {
    platform
    agent
    custom
    unknown
  }

  type AgentFeatureSupport {
    id: String!
    status: AgentFeatureStatus!
    detail: String
  }

  type AgentCapabilitySnapshot {
    protocolVersion: Int
    agentInfo: AgentInfo
    features: [AgentFeatureSupport!]!
    # 对端声明原文（agentCapabilities / authMethods / clientCapabilities），前端不查询
    raw: JSON
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

  input MessageAttachmentInput {
    # image | audio | resource | resource_link
    type: String!
    data: String
    mimeType: String
    uri: String
    text: String
    name: String
    description: String
    size: Int
    title: String
  }

  # 提示词片段类型（本期 text/image；音频/视频类型预留不开放）
  enum PromptPartType {
    text
    image
  }

  # 提示词片段：文本或图片（本期）；音频/视频类型预留不开放
  input PromptPartInput {
    type: PromptPartType!
    # type=text 必填；trim 为空将被服务端过滤
    text: String
    # type=image 必填：base64（不含 data: 前缀）
    data: String
    # type=image 必填：如 image/png
    mimeType: String
    # 可选展示名（如截图文件名）
    name: String
  }

  # Review 状态：PENDING 待评审；APPROVED 通过；REJECTED 驳回；COMMENTED 仅评论；CANCELLED 已取消（超时/会话结束）
  enum SessionReviewStatus {
    PENDING
    APPROVED
    REJECTED
    COMMENTED
    CANCELLED
  }

  # 提交动作（对齐 GitHub PR Review 语义）
  enum SessionReviewAction {
    approve
    reject
    comment
  }

  # 会话内建 Review（Agent 经平台 MCP review 工具发起，用户逐文件批注并给出总体结论）
  type SessionReview {
    id: ID!
    sessionId: ID!
    # 待评审文件（相对会话工作区的展示路径）
    files: [String!]!
    # 所属会话标题（HomeOverview 聚合时补齐，侧边栏辨识用；其余查询为 null）
    sessionTitle: String
    status: SessionReviewStatus!
    # 按文件聚合的批注：{ [file: string]: ReviewComment[] }；PENDING/CANCELLED 为 null
    fileReviews: JSON
    # 总体评审意见
    comment: String
    # 取消原因（status=CANCELLED 时）：timeout | session_closed
    cancelReason: String
    createdAt: String!
    resolvedAt: String
  }

  # 文件内容（经 fs:read-file relay；仅会话工作区内路径）
  type SessionFileContent {
    path: String!
    content: String!
    truncated: Boolean!
    sizeBytes: Int!
  }

  input SubmitSessionReviewInput {
    # 按文件聚合的批注：{ [file: string]: ReviewComment[] }
    fileReviews: JSON!
    comment: String
    status: SessionReviewAction!
  }

  type Session {
    id: ID!
    userId: ID!
    controllerId: ID!
    controllerName: String!
    # 控制器类型；软删除云电脑的 Controller 可能不在列表结果中，会话详情以此判定只读
    controllerType: ControllerType
    # 会话所属云电脑（含已软删除留档）；普通主机/不存在时为 null
    cloudHost: CloudHost
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
    # 能力快照（会话初始化时协商结果；旧会话为 null）
    agentCapabilities: AgentCapabilitySnapshot
    # 能力清单（由快照归一化；无快照返回空数组）
    features: [AgentFeatureSupport!]!
    promptCapabilities: PromptCapabilities
    agentInfo: AgentInfo
    authRequired: Boolean!
    authMethods: [AuthMethodInfo!]
    supportsAdditionalDirectories: Boolean!
    permissionTimeoutAction: PermissionTimeoutAction
    workflowInstanceId: ID
    workflowNodeId: String
    # 归档状态（true=已归档，收纳进侧边栏「已归档」分组；仅分组展示差异，不影响会话数据与进程）
    archived: Boolean!
    # 只读原因：null=可写；取值见 SessionReadOnlyReason。
    # 控制器缺失 / 项目工作区缺失 / 云电脑终态三场景统一（写路径拒绝文案统一 session is ended）
    readOnlyReason: SessionReadOnlyReason
    createdAt: String!
    updatedAt: String!
    endedAt: String
  }

  # 会话只读原因（统一只读判定的三场景，由服务端字段 resolver 实时计算，不落库）
  enum SessionReadOnlyReason {
    # 项目工作区已删除
    WORKSPACE_MISSING
    # 控制器已解绑（不存在）
    CONTROLLER_MISSING
    # 云电脑已停止/销毁/删除
    CLOUD_HOST_DESTROYED
  }

  # 删除工作区影响预查询（删除确认提示的连带会话数量；与实际连带归档共用同一匹配口径）
  type WorkspaceArchiveImpact {
    # 该工作区下将连带归档的普通会话数（不含工作流节点会话与已归档会话）
    sessionCount: Int!
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
    existingWorktreePath: String
    # 缺省 = 按控制器 defaultMcp 解析；显式传数组（含 []）= 以调用方为准；云会话仍并入 agent-cloud-host-tools
    mcpServerIds: [ID!]
    # 拉起前选择的模式/模型；缺省使用工具默认值
    modeId: ID
    modelId: ID
  }

  extend type Query {
    # controllerId 可选：按控制器过滤
    # archived 可选：缺省/false 返回活跃（未归档）会话，true 返回已归档会话；与 includeWorkflowSessions 正交
    sessions(controllerId: ID, includeWorkflowSessions: Boolean, archived: Boolean): [Session!]!
    session(id: ID!): Session
    sessionMessages(sessionId: ID!, before: ID, limit: Int): [AcpMessage!]!
    acpCapabilities(controllerId: ID!): [AcpCapability!]!
    acpServerOptions(controllerId: ID!, acpServerType: AcpServerType!): AcpServerOptions!
    listHistorySessions(controllerId: ID!, workspaceId: ID!, acpServerType: AcpServerType = opencode): [HistorySessionInfo!]!
    # Review 查询：status 过滤；sessionId 过滤；缺省返回当前用户全部（PENDING 在前）
    sessionReview(id: ID!): SessionReview
    sessionReviews(status: SessionReviewStatus, sessionId: ID): [SessionReview!]!
    # 读取会话工作区内文件内容（fs:read-file relay；只读会话同样允许）
    sessionFileContent(sessionId: ID!, path: String!): SessionFileContent!
  }

  extend type Mutation {
    createSession(input: CreateSessionInput!): CreateSessionPayload!
    closeSession(id: ID!): Boolean!
    deleteSession(id: ID!): Boolean!
    # 归档/取消归档会话（仅分组展示差异，不终止进程、不触发 acp 命令）；
    # 工作流节点会话拒绝 ARCHIVE_WORKFLOW_SESSION_UNSUPPORTED
    archiveSession(id: ID!, archived: Boolean!): Boolean!
    # 删除工作区影响预查询：将连带归档的普通会话数（用于删除确认提示，数量与实际归档一致）
    workspaceArchiveImpact(id: ID!): WorkspaceArchiveImpact!
    # parts 为有序提示词片段（text/image）；parts 非空时以 parts 为准组装提示词，content 保留合并文本兼容。
    # 服务端过滤 trim 为空的文本片段，全空抛 BAD_USER_INPUT('empty prompt')。
    sendSessionMessage(sessionId: ID!, content: String!, type: AcpMessageType = text, attachments: [MessageAttachmentInput!], parts: [PromptPartInput!]): AcpMessage!
    # 提交 Review 结论（PENDING→终态 CAS，重复提交抛 Review not found or already resolved）
    submitSessionReview(id: ID!, input: SubmitSessionReviewInput!): SessionReview!
    cancelGeneration(sessionId: ID!): Boolean!
    resumeSession(id: ID!): ResumeSessionPayload!
    importHistorySessions(controllerId: ID!, workspaceId: ID!, acpServerType: AcpServerType = opencode, sessionIds: [String!]!): [ImportSessionResult!]!
    setSessionMode(sessionId: ID!, modeId: String!): Boolean!
    setSessionModel(sessionId: ID!, modelId: String!): Boolean!
    setSessionConfigOption(sessionId: ID!, configId: String!, value: String!): Boolean!
    deleteHistorySession(sessionId: ID!, syncAgent: Boolean = true): DeleteHistorySessionPayload!
    refreshAcpCapabilities(controllerId: ID!): [AcpCapability!]!
    # 删除该 controllerId+acpServerType 的探测缓存并立即重新探测（失败返回空选项）
    refreshAcpServerOptions(controllerId: ID!, acpServerType: AcpServerType!): AcpServerOptions!
  }
`;
