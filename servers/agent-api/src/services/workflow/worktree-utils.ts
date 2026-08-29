/**
 * 工作流 Worktree 共享工具函数
 * 确保 createWorkflowWorktree（路径生成）与 session.ts（路径校验）使用一致的路径处理逻辑
 */

import crypto from 'crypto';
import path from 'path';

/** 默认 Worktree 工作目录（全平台单一定义；`~` 指控制器本机 home，与设置页展示一致） */
export const DEFAULT_WORKTREE_DIR = '~/.zag/worktrees';

/**
 * 生效 Worktree 目录解析：以控制器设置（controllers.worktreeDir）为准，
 * 未配置/空串时回退默认值 DEFAULT_WORKTREE_DIR。
 */
export function resolveEffectiveWorktreeDir(controller: { worktreeDir?: string | null } | null): string {
  const dir = controller?.worktreeDir;
  return dir && dir.trim() !== '' ? dir : DEFAULT_WORKTREE_DIR;
}

/**
 * 用「控制器上报的 homeDir」展开路径开头的 `~/`；
 * 无 homeDir 或路径不含 `~/` 前缀时原样返回。
 */
export function expandTildeWith(p: string, homeDir?: string | null): string {
  if (!p.startsWith('~/')) return p;
  if (!homeDir) return p;
  const rest = p.slice(2);
  return rest ? path.join(homeDir, rest) : homeDir;
}

/**
 * 归一化用于比较的路径：统一分隔符（`\` → `/`）、折叠 `.`/`..` 段（防止路径穿越绕过前缀校验）；
 * 控制器为 win32 时转小写（Windows 路径大小写不敏感）。
 */
export function normalizeForCompare(p: string, platform?: string | null): string {
  let result = path.posix.normalize(p.replace(/\\/g, '/'));
  if (platform === 'win32') result = result.toLowerCase();
  return result;
}

/**
 * 构造工作区 worktree scope 前缀：expandTildeWith(生效目录) + 清洗后的工作区名 + 末尾分隔符。
 * 生成端（instance.ts/session.ts）与校验端（session.ts/worktree.ts）共用此入口，保证口径一致。
 */
export function worktreeScopePrefix(worktreeDir: string, workspaceName: string, homeDir?: string | null): string {
  const dir = expandTildeWith(worktreeDir, homeDir);
  const safeName = sanitizeWorkspaceName(workspaceName);
  const joined = `${dir}/${safeName}`;
  const normalized = normalizeForCompare(joined);
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

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
