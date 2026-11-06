/**
 * Valut（工作区密钥）错误文案与本地校验的单一来源。
 *
 * 服务端契约错误为白名单逐字透传（contracts/valut.graphql 头注释），本文件只做
 * 中文映射；**未命中的文案原样展示**，不吞错。服务端始终是校验权威，前端拦截只做即时反馈。
 */

/** Valut 契约错误白名单 → 中文文案 */
export const VALUT_ERROR_MESSAGES: Record<string, string> = {
  'valut entry not found': '密钥条目不存在或已被删除',
  'valut key already exists': '该密钥名称已存在',
  'invalid valut key': '密钥名称格式不正确（1~128 字符，不含空白与控制字符）',
  'invalid valut value': '密钥值不能为空或超过 16384 字符',
  'valut entry is not editable': '该条目不可编辑',
  'valut entry is not deletable': '该条目不可删除',
  'valut entry has refs': '该条目正被引用，请先解除引用后再删除',
  'global workspace is read-only': '全局工作区为只读，无法操作密钥条目',
  'Not found': '未找到该条目（可能不属于当前工作区）',
  'Not authenticated': '请先登录',
}

export function valutErrorMessage(
  error: unknown,
  fallback = '操作失败，请稍后重试',
): string {
  if (error instanceof Error && error.message) {
    const message = error.message.trim()
    return VALUT_ERROR_MESSAGES[message] ?? message
  }
  return fallback
}

/** key 校验与服务端同源：trim 后 1..128，不含空白与控制字符 */
export function validateValutKey(raw: string): string | null {
  const key = raw.trim()
  if (!key) return '请输入密钥名称'
  if (key.length > 128) return '密钥名称最多 128 个字符'
  if (hasForbiddenKeyChar(key)) return '密钥名称不能包含空白或控制字符'
  return null
}

/** 空白（含 CJK 空白）或 C0/C7F 控制字符判定；不用正则字面量承载控制字符（no-control-regex）。 */
function hasForbiddenKeyChar(value: string): boolean {
  if (/\s/.test(value)) return true
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** value 校验与服务端同源：trim 后 1..16384 */
export function validateValutValue(raw: string): string | null {
  const value = raw.trim()
  if (!value) return '请输入密钥值'
  if (value.length > 16384) return '密钥值最多 16384 个字符'
  return null
}
