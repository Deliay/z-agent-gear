/**
 * 工作区路径预览（纯展示，与服务端 `servers/agent-api/src/services/workspace-path.ts` 同规则）。
 *
 * 只用于 UI 预览与提交前校验；最终目录一律由服务端用 `path.posix.join` 权威计算。
 * 容错返回 `null` 而非抛错，避免输入过程中的中间态打断渲染。
 */

function normalizeSegments(raw: string): string[] | null {
  const trimmed = raw.trim()
  if (!trimmed || !trimmed.startsWith('/') || trimmed.includes('\0') || trimmed.includes('\\')) {
    return null
  }
  const segments: string[] = []
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    segments.push(segment)
  }
  return segments
}

/** 归一化 clone 前缀地址；非法输入返回 null。 */
export function normalizeWorkspacePrefixForPreview(raw: string): string | null {
  const segments = normalizeSegments(raw)
  if (segments === null) return null
  return `/${segments.join('/')}`
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
  if (!trimmed.startsWith('/')) return '前缀地址必须以 / 开头'
  if (trimmed.includes('\0') || trimmed.includes('\\')) return '前缀地址包含非法字符'
  if (trimmed.split('/').some((segment) => segment === '..')) return '前缀地址不能包含 ..'
  return null
}
