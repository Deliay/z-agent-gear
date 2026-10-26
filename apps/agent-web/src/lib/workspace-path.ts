/**
 * 工作区路径预览（纯展示，与服务端 `servers/agent-api/src/services/workspace-path.ts` 同规则）。
 *
 * 只用于 UI 预览与提交前校验；最终目录一律由服务端用 `path.posix.join` 权威计算。
 * 容错返回 `null` 而非抛错，避免输入过程中的中间态打断渲染。
 */

/** 容器用户主目录常量；与服务端 `servers/agent-api/src/services/workspace-path.ts` 导出及
 *  `packages/agent-controller/src/cloud-host/supervisor.ts` 的 `DEFAULT_WORKSPACE`/`ZAG_DEFAULT_WORKSPACE`
 * 同源约定。 */
export const CONTAINER_HOME = '/home/worker'

/**
 * 展开首字符 `~` 为容器用户主目录（`/home/worker`）：
 * - `~` / `~/` → `/home/worker`；`~/workspace` → `/home/worker/workspace`；`~/workspace/` → `/home/worker/workspace`；
 * - 仅首字符 `~` 触发展开，`/a/~` 按普通分段处理（不展开、不拒绝）；
 * - `~abc` 等非法形态返回 null（调用方回退 `workspacePrefixError` 文案）。
 * 纯字符串替换，不访问文件系统；非法形态返回 null 而非抛错（预览容错）。
 */
function expandHomePrefix(raw: string): string | null {
  if (raw !== '~' && !raw.startsWith('~/')) return null
  return CONTAINER_HOME + raw.slice(1)
}

function normalizeSegments(raw: string): string[] | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.includes('\0') || trimmed.includes('\\')) return null
  const expanded = trimmed.startsWith('~') ? expandHomePrefix(trimmed) : trimmed
  if (expanded === null) return null
  if (!expanded.startsWith('/')) return null
  if (expanded.split('/').some((segment) => segment === '..')) return null
  const segments: string[] = []
  for (const segment of expanded.split('/')) {
    if (segment === '' || segment === '.') continue
    segments.push(segment)
  }
  return segments
}

/** 归一化 clone 前缀地址；非法输入返回 null。 */
export function normalizeWorkspacePrefixForPreview(raw: string): string | null {
  const segments = normalizeSegments(raw)
  if (segments === null) return null
  return segments.length === 0 ? '/' : `/${segments.join('/')}`
}

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/

/** 预览最终 clone 地址 `<前缀>/<owner>/<repo>`；任一侧非法返回 null。 */
export function previewClonePath(rawPrefix: string, repoFullName: string): string | null {
  const prefix = normalizeWorkspacePrefixForPreview(rawPrefix)
  if (prefix === null) return null
  const repo = repoFullName.trim()
  if (!REPO_PATTERN.test(repo)) return null
  const [owner, name] = repo.split('/')
  if (owner === '.' || owner === '..' || name === '.' || name === '..') return null
  return prefix === '/' ? `/${repo}` : `${prefix}/${repo}`
}

/** 前缀校验提示（与后端错误文案语义一致，用于提交前阻断）。 */
export function workspacePrefixError(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return '请输入前缀地址'
  // 与后端 normalizeWorkspacePrefix 同序：空 → 非法字符 → 绝对路径/~ → ..
  if (trimmed.includes('\0') || trimmed.includes('\\')) return '前缀地址包含非法字符'
  const expanded = trimmed.startsWith('~') ? expandHomePrefix(trimmed) : trimmed
  if (expanded === null || !expanded.startsWith('/')) return '前缀地址必须以 / 或 ~ 开头'
  if (expanded.split('/').some((segment) => segment === '..')) return '前缀地址不能包含 ..'
  return null
}
