import { getApiBase } from './api-base';

/** 第三方登录错误码 → 友好文案（D10）；未识别 code 原样兜底。 */
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

/** agent-api 授权入口（同源/跨源均以 API base 为准）。 */
export function oauthAuthorizeUrl(providerId: string, surface: 'front' | 'admin'): string {
  const base = getApiBase().replace(/\/+$/, '');
  return `${base}/api/auth/oauth/${encodeURIComponent(providerId)}/authorize?surface=${surface}`;
}
