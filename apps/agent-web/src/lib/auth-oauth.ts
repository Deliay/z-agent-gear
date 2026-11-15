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
  invalid_bind_ticket: '绑定已过期，请重新发起',
  // 前台文案独立（admin-web 有独立映射文件，不受影响）
  already_bound: '该身份已被其他账户绑定',
  provider_already_bound: '当前账户已绑定该登录方式',
};

export function mapOauthError(code: string | null | undefined): string {
  if (!code) return '';
  return ERROR_MESSAGES[code] ?? code;
}

/**
 * 身份选择页 / 绑定管理 mutation 错误文案（服务端 message 逐字）→ 友好文案。
 * 未识别 message 原样兜底（如 `Invalid username or password` 与登录页一致）。
 */
const IDENTITY_CHOICE_MESSAGES: Record<string, string> = {
  'invalid or expired pending token': '登录状态已过期，请重新登录',
  'identity already bound': '该身份已被其他账户绑定',
  'provider already bound': '当前账户已绑定该登录方式',
  'provider unavailable': '该登录方式已停用',
  'provision failed': '账户开通失败，请联系管理员',
  'cannot unbind last login method': '这是账户唯一的登录方式，请先绑定其他登录方式或联系管理员',
  'external login not found': '绑定记录不存在或已解绑',
};

export function mapIdentityChoiceError(message: string | null | undefined): string {
  if (!message) return '';
  return IDENTITY_CHOICE_MESSAGES[message] ?? message;
}

/** agent-api 授权入口（同源/跨源均以 API base 为准）。 */
export function oauthAuthorizeUrl(
  providerId: string,
  surface: 'front' | 'admin' | 'front-bind',
  ticket?: string,
): string {
  const base = getApiBase().replace(/\/+$/, '');
  const params = new URLSearchParams({ surface });
  if (ticket) params.set('ticket', ticket);
  return `${base}/api/auth/oauth/${encodeURIComponent(providerId)}/authorize?${params.toString()}`;
}
