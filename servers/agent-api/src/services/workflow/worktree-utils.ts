/**
 * 工作流 Worktree 共享工具函数
 * 确保 createWorkflowWorktree（路径生成）与 session.ts（路径校验）使用一致的路径处理逻辑
 */

import crypto from 'crypto';

/** 将 workspace.name 清洗为安全的路径片段：仅保留安全字符，避免空格/斜杠等非法路径字符 */
export function sanitizeWorkspaceName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    || 'workspace';
}

/**
 * 生成 8 位随机 hex 字符串，用作 worktree 路径/分支的唯一后缀。
 * 天然碰撞概率极低（16^8 = 4.2B 组合），无需冲突重试。
 */
export function generateWorktreeSuffix(): string {
  return crypto.randomBytes(4).toString('hex');
}
