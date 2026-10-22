import path from 'node:path';

/**
 * 工作区路径归一与 clone 路径拼接（服务端权威）。
 *
 * 语义：`SetupCloudHostGithubProjectInput.targetPath` 是 **clone 前缀地址（工作根目录）**，
 * 最终目录 = `<前缀>/<owner>/<repo>`。纯函数、无 IO，便于单测。
 */

/** 错误文案（契约级，前端映射为中文提示；服务端逐字返回）。 */
export const PREFIX_ERRORS = {
  empty: '前缀地址不能为空',
  notAbsolute: '前缀地址必须是绝对路径',
  illegalChars: '前缀地址包含非法字符',
  traversal: '前缀地址不能包含 ..',
  repoFormat: '仓库格式应为 owner/repo',
} as const;

/**
 * 归一化 clone 前缀地址：
 * - trim 后不得为空；
 * - 必须为绝对路径（`/` 开头）；
 * - 不允许反斜杠与 NUL；
 * - 任一分段为 `..` 直接拒绝（不依赖 normalize 的折叠行为）；
 * - 用 `path.posix.normalize` 合并重复斜杠与 `.`，保留根 `/`，去掉末尾斜杠（根除外）。
 */
export function normalizeWorkspacePrefix(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new Error(PREFIX_ERRORS.empty);
  if (trimmed.includes('\0') || trimmed.includes('\\')) {
    throw new Error(PREFIX_ERRORS.illegalChars);
  }
  if (!trimmed.startsWith('/')) throw new Error(PREFIX_ERRORS.notAbsolute);
  if (trimmed.split('/').some((segment) => segment === '..')) {
    throw new Error(PREFIX_ERRORS.traversal);
  }
  const normalized = path.posix.normalize(trimmed);
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
