import crypto from 'node:crypto';
import { getRedisClient } from '../middleware/redis.js';

export const LOGIN_TICKET_TTL_SECONDS = 60;
export const BIND_TICKET_TTL_SECONDS = 600;

const LOGIN_TICKET_PREFIX = 'oauth:ticket:';
const BIND_TICKET_PREFIX = 'oauth:bind-ticket:';

export interface LoginTicketPayload {
  token: string;
  user?: unknown;
  admin?: unknown;
}

export interface BindTicketPayload {
  adminUserId: string;
  providerId: string;
}

export function loginTicketKey(ticket: string): string {
  return `${LOGIN_TICKET_PREFIX}${ticket}`;
}

export function bindTicketKey(ticket: string): string {
  return `${BIND_TICKET_PREFIX}${ticket}`;
}

/** 生成 32 字节随机 hex 票据（一次性凭据不可猜）。 */
export function randomTicket(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** 写一次性登录票据（60s）；GETDEL 由兑换方消费。 */
export async function issueLoginTicket(payload: LoginTicketPayload): Promise<string> {
  const ticket = randomTicket();
  await getRedisClient().set(
    loginTicketKey(ticket),
    JSON.stringify(payload),
    'EX',
    LOGIN_TICKET_TTL_SECONDS,
  );
  return ticket;
}

/** 一次性消费登录票据（GETDEL；不存在/过期/已消费返回 null）。 */
export async function consumeLoginTicket(ticket: string): Promise<LoginTicketPayload | null> {
  if (!ticket) return null;
  const raw = await getRedisClient().getdel(loginTicketKey(ticket));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LoginTicketPayload;
  } catch {
    return null;
  }
}

/** 签发管理员绑定票据（600s，admin-api 自签，admin-bind 消费）。 */
export async function issueBindTicket(payload: BindTicketPayload): Promise<string> {
  const ticket = randomTicket();
  await getRedisClient().set(
    bindTicketKey(ticket),
    JSON.stringify(payload),
    'EX',
    BIND_TICKET_TTL_SECONDS,
  );
  return ticket;
}

/** 一次性消费绑定票据（GETDEL）。 */
export async function consumeBindTicket(ticket: string): Promise<BindTicketPayload | null> {
  if (!ticket) return null;
  const raw = await getRedisClient().getdel(bindTicketKey(ticket));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BindTicketPayload;
  } catch {
    return null;
  }
}
