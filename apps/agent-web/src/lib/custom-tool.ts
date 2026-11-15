/**
 * 自定义工具（工作区）错误文案、校验与暴露名规则的单一来源。
 *
 * 服务端契约错误为白名单逐字透传（contracts/custom-tool.graphql 头注释），本文件只做
 * 中文映射；未命中的文案原样展示。服务端始终是校验权威。
 */

export const CUSTOM_TOOL_ERROR_MESSAGES: Record<string, string> = {
  'custom tool not found': '自定义工具不存在或已被删除',
  'invalid custom tool name': '名称格式不正确（1~64 字符）',
  'invalid custom tool description': '描述最多 512 个字符',
  'invalid custom tool args': '参数列表格式不正确（标识重复/非法或数量超限）',
  'invalid fragment template': '模板引用了未声明的参数或密钥名称格式不正确',
  'invalid http config': 'HTTP 配置不正确（method/endpoint/headers/queries/body）',
  'duplicate custom tool name': '当前工作区已存在同名自定义工具',
  'global workspace is read-only': '全局工作区为只读，无法操作自定义工具',
  'Not found': '未找到该条目（可能不属于当前工作区）',
  'Not authenticated': '请先登录',
}

export function customToolErrorMessage(error: unknown, fallback = '操作失败，请稍后重试'): string {
  if (error instanceof Error && error.message) {
    const message = error.message.trim()
    return CUSTOM_TOOL_ERROR_MESSAGES[message] ?? message
  }
  return fallback
}

export const ARG_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
export const MCP_SAFE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

export function validateCustomToolName(raw: string): string | null {
  const name = raw.trim()
  if (!name) return '请输入名称'
  if (name.length > 64) return '名称最多 64 个字符'
  return null
}

export function validateCustomToolDescription(raw: string): string | null {
  if (raw.trim().length > 512) return '描述最多 512 个字符'
  return null
}

/** 参数标识与服务端同源：`^[A-Za-z_][A-Za-z0-9_]{0,63}$` 且工具内唯一。 */
export function validateArgKey(raw: string, siblings: string[] = []): string | null {
  const key = raw.trim()
  if (!key) return '请输入参数标识'
  if (!ARG_KEY_RE.test(key)) return '标识需以字母或下划线开头，仅含字母/数字/下划线（≤64）'
  if (siblings.some((item) => item === key)) return '参数标识重复'
  return null
}

/** 参数展示名：trim 后 1..64。 */
export function validateArgName(raw: string): string | null {
  const name = raw.trim()
  if (!name) return '请输入参数名称'
  if (name.length > 64) return '参数名称最多 64 个字符'
  return null
}

/** 参数描述 ≤256（可空）。 */
export function validateArgDescription(raw: string): string | null {
  if (raw.trim().length > 256) return '参数描述最多 256 个字符'
  return null
}

/** 暴露名（与后端 D4 同规则）：安全名直接用展示名，否则 `ct-<id 后 8 位>`。 */
export function resolveExposedName(tool: { id: string; name: string }): string {
  if (MCP_SAFE_NAME_RE.test(tool.name)) return tool.name
  return `ct-${tool.id.slice(-8)}`
}

export const COMMON_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

/** GET 类不承载 body（与后端保存期校验同口径）。 */
export function isBodyMethod(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS', 'DELETE'].includes(method.trim().toUpperCase())
}

/** header key：禁空白与冒号、不可重复（同名多值合并到同一行）。 */
export function validateHeaderKey(raw: string, siblings: string[] = []): string | null {
  const key = raw.trim()
  if (!key) return '请输入 header 名称'
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key)) return 'header 名称含非法字符'
  if (siblings.some((item) => item.toLowerCase() === key.toLowerCase())) return 'header 名称重复'
  return null
}

/** query key：禁空白与控制字符、不可重复。 */
export function validateQueryKey(raw: string, siblings: string[] = []): string | null {
  const key = raw.trim()
  if (!key) return '请输入 query 名称'
  if (/[\s\p{Cc}]/u.test(key)) return 'query 名称不能包含空白'
  if (siblings.includes(key)) return 'query 名称重复'
  return null
}
