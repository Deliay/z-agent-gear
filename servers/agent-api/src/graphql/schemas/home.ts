// 对齐 contracts/home.graphql（首页展示优化聚合查询，已定稿契约）
export const homeTypeDefs = `#graphql
  type HomeOverview {
    # 控制器概览（首页卡片 + 侧边栏顶层分组）
    controllers: [Controller!]!
    # 最近会话列表（排除工作流节点会话，与既有 sessions 查询口径一致；服务端按未归档活跃会话过滤）
    sessions: [Session!]!
    # 会话总数（与 sessions 同口径计数：未归档活跃会话数）
    sessionTotalCount: Int!
    # 归档清单不再随首页返回：改为展开时按需拉取 sessions(archived:true) /
    # workflowInstances(archived:true)，且不提供数量。
    # 工作区（侧边栏工作区分组；不返回已删除或非 online 控制器下的项目工作区）
    workspaces: [ControllerWorkspace!]!
    # 全部活跃工作流实例（跨工作区）
    workflowInstances: [WorkflowInstance!]!
    # 待办列表
    todos: [TodoItem!]!
    # 未读待办数
    unreadTodoCount: Int!
    # Review 列表（PENDING 在前，其后按 resolvedAt 倒序的最近终态；总量上限 20；单分支失败降级 []）
    sessionReviews: [SessionReview!]!
    # 已配置工作流（随 15s 轮询定时刷新；设置-工作流区块/新建工作流弹窗共用）
    configuredWorkflows: [ConfiguredWorkflow!]!
    # 工作流模板（随 15s 轮询定时刷新）
    workflowTemplates: [WorkflowTemplate!]!
    # 工作区上下文（原前端组合查询 GetWorkspaceContext = myWorkspaces + myTenants；随 15s 轮询定时刷新）
    workspaceContext: WorkspaceContext!
  }

  # 工作区上下文包络（复用既有 Workspace / TenantMembership 类型，零业务实体新增）
  type WorkspaceContext {
    myWorkspaces: [Workspace!]!
    myTenants: [TenantMembership!]!
  }

  extend type Controller {
    # 嵌套惰性解析：仅查询语句选择时执行（纯 DB 查询，不随控制器在线状态降级；异常时降级空列表）
    gateways: GatewayList!
  }

  extend type ControllerWorkspace {
    # 嵌套惰性解析：仅查询语句选择时按工作区扇出 Worktree；离线或失败返回空列表
    worktrees: [WorkspaceWorktree!]!
  }

  extend type Query {
    homeOverview: HomeOverview!
  }
`;
