/**
 * 自定义 MCP（工作区）错误文案、验证方式文案与本地校验的单一来源。
 *
 * 服务端契约错误为白名单逐字透传（contracts/custom-mcp.graphql 头注释），本文件只做
 * 中文映射；未命中的文案原样展示。服务端始终是校验权威。
 */
import type { CustomMcpAuthType } from '@/graphql/types'

/** 自定义 MCP 契约错误白名单 → 中文文案 */
export const CUSTOM_MCP_ERROR_MESSAGES: Record<string, string> = {
  'custom mcp server not found': '自定义 MCP 不存在或已被删除',
  'invalid mcp name': '名称格式不正确（1~64 字符）',
  'invalid mcp endpoint': 'endpoint 格式不正确（仅支持 http:// 或 https://）',
  'invalid custom headers': '自定义请求头格式不正确',
  'bearer token is required': '请填写 Bearer token',
  'bearer entry must be manual namespace': '只能选择「自定义密钥」中的条目',
  'bearer entry not editable in place': '该条目不可就地编辑，请前往 Valut 修改',
  'global workspace is read-only': '全局工作区为只读，无法操作自定义 MCP',
  'Not found': '未找到该条目（可能不属于当前工作区）',
  'Not authenticated': '请先登录',
}

export function customMcpErrorMessage(
  error: unknown,
  fallback = '操作失败，请稍后重试',
): string {
  if (error instanceof Error && error.message) {
    const message = error.message.trim()
    return CUSTOM_MCP_ERROR_MESSAGES[message] ?? message
  }
  return fallback
}

/** 验证方式展示文案（列表与对话框共用） */
export const CUSTOM_MCP_AUTH_LABELS: Record<CustomMcpAuthType, string> = {
  none: '无验证',
  bearer: 'Bearer Token',
}

/** endpoint 与服务端同源：仅 http/https、非空、≤1024 */
export function validateCustomMcpEndpoint(raw: string): string | null {
  const endpoint = raw.trim()
  if (!endpoint) return '请输入 endpoint'
  if (endpoint.length > 1024) return 'endpoint 最多 1024 个字符'
  if (!/^https?:\/\//i.test(endpoint)) return 'endpoint 必须以 http:// 或 https:// 开头'
  return null
}

/** 名称与服务端同源：trim 后 1..64 */
export function validateCustomMcpName(raw: string): string | null {
  const name = raw.trim()
  if (!name) return '请输入名称'
  if (name.length > 64) return '名称最多 64 个字符'
  return null
}

/** 描述 ≤512（可空） */
export function validateCustomMcpDescription(raw: string): string | null {
  if (raw.trim().length > 512) return '描述最多 512 个字符'
  return null
}

export const CUSTOM_MCP_MAX_HEADERS = 32
export const CUSTOM_MCP_MAX_HEADER_VALUE_LENGTH = 4096

/**
 * 请求头与服务端同源：key 禁空白与冒号、单值 ≤4096、总条数 ≤32。
 * 返回归一后的非空条目（key/value 均 trim，空行直接丢弃）。
 */
export function normalizeCustomMcpHeaders(
  headers: Array<{ key: string; values: string[] }>,
): { headers: Array<{ key: string; values: string[] }>; error: string | null } {
  const normalized = headers
    .map((header) => ({
      key: header.key.trim(),
      values: header.values.map((value) => value.trim()).filter((value) => value.length > 0),
    }))
    .filter((header) => header.key.length > 0 || header.values.length > 0)

  if (normalized.length > CUSTOM_MCP_MAX_HEADERS) {
    return { headers: [], error: `自定义请求头最多 ${CUSTOM_MCP_MAX_HEADERS} 条` }
  }
  for (const header of normalized) {
    if (!header.key || /[\s:]/.test(header.key)) {
      return { headers: [], error: '请求头名称不能为空且不能包含空白或冒号' }
    }
    if (header.values.length === 0) {
      return { headers: [], error: `请求头 ${header.key} 至少需要一个值` }
    }
    for (const value of header.values) {
      if (value.length > CUSTOM_MCP_MAX_HEADER_VALUE_LENGTH) {
        return { headers: [], error: `请求头 ${header.key} 的值最多 4096 个字符` }
      }
    }
  }
  return { headers: normalized, error: null }
}
