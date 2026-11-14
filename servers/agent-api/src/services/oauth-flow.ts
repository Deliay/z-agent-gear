import crypto from 'node:crypto';
import { getRedisClient } from '../middleware/redis.js';

export const OAUTH_STATE_TTL_SECONDS = 600;
export const LOGIN_TICKET_TTL_SECONDS = 60;
export const PENDING_IDENTITY_TTL_SECONDS = 600;
export const FRONT_BIND_TICKET_TTL_SECONDS = 600;

/** 身份选择页待绑定凭证的最大验密失败次数（达到即作废）。 */
export const PENDING_IDENTITY_MAX_FAILURES = 5;

const STATE_PREFIX = 'oauth:state:';
const TICKET_PREFIX = 'oauth:ticket:';
const PENDING_PREFIX = 'oauth:pending:';
const FRONT_BIND_TICKET_PREFIX = 'oauth:front-bind-ticket:';

export type OAuthSurface = 'front' | 'admin' | 'admin-bind' | 'front-bind';

export interface OAuthStatePayload {
  providerId: string;
  surface: OAuthSurface;
  /** OIDC PKCE code_verifier（降级时不写）。 */
  codeVerifier?: string;
  /** OIDC nonce。 */
  nonce?: string;
  /** admin-bind / front-bind 绑定票据（admin-bind 由 admin-api 签发，front-bind 由本服务签发）。 */
  bindTicket?: string;
}

export interface LoginTicketPayload {
  token: string;
  user?: unknown;
  admin?: unknown;
}

/** 身份选择页待绑定身份（不含任何平台账户信息）。 */
export interface PendingIdentityPayload {
  providerId: string;
  issuer: string | null;
  subject: string;
  externalUsername: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  /** 验密失败次数（≥5 作废）。 */
  failCount: number;
}

export interface FrontBindTicketPayload {
  userId: string;
  providerId: string;
}

export function stateKey(state: string): string {
  return `${STATE_PREFIX}${state}`;
}

export function ticketKey(ticket: string): string {
  return `${TICKET_PREFIX}${ticket}`;
}

export function pendingKey(token: string): string {
  return `${PENDING_PREFIX}${token}`;
}

export function frontBindTicketKey(ticket: string): string {
  return `${FRONT_BIND_TICKET_PREFIX}${ticket}`;
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

/** 写身份选择页待绑定凭证（600s）；payload 仅外部身份白名单字段。 */
export async function issuePendingIdentity(
  identity: Omit<PendingIdentityPayload, 'failCount'>,
  token: string = randomToken(),
): Promise<string> {
  const payload: PendingIdentityPayload = { ...identity, failCount: 0 };
  await getRedisClient().set(
    pendingKey(token),
    JSON.stringify(payload),
    'EX',
    PENDING_IDENTITY_TTL_SECONDS,
  );
  return token;
}

/** 读取待绑定身份（不消费；不存在/过期/损坏返回 null）。 */
export async function getPendingIdentity(
  token: string,
): Promise<PendingIdentityPayload | null> {
  if (!token) return null;
  const raw = await getRedisClient().get(pendingKey(token));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingIdentityPayload;
  } catch {
    return null;
  }
}

/** GETDEL 一次性消费待绑定身份（仅在绑定/开户成功路径调用）。 */
export async function consumePendingIdentity(
  token: string,
): Promise<PendingIdentityPayload | null> {
  if (!token) return null;
  const raw = await getRedisClient().getdel(pendingKey(token));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingIdentityPayload;
  } catch {
    return null;
  }
}

/**
 * 验密失败计次（保留原 TTL）；达到上限即作废并返回 null。
 *
 * - `failCount+1` 回写用 `SET ... KEEPTTL`（不重写过期时间）；
 * - `failCount >= PENDING_IDENTITY_MAX_FAILURES` 直接 DEL。
 */
export async function bumpPendingFailCount(
  token: string,
): Promise<PendingIdentityPayload | null> {
  if (!token) return null;
  const redis = getRedisClient();
  const raw = await redis.get(pendingKey(token));
  if (!raw) return null;
  let payload: PendingIdentityPayload;
  try {
    payload = JSON.parse(raw) as PendingIdentityPayload;
  } catch {
    return null;
  }
  const next: PendingIdentityPayload = {
    ...payload,
    failCount: (payload.failCount ?? 0) + 1,
  };
  if (next.failCount >= PENDING_IDENTITY_MAX_FAILURES) {
    await redis.del(pendingKey(token));
    return null;
  }
  await redis.set(pendingKey(token), JSON.stringify(next), 'KEEPTTL');
  return next;
}

/** 写前台绑定票据（600s）；payload 绑定当前用户与 provider。 */
export async function issueFrontBindTicket(
  payload: FrontBindTicketPayload,
  ticket: string = randomToken(),
): Promise<string> {
  await getRedisClient().set(
    frontBindTicketKey(ticket),
    JSON.stringify(payload),
    'EX',
    FRONT_BIND_TICKET_TTL_SECONDS,
  );
  return ticket;
}

/** GETDEL 一次性消费前台绑定票据。 */
export async function consumeFrontBindTicket(
  ticket: string,
): Promise<FrontBindTicketPayload | null> {
  if (!ticket) return null;
  const raw = await getRedisClient().getdel(frontBindTicketKey(ticket));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FrontBindTicketPayload;
  } catch {
    return null;
  }
}
