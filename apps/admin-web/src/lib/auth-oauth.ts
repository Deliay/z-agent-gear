/**
 * 后台第三方登录辅助：错误码文案与 agent-api 授权入口。
 *
 * agent-api 对外地址：构建期 `VITE_AGENT_API_URL` 优先；本地开发回退 `http://localhost:4000`。
 */
const AGENT_API_BASE =
  (import.meta.env.VITE_AGENT_API_URL as string | undefined)?.replace(/\/+$/, '') ||
  'http://localhost:4000';

const ERROR_MESSAGES: Record<string, string> = {
  access_denied: '已取消授权',
  invalid_state: '登录状态已过期，请重试',
  provider_error: '第三方登录服务不可用，请稍后重试',
  provider_unavailable: '该登录方式已停用',
  not_bound: '该身份未绑定任何管理员账户',
  provision_failed: '账户开通失败，请联系管理员',
  invalid_request: '非法的登录请求',
};

export function mapOauthError(code: string | null | undefined): string {
  if (!code) return '';
  return ERROR_MESSAGES[code] ?? code;
}

export function adminOauthAuthorizeUrl(providerId: string): string {
  return `${AGENT_API_BASE}/api/auth/oauth/${encodeURIComponent(providerId)}/authorize?surface=admin`;
}

export function adminBindAuthorizeUrl(providerId: string, ticket: string): string {
  return `${AGENT_API_BASE}/api/auth/oauth/${encodeURIComponent(providerId)}/authorize?surface=admin-bind&ticket=${encodeURIComponent(ticket)}`;
}
