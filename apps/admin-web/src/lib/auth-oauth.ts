/**
 * 后台第三方登录辅助：错误码文案与 agent-api 授权入口。
 *
 * agent-api 对外地址（与 admin-api 地址同为四级优先）：
 *   ① localStorage['zag:agent-api-base']
 *   ② window.__ADMIN_CONFIG__.agentApiUrl（容器启动脚本按 AGENT_API_URL 注入）
 *   ③ import.meta.env.VITE_AGENT_API_URL（构建期默认值）
 *   ④ 同源兜底（''，由部署侧反代 /api 到 agent-api）
 */
const AGENT_API_BASE_STORAGE_KEY = 'zag:agent-api-base'

declare global {
  interface Window {
    __ADMIN_CONFIG__?: { apiUrl?: string; agentApiUrl?: string }
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  access_denied: '已取消授权',
  invalid_state: '登录状态已过期，请重试',
  provider_error: '第三方登录服务不可用，请稍后重试',
  provider_unavailable: '该登录方式已停用',
  not_bound: '该身份未绑定任何管理员账户',
  provision_failed: '账户开通失败，请联系管理员',
  invalid_request: '非法的登录请求',
  invalid_bind_ticket: '绑定已过期，请重新发起',
  already_bound: '该身份已绑定其他管理员账户',
}

function normalize(raw: string | undefined | null): string {
  if (!raw) return ''
  return raw.trim().replace(/\/+$/, '')
}

export function getAgentApiBase(): string {
  try {
    const stored = normalize(localStorage.getItem(AGENT_API_BASE_STORAGE_KEY))
    if (stored) return stored
  } catch {
    // localStorage 受限时继续后续来源
  }
  const fromWindow = normalize(window.__ADMIN_CONFIG__?.agentApiUrl)
  if (fromWindow) return fromWindow
  return normalize(import.meta.env.VITE_AGENT_API_URL as string | undefined)
}

export function setAgentApiBase(endpoint: string): void {
  try {
    const value = normalize(endpoint)
    if (value) localStorage.setItem(AGENT_API_BASE_STORAGE_KEY, value)
    else localStorage.removeItem(AGENT_API_BASE_STORAGE_KEY)
  } catch {
    // 忽略持久化失败
  }
}

export function mapOauthError(code: string | null | undefined): string {
  if (!code) return ''
  return ERROR_MESSAGES[code] ?? code
}

export function adminOauthAuthorizeUrl(providerId: string): string {
  const base = getAgentApiBase()
  return `${base}/api/auth/oauth/${encodeURIComponent(providerId)}/authorize?surface=admin`
}

export function adminBindAuthorizeUrl(providerId: string, ticket: string): string {
  const base = getAgentApiBase()
  return `${base}/api/auth/oauth/${encodeURIComponent(providerId)}/authorize?surface=admin-bind&ticket=${encodeURIComponent(ticket)}`
}
