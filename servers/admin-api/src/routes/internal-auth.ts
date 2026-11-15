import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { logger as rootLogger } from '../observability/logger.js';
import { AdminUser } from '../models/admin-user.js';
import { AuthProvider } from '../models/auth-provider.js';
import { adminExternalLoginService } from '../services/admin-external-login.js';
import { consumeBindTicket, issueLoginTicket } from '../services/auth-ticket.js';
import { signToken } from '../services/auth.js';

const logger = rootLogger.child({ component: 'internal-auth' });

function authorized(req: Request): boolean {
  if (!config.internalApiToken) return false;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${config.internalApiToken}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

interface IdentityBody {
  providerId?: unknown;
  issuer?: unknown;
  subject?: unknown;
  profile?: { externalUsername?: unknown; displayName?: unknown };
}

function parseIdentity(body: unknown): {
  providerId: string;
  issuer: string | null;
  subject: string;
  externalUsername: string;
  displayName: string | null;
} | null {
  const value = body as IdentityBody | undefined;
  const providerId = typeof value?.providerId === 'string' ? value.providerId : '';
  const subject = typeof value?.subject === 'string' ? value.subject : '';
  const externalUsername =
    typeof value?.profile?.externalUsername === 'string' ? value.profile.externalUsername : '';
  if (!providerId || !subject || !externalUsername) return null;
  return {
    providerId,
    issuer: typeof value?.issuer === 'string' && value.issuer ? value.issuer : null,
    subject,
    externalUsername,
    displayName:
      typeof value?.profile?.displayName === 'string' && value.profile.displayName
        ? value.profile.displayName
        : null,
  };
}

/**
 * 后台第三方登录内部端点（agent-api → admin-api）。
 *
 * - 鉴权：Bearer INTERNAL_API_TOKEN + `crypto.timingSafeEqual`（与 `/internal/users` 同信任级别）；
 * - `POST /admin-tickets`：校验绑定 → 签发 admin JWT → 写一次性 ticket（60s）；
 * - `POST /admin-bind`：消费绑定票据（GETDEL）→ upsert 绑定关系。
 */
export const internalAuthRouter: Router = Router();

internalAuthRouter.post('/admin-tickets', async (req: Request, res: Response) => {
  if (!authorized(req)) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }
  const identity = parseIdentity(req.body);
  if (!identity) {
    res.status(400).json({ error: 'INVALID_BODY' });
    return;
  }
  try {
    const binding = await adminExternalLoginService.findBound(identity);
    if (!binding) {
      res.status(403).json({ error: 'NOT_BOUND' });
      return;
    }
    const admin = await AdminUser.findById(binding.adminUserId).lean() as {
      _id: { toString(): string };
      username: string;
      mustChangePassword: boolean;
      passwordChangedAt?: Date | null;
      createdAt: Date;
      updatedAt: Date;
    } | null;
    if (!admin) {
      res.status(403).json({ error: 'NOT_BOUND' });
      return;
    }
    const token = signToken(admin._id.toString(), admin.passwordChangedAt ?? null);
    const ticket = await issueLoginTicket({
      token,
      admin: {
        id: admin._id.toString(),
        username: admin.username,
        mustChangePassword: admin.mustChangePassword,
        createdAt: admin.createdAt.toISOString(),
        updatedAt: admin.updatedAt.toISOString(),
      },
    });
    res.status(200).json({ ticket });
  } catch (err) {
    logger.error({ err, providerId: identity.providerId }, 'admin ticket issue failed');
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

internalAuthRouter.post('/admin-bind', async (req: Request, res: Response) => {
  if (!authorized(req)) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }
  const identity = parseIdentity(req.body);
  const bindTicket = typeof (req.body as { bindTicket?: unknown })?.bindTicket === 'string'
    ? (req.body as { bindTicket: string }).bindTicket
    : '';
  if (!identity || !bindTicket) {
    res.status(400).json({ error: 'INVALID_BODY' });
    return;
  }
  try {
    const payload = await consumeBindTicket(bindTicket);
    if (!payload || payload.providerId !== identity.providerId) {
      res.status(400).json({ error: 'INVALID_BIND_TICKET' });
      return;
    }
    const provider = await AuthProvider.findById(identity.providerId).lean() as {
      enabled?: boolean;
      enableAdminLogin?: boolean;
      type?: string;
    } | null;
    if (!provider || !provider.enabled) {
      res.status(400).json({ error: 'INVALID_BIND_TICKET' });
      return;
    }
    await adminExternalLoginService.bind(payload.adminUserId, identity);
    res.status(200).json({ ok: true });
  } catch (err) {
    if ((err as Error).message === 'EXTERNAL_IDENTITY_ALREADY_BOUND') {
      res.status(409).json({ error: 'ALREADY_BOUND' });
      return;
    }
    logger.error({ err, providerId: identity.providerId }, 'admin bind failed');
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});
