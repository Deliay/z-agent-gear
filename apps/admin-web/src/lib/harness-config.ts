/** Harness 压缩指令校验与服务端错误映射（与服务端同口径，服务端仍是唯一事实源）。 */

export const COMPACT_COMMAND_MAX_LENGTH = 64

export const COMPACT_COMMAND_RULE_MESSAGE = '指令需以 / 开头且长度 1~64'

/** trim 后 1~64 字符且以 `/` 开头。 */
export function validateCompactCommand(raw: string): boolean {
  const value = raw.trim()
  return value.length > 0 && value.length <= COMPACT_COMMAND_MAX_LENGTH && value.startsWith('/')
}

/** 服务端 `invalid compact command` 映射为中文提示，其余错误原样透出。 */
export function mapHarnessConfigError(message: string): string {
  return message.includes('invalid compact command') ? COMPACT_COMMAND_RULE_MESSAGE : message
}
