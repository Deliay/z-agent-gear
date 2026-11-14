import mongoose from 'mongoose';
import { Account } from '../models/account.js';
import { Tenant } from '../models/tenant.js';
import { User } from '../models/user.js';
import { billingClient } from './billing-client.js';
import { workspaceService } from './workspace-service.js';

export interface ProvisionUserInput {
  username: string;
  /** 预哈希密码（bcrypt）：内部开户传用户明文哈希，OAuth 自动开户传随机密码哈希。 */
  passwordHash: string;
  /** `internal`：后台开户（允许幂等重放，由端点层验密）；`oauth`：第三方首登（用户名冲突必须拒绝）。 */
  source: 'internal' | 'oauth';
  /** 端点层已查询的账户：`undefined` = 未查询（自行查询）；`null` = 已知不存在；对象 = 已存在账户。 */
  existingAccount?: unknown;
}

export type ProvisionErrorCode =
  | 'USERNAME_TAKEN'
  | 'BILLING_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export class ProvisioningError extends Error {
  readonly code: ProvisionErrorCode;

  constructor(code: ProvisionErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'ProvisioningError';
  }
}

export interface ProvisionedUser {
  user: { id: string; name: string; createdAt: string };
  account: { id: string; username: string };
  tenant: { id: string; name: string; type: string };
  globalWorkspace: { id: string; name: string; type: string };
  created: boolean;
}

/**
 * 「账户 + 用户 + 个人专属租户 + 零余额租户计费账户 + 全局工作区」开户逻辑单一来源。
 *
 * 由 `routes/internal-users.ts` 抽取（后台开户薄封装）与 OAuth 自动开户共用：
 * - 失败（含计费不可达）向前回滚本次新建文档（不删除既有文档）；
 * - `source=internal`：账户已存在时复用（端点层已完成 409 幂等/重名判定）；
 * - `source=oauth`：账户已存在一律 `USERNAME_TAKEN`（绝不把外部身份挂到既有账户）。
 */
export async function provisionUser(input: ProvisionUserInput): Promise<ProvisionedUser> {
  const { username, passwordHash, source } = input;

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
    let account: { _id: mongoose.Types.ObjectId; username: string; passwordHash?: string } | null;
    if (input.existingAccount !== undefined) {
      account = input.existingAccount as { _id: mongoose.Types.ObjectId; username: string; passwordHash?: string } | null;
    } else {
      account = (await Account.findOne({ username })) as unknown as { _id: mongoose.Types.ObjectId; username: string; passwordHash?: string } | null;
    }
    let created = false;

    if (account && source === 'oauth') {
      throw new ProvisioningError('USERNAME_TAKEN');
    }

    if (!account) {
      try {
        account = (await Account.create({ username, passwordHash })) as unknown as { _id: mongoose.Types.ObjectId; username: string; passwordHash?: string };
        createdAccountIds.push(account._id);
        created = true;
      } catch (err) {
        if ((err as { code?: number }).code === 11000) {
          account = (await Account.findOne({ username })) as unknown as { _id: mongoose.Types.ObjectId; username: string; passwordHash?: string } | null;
          if (!account || source === 'oauth') {
            throw new ProvisioningError('USERNAME_TAKEN');
          }
        } else {
          throw err;
        }
      }
    }

    // 账户已存在但无用户 → 半完成态，按缺失步骤补齐（不覆盖密码）。
    let user = await User.findOne({ accountId: account._id });
    if (!user) {
      const userId = new mongoose.Types.ObjectId();
      user = await User.create({
        _id: userId,
        name: username,
        tenantId: userId,
        accountId: account._id,
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
      throw new ProvisioningError('BILLING_UNAVAILABLE');
    }

    const globalWorkspace = await workspaceService.ensureGlobalWorkspace(String(tenantId), {
      adminUserId: String(user._id),
      createdBy: 'provision',
    });

    return {
      user: {
        id: String(user._id),
        name: user.name ?? '',
        createdAt: (user.createdAt ?? new Date()).toISOString(),
      },
      account: { id: String(account._id), username: account.username },
      tenant: { id: String(tenant._id), name: tenant.name, type: tenant.type },
      globalWorkspace: { id: globalWorkspace.id, name: globalWorkspace.name, type: globalWorkspace.type },
      created,
    };
  } catch (err) {
    // ProvisioningError 在内部已回滚（BILLING_UNAVAILABLE）或未产生写入（USERNAME_TAKEN）；
    // 其余异常统一回滚后原样抛出。
    if (!(err instanceof ProvisioningError)) {
      await rollback();
    }
    throw err;
  }
}
