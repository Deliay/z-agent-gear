// 登录网络错误判定：仅匹配明确的连接失败短语，避免旧正则把含 "fetch"/"network"/
// "timeout" 的业务错误（如「Network policy denied」）误判为服务器不可达。

const NETWORK_ERROR_PATTERN =
  /failed to fetch|load failed|fetch failed|network ?error|net::err|econnrefused|econnreset|connection (refused|reset|closed|aborted)|timed out/i

export function isNetworkAuthError(err: Error): boolean {
  const message = err.message ?? ''
  // 空 message 无业务语义（多为请求被中断），按连接失败处理并引导检查服务器地址
  if (!message) return true
  if ((err as Error & { networkError?: unknown }).networkError) return true
  return NETWORK_ERROR_PATTERN.test(message)
}
