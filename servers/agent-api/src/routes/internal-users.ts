import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { logger as rootLogger } from '../observability/logger.js';
import { Account } from '../models/account.js';
import { Tenant } from '../models/tenant.js';
import { User } from '../models/user.js';
import { assertUsernamePasswordRules, hashPassword, verifyPassword } from '../services/auth.js';
import { billingClient } from '../services/billing-client.js';
import { workspaceService } from '../services/workspace-service.js';

const logger = rootLogger.child({ component: 'internal-users' });

function authorized(req: Request): boolean {
  if (!config.internalApiToken) return false;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${config.internalApiToken}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

interface UserLike {
  _id: unknown;
  name?: string | null;
  createdAt?: Date | null;
}

function userView(user: UserLike) {
  const createdAt = user.createdAt ?? new Date();
  return { id: String(user._id), name: user.name ?? '', createdAt: createdAt.toISOString() };
}

/**
 * 后台开户内部端点（admin-api → agent-api）：创建/补齐「账户 + 用户 + 个人专属租户」
 * 三件套，并 get-or-create 零余额租户计费账户。
 *
 * - 鉴权：Bearer INTERNAL_API_TOKEN；
 * - 幂等：按 username——三件套已完整存在返回既有视图（200）；半完成按缺失步骤补齐；
 * - 失败：向前回滚本次新建文档（不删除既有文档），错误体统一 `{ error: '<UPPER_CODE>' }`。
 */
export const internalUsersRouter = Router();

internalUsersRouter.post('/', async (req: Request, res: Response) => {
  if (!authorized(req)) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  const body = req.body as { username?: unknown; password?: unknown } | undefined;
  const usernameInput = body?.username;
  const passwordInput = body?.password;

  try {
    assertUsernamePasswordRules(usernameInput, passwordInput);
  } catch (err) {
    res.status(400).json({ error: 'INVALID_BODY', message: (err as Error).message });
    return;
  }

  const username = usernameInput as string;
  const password = passwordInput as string;

  const createdAccountIds: unknown[] = [];
  const createdUserIds: unknown[] = [];
  const createdTenantIds: unknown[] = [];

  const rollback = async () => {
    for (const id of createdTenantIds.reverse()) {
      await Tenant.deleteOne({ _id: id }).catch(() => undefined);
    }
    for (const id of createdUserIds.reverse()) {
      await User.deleteOne({ _id: id }).catch(() => undefined);
    }
    for (const id of createdAccountIds.reverse()) {
      await Account.deleteOne({ _id: id }).catch(() => undefined);
    }
  };

  try {
    let account = await Account.findOne({ username });
    let created = false;

    if (account) {
      // 幂等重放与重名冲突的区分：仅当请求密码可验证既有账户时才视为幂等重放；
      // 用户名被占用（密码不匹配/无法验证）必须 409，不能静默丢弃新密码。
      let matches = false;
      try {
        matches = await verifyPassword(password, account.passwordHash);
      } catch {
        // passwordHash 缺失/损坏：按用户名被占用处理，避免落到 500。
        matches = false;
      }
      if (!matches) {
        res.status(409).json({ error: 'USERNAME_TAKEN' });
        return;
      }
    } else {
      try {
        const passwordHash = await hashPassword(password);
        account = await Account.create({ username, passwordHash });
        createdAccountIds.push(account._id);
        created = true;
      } catch (err) {
        // accounts.username 唯一索引冲突 → 复查后按幂等/重名口径处理（并发开户兜底）
        if ((err as { code?: number }).code === 11000) {
          account = await Account.findOne({ username });
          let raceMatches = false;
          try {
            raceMatches = !!account && (await verifyPassword(password, account.passwordHash));
          } catch {
            raceMatches = false;
          }
          if (!account || !raceMatches) {
            res.status(409).json({ error: 'USERNAME_TAKEN' });
            return;
          }
        } else {
          throw err;
        }
      }
    }

    // 账户已存在但无用户 → 属于半完成态，按缺失步骤补齐（无法验密，不做密码覆盖）。
    let user = await User.findOne({ accountId: account._id });
    if (!user) {
      // 个人专属租户 _id 复用 user _id：先预生成 userId 再落库（tenantId 与 _id 同值）。
      const userId = new mongoose.Types.ObjectId();
      user = await User.create({
        _id: userId,
        name: username,
        tenantId: userId,
        accountId: account._id,
        // 原登录字段一期保留：半完成补齐时从账户复制同值。
        username: account.username,
        passwordHash: account.passwordHash,
      });
      createdUserIds.push(user._id);
      created = true;
    } else if (!user.tenantId) {
      await User.updateOne({ _id: user._id }, { $set: { tenantId: user._id } });
      user.tenantId = user._id as never;
      created = true;
    }

    const tenantId = user.tenantId ?? user._id;
    let tenant = await Tenant.findById(tenantId);
    if (!tenant) {
      tenant = await Tenant.create({
        _id: tenantId,
        name: account.username,
        type: 'personal',
      });
      createdTenantIds.push(tenant._id);
      created = true;
    }

    // 租户计费账户 get-or-create（幂等）：不可达时回滚本次新建文档。
    try {
      await billingClient.getAccount('tenant', String(tenantId), tenant.name);
    } catch {
      await rollback();
      res.status(503).json({ error: 'BILLING_UNAVAILABLE' });
      return;
    }

    // 多租户二期（裁决 16）：确保全局工作区 + `tenantmembers{role:'admin'}`（幂等、半完成补齐）。
    // 置于计费 get-or-create 成功之后，避免额外回滚面。
    const globalWorkspace = await workspaceService.ensureGlobalWorkspace(String(tenantId), {
      adminUserId: String(user._id),
      createdBy: 'provision',
    });

    res.status(created ? 201 : 200).json({
      user: userView(user),
      account: { id: String(account._id), username: account.username },
      tenant: { id: String(tenant._id), name: tenant.name, type: tenant.type },
      globalWorkspace: { id: globalWorkspace.id, name: globalWorkspace.name, type: globalWorkspace.type },
    });
  } catch (err) {
    await rollback();
    logger.error({ event: 'provision-failed', err }, 'user provision failed');
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});
