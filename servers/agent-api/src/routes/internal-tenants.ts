import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { logger as rootLogger } from '../observability/logger.js';
import { Account } from '../models/account.js';
import { Tenant } from '../models/tenant.js';
import { User } from '../models/user.js';
import { TenantMember } from '../models/tenant-member.js';
import { billingClient } from '../services/billing-client.js';
import { workspaceService } from '../services/workspace-service.js';
import { tenantMemberService } from '../services/tenant-member-service.js';

const logger = rootLogger.child({ component: 'internal-tenants' });

function authorized(req: Request): boolean {
  if (!config.internalApiToken) return false;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${config.internalApiToken}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function tenantView(tenant: { _id: unknown; name: string; type?: string }) {
  return { id: String(tenant._id), name: tenant.name, type: tenant.type === 'team' ? 'team' : 'personal' };
}

/**
 * 后台 team 租户开通与成员初始化内部端点（admin-api → agent-api）。
 *
 * 鉴权：Bearer INTERNAL_API_TOKEN；错误体统一 `{ error: '<UPPER_CODE>' }`（沿用 internal-users 口径）。
 * 写权：tenants/tenantmembers/workspaces 唯一写方为 agent-api（本路由与 /internal/users）。
 */
export const internalTenantsRouter = Router();

internalTenantsRouter.post('/', async (req: Request, res: Response) => {
  if (!authorized(req)) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }
  const body = req.body as { name?: unknown } | undefined;
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 60) {
    res.status(400).json({ error: 'INVALID_BODY' });
    return;
  }

  const createdTenantId: unknown[] = [];
  try {
    const existing = await Tenant.findOne({ name });
    if (existing) {
      if (existing.type !== 'team') {
        res.status(409).json({ error: 'TENANT_NAME_TAKEN' });
        return;
      }
      const global = await workspaceService.ensureGlobalWorkspace(String(existing._id));
      res.status(200).json({ tenant: tenantView(existing), globalWorkspace: global });
      return;
    }

    let tenant;
    try {
      tenant = await Tenant.create({ name, type: 'team' });
      createdTenantId.push(tenant._id);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        res.status(409).json({ error: 'TENANT_NAME_TAKEN' });
        return;
      }
      throw err;
    }

    const globalWorkspace = await workspaceService.ensureGlobalWorkspace(String(tenant._id));
    try {
      await billingClient.getAccount('tenant', String(tenant._id), tenant.name);
    } catch {
      // 失败向前回滚本次新建（全局工作区 + 租户）
      await Tenant.deleteOne({ _id: tenant._id }).catch(() => undefined);
      res.status(503).json({ error: 'BILLING_UNAVAILABLE' });
      return;
    }

    res.status(201).json({ tenant: tenantView(tenant), globalWorkspace });
  } catch (err) {
    for (const id of createdTenantId.reverse()) {
      await Tenant.deleteOne({ _id: id }).catch(() => undefined);
    }
    logger.error({ event: 'create-failed', err }, 'tenant create failed');
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

internalTenantsRouter.post('/:tenantId/members', async (req: Request, res: Response) => {
  if (!authorized(req)) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }
  const tenantId = String(req.params.tenantId ?? '');
  if (!mongoose.isValidObjectId(tenantId)) {
    res.status(404).json({ error: 'TENANT_NOT_FOUND' });
    return;
  }
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) {
    res.status(404).json({ error: 'TENANT_NOT_FOUND' });
    return;
  }
  if (tenant.type !== 'team') {
    res.status(400).json({ error: 'PERSONAL_TENANT_IMMUTABLE' });
    return;
  }
  const body = req.body as { username?: unknown; role?: unknown; operatorId?: unknown } | undefined;
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const role = body?.role === undefined || body?.role === null ? 'developer' : body.role;
  const operatorId = typeof body?.operatorId === 'string' && body.operatorId ? body.operatorId : 'admin_api';
  if (!username) {
    res.status(400).json({ error: 'INVALID_BODY' });
    return;
  }
  if (role !== 'admin' && role !== 'developer') {
    res.status(400).json({ error: 'INVALID_ROLE' });
    return;
  }

  try {
    const account = await Account.findOne({ username });
    if (!account) {
      res.status(404).json({ error: 'ACCOUNT_NOT_FOUND' });
      return;
    }
    const user = await User.findOne({ accountId: account._id });
    if (!user) {
      res.status(404).json({ error: 'ACCOUNT_NOT_FOUND' });
      return;
    }
    const existing = await TenantMember.findOne({ tenantId, userId: user._id });
    const view = await tenantMemberService.addTenantMember(
      operatorId,
      tenantId,
      username,
      role,
      true,
    );
    res.status(existing ? 200 : 201).json({
      user: {
        id: String(user._id),
        name: user.name ?? username,
        username,
        role: view.role,
      },
    });
  } catch (err) {
    const message = (err as Error).message;
    if (message === 'account not found') res.status(404).json({ error: 'ACCOUNT_NOT_FOUND' });
    else if (message === 'personal tenant is immutable')
      res.status(400).json({ error: 'PERSONAL_TENANT_IMMUTABLE' });
    else if (message === 'invalid tenant role') res.status(400).json({ error: 'INVALID_ROLE' });
    else if (message === 'already a member') res.status(409).json({ error: 'ALREADY_MEMBER' });
    else {
      logger.error({ event: 'add-member-failed', err }, 'add tenant member failed');
      res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  }
});

internalTenantsRouter.delete('/:tenantId/members/:userId', async (req: Request, res: Response) => {
  if (!authorized(req)) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }
  const tenantId = String(req.params.tenantId ?? '');
  const userId = String(req.params.userId ?? '');
  if (!mongoose.isValidObjectId(tenantId) || !mongoose.isValidObjectId(userId)) {
    res.status(404).json({ error: 'NOT_MEMBER' });
    return;
  }
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) {
    res.status(404).json({ error: 'TENANT_NOT_FOUND' });
    return;
  }
  if (tenant.type !== 'team') {
    res.status(400).json({ error: 'PERSONAL_TENANT_IMMUTABLE' });
    return;
  }
  const operatorId =
    typeof req.query.operatorId === 'string' && req.query.operatorId ? req.query.operatorId : 'admin_api';

  try {
    // 移除成员：级联清理 workspacemembers（service 内 last-admin 保护与审计）
    await tenantMemberService.removeTenantMember(operatorId, tenantId, userId, true);
    res.status(200).json({ ok: true });
  } catch (err) {
    const message = (err as Error).message;
    if (message === 'not a member') res.status(404).json({ error: 'NOT_MEMBER' });
    else if (message === 'last admin cannot be removed') res.status(409).json({ error: 'LAST_ADMIN' });
    else if (message === 'personal tenant is immutable')
      res.status(400).json({ error: 'PERSONAL_TENANT_IMMUTABLE' });
    else {
      logger.error({ event: 'remove-member-failed', err }, 'remove tenant member failed');
      res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  }
});
