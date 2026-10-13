// 对齐 contracts/home.graphql（首页展示优化聚合查询，已定稿契约）
export const homeTypeDefs = `#graphql
  type HomeOverview {
    # 控制器概览（首页卡片 + 侧边栏顶层分组）
    controllers: [Controller!]!
    # 最近会话列表（排除工作流节点会话，与既有 sessions 查询口径一致）
    sessions: [Session!]!
    # 会话总数（与 sessions 同口径计数）
    sessionTotalCount: Int!
    # 工作区（侧边栏工作区分组）
    workspaces: [ControllerWorkspace!]!
    # 全部活跃工作流实例（跨工作区）
    workflowInstances: [WorkflowInstance!]!
    # 已归档工作流实例（侧边栏折叠展示）
    archivedWorkflowInstances: [WorkflowInstance!]!
    # 待办列表
    todos: [TodoItem!]!
    # 未读待办数
    unreadTodoCount: Int!
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
