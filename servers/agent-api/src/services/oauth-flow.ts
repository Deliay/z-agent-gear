import crypto from 'node:crypto';
import { getRedisClient } from '../middleware/redis.js';

export const OAUTH_STATE_TTL_SECONDS = 600;
export const LOGIN_TICKET_TTL_SECONDS = 60;

const STATE_PREFIX = 'oauth:state:';
const TICKET_PREFIX = 'oauth:ticket:';

export type OAuthSurface = 'front' | 'admin' | 'admin-bind';

export interface OAuthStatePayload {
  providerId: string;
  surface: OAuthSurface;
  /** OIDC PKCE code_verifier（降级时不写）。 */
  codeVerifier?: string;
  /** OIDC nonce。 */
  nonce?: string;
  /** admin-bind 绑定票据（由 admin-api 签发）。 */
  bindTicket?: string;
}

export interface LoginTicketPayload {
  token: string;
  user?: unknown;
  admin?: unknown;
}

export function stateKey(state: string): string {
  return `${STATE_PREFIX}${state}`;
}

export function ticketKey(ticket: string): string {
  return `${TICKET_PREFIX}${ticket}`;
}

export function randomToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** 写授权状态（600s）；state 同时作为 OAuth state 参数与 PKCE/nonce 容器。 */
export async function issueState(
  payload: OAuthStatePayload,
  state: string = randomToken(),
): Promise<string> {
  await getRedisClient().set(
    stateKey(state),
    JSON.stringify(payload),
    'EX',
    OAUTH_STATE_TTL_SECONDS,
  );
  return state;
}

/** GETDEL 一次性消费授权状态；不存在（过期/重放）返回 null。 */
export async function consumeState(state: string): Promise<OAuthStatePayload | null> {
  if (!state) return null;
  const raw = await getRedisClient().getdel(stateKey(state));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OAuthStatePayload;
  } catch {
    return null;
  }
}

/** 写一次性登录票据（60s）；前端凭 ticket 兑换 JWT。 */
export async function issueLoginTicket(payload: LoginTicketPayload): Promise<string> {
  const ticket = randomToken();
  await getRedisClient().set(
    ticketKey(ticket),
    JSON.stringify(payload),
    'EX',
    LOGIN_TICKET_TTL_SECONDS,
  );
  return ticket;
}

/** GETDEL 一次性消费登录票据。 */
export async function consumeLoginTicket(ticket: string): Promise<LoginTicketPayload | null> {
  if (!ticket) return null;
  const raw = await getRedisClient().getdel(ticketKey(ticket));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LoginTicketPayload;
  } catch {
    return null;
  }
}
