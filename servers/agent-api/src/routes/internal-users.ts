import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { logger as rootLogger } from '../observability/logger.js';
import { Account } from '../models/account.js';
import { assertUsernamePasswordRules, hashPassword, verifyPassword } from '../services/auth.js';
import { provisionUser, ProvisioningError } from '../services/provisioning.js';

const logger = rootLogger.child({ component: 'internal-users' });

function authorized(req: Request): boolean {
  if (!config.internalApiToken) return false;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${config.internalApiToken}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * 后台开户内部端点（admin-api → agent-api）：创建/补齐「账户 + 用户 + 个人专属租户」
 * 三件套，并 get-or-create 零余额租户计费账户与全局工作区。
 *
 * - 鉴权：Bearer INTERNAL_API_TOKEN；
 * - 幂等：按 username——三件套已完整存在返回既有视图（200）；半完成按缺失步骤补齐；
 * - 失败：向前回滚本次新建文档（不删除既有文档），错误体统一 `{ error: '<UPPER_CODE>' }`。
 *
 * 开户逻辑已抽取到 `services/provisioning.ts`（与 OAuth 自动开户共用），本端点只保留
 * 「明文规则校验 + 验密幂等/重名判定 + 错误码映射」。
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

  try {
    // 幂等重放与重名冲突的区分：仅当请求密码可验证既有账户时才视为幂等重放；
    // 用户名被占用（密码不匹配/无法验证）必须 409，不能静默丢弃新密码。
    const existing = await Account.findOne({ username });
    if (existing) {
      let matches = false;
      try {
        matches = await verifyPassword(password, existing.passwordHash);
      } catch {
        matches = false;
      }
      if (!matches) {
        res.status(409).json({ error: 'USERNAME_TAKEN' });
        return;
      }
    }

    const passwordHash = await hashPassword(password);
    const provisioned = await provisionUser({
      username,
      passwordHash,
      password,
      source: 'internal',
      existingAccount: existing ?? null,
    });

    res.status(provisioned.created ? 201 : 200).json({
      user: provisioned.user,
      account: provisioned.account,
      tenant: provisioned.tenant,
      globalWorkspace: provisioned.globalWorkspace,
    });
  } catch (err) {
    if (err instanceof ProvisioningError) {
      if (err.code === 'USERNAME_TAKEN') {
        res.status(409).json({ error: 'USERNAME_TAKEN' });
        return;
      }
      if (err.code === 'BILLING_UNAVAILABLE') {
        res.status(503).json({ error: 'BILLING_UNAVAILABLE' });
        return;
      }
    }
    logger.error({ event: 'provision-failed', err }, 'user provision failed');
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});
