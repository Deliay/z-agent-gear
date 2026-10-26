import path from 'node:path';

/**
 * 工作区路径归一与 clone 路径拼接（服务端权威）。
 *
 * 语义：`SetupCloudHostGithubProjectInput.targetPath` 是 **clone 前缀地址（工作根目录）**，
 * 最终目录 = `<前缀>/<owner>/<repo>`。纯函数、无 IO，便于单测。
 */

/** 容器用户主目录常量；与 `packages/agent-controller/src/cloud-host/supervisor.ts` 的 DEFAULT_WORKSPACE / ZAG_DEFAULT_WORKSPACE 同源约定。 */
export const CONTAINER_HOME = '/root';

/** 错误文案（契约级，前端映射为中文提示；服务端逐字返回）。 */
export const PREFIX_ERRORS = {
  empty: '前缀地址不能为空',
  notAbsolute: '前缀地址必须以 / 或 ~ 开头',
  illegalChars: '前缀地址包含非法字符',
  traversal: '前缀地址不能包含 ..',
  repoFormat: '仓库格式应为 owner/repo',
} as const;

/**
 * 展开首字符 `~` 为容器用户主目录（`/root`）：
 * - `~` / `~/` → `/root`；`~/workspace` → `/root/workspace`；
 * - 仅首字符 `~` 触发展开，`/a/~` 按普通分段处理（不展开、不拒绝）；
 * - `~user` 等形式不支持，抛 `notAbsolute`。
 * 纯字符串前缀替换，不访问文件系统。
 */
function expandHomePrefix(value: string): string {
  if (!value.startsWith('~')) return value;
  if (value !== '~' && !value.startsWith('~/')) {
    throw new Error(PREFIX_ERRORS.notAbsolute);
  }
  return CONTAINER_HOME + value.slice(1);
}

/**
 * 归一化 clone 前缀地址：
 * - trim 后不得为空；
 * - 不允许反斜杠与 NUL；
 * - 支持首字符 `~`（展开为 `/root`），否则必须为绝对路径（`/` 开头）；
 * - 任一分段为 `..` 直接拒绝（不依赖 normalize 的折叠行为）；
 * - 用 `path.posix.normalize` 合并重复斜杠与 `.`，保留根 `/`，去掉末尾斜杠（根除外）。
 */
export function normalizeWorkspacePrefix(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new Error(PREFIX_ERRORS.empty);
  if (trimmed.includes('\0') || trimmed.includes('\\')) {
    throw new Error(PREFIX_ERRORS.illegalChars);
  }
  const expanded = expandHomePrefix(trimmed);
  if (!expanded.startsWith('/')) throw new Error(PREFIX_ERRORS.notAbsolute);
  if (expanded.split('/').some((segment) => segment === '..')) {
    throw new Error(PREFIX_ERRORS.traversal);
  }
  const normalized = path.posix.normalize(expanded);
  if (normalized === '/') return '/';
  return normalized.replace(/\/+$/, '');
}

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/**
 * 计算最终 clone 目录：`path.posix.join(prefix, owner/repo)`。
 * repo 必须为 `owner/repo` 且两段都不能是 `.`/`..`（防目录穿越）。
 */
export function resolveClonePath(prefix: string, repoFullName: string): string {
  const repo = (repoFullName ?? '').trim();
  if (!REPO_PATTERN.test(repo)) throw new Error(PREFIX_ERRORS.repoFormat);
  const [owner, name] = repo.split('/');
  if (owner === '.' || owner === '..' || name === '.' || name === '..') {
    throw new Error(PREFIX_ERRORS.repoFormat);
  }
  return path.posix.join(prefix, repo);
}
