/**
 * 「检测到项目工作流模板」提示的会话内记忆（模块级 Set<workspaceId>）。
 *
 * 语义：同一页面会话内，某个项目工作区已自动提示过一次（含用户选择「取消」）后
 * 不再自动弹出；页面刷新后允许再次提示。手动「重新检测」与设置区块常驻入口不受影响。
 */
const promptedWorkspaceIds = new Set<string>()

export function hasPromptedRepoWorkflow(workspaceId: string): boolean {
  return promptedWorkspaceIds.has(workspaceId)
}

export function markRepoWorkflowPrompted(workspaceId: string): void {
  promptedWorkspaceIds.add(workspaceId)
}

/** 仅用于测试/会话重置 */
export function resetRepoWorkflowPrompted(): void {
  promptedWorkspaceIds.clear()
}
