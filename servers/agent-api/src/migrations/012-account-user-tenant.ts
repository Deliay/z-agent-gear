import mongoose from 'mongoose';
import { Account } from '../models/account.js';
import { Tenant } from '../models/tenant.js';
import { User } from '../models/user.js';

export const name = '012-account-user-tenant';

/** 批处理大小（逐批分页，避免一次性加载全量用户）。 */
export const BATCH_SIZE = 500;

export interface Migration012Stats {
  /** 已扫描用户数 */
  users: number;
  /** 本次新建的账户数 */
  accounts: number;
  /** 本次补齐字段的用户数 */
  userPatches: number;
  /** 本次新建的个人专属租户数 */
  tenants: number;
}

interface UserRow {
  _id: mongoose.Types.ObjectId;
  username?: string;
  passwordHash?: string;
  name?: string;
  tenantId?: mongoose.Types.ObjectId | null;
  accountId?: mongoose.Types.ObjectId | null;
}

/**
 * 迁移 012：把存量 user 拆为「账户 + 用户 + 个人专属租户」三件套。
 *
 * 逐 user 三步（**只复制不删除**，原登录字段与唯一索引一期保留）：
 * 1. 建 `accounts`（复制 username/passwordHash；按 username 判缺，已存在则取其 _id）；
 * 2. `$set users{name, tenantId=_id, accountId}`（字段已设置则跳过，半完成态只补齐缺失项）；
 * 3. 建 `tenants`（_id=userId、name=用户名、type=personal；按 _id 判缺）。
 *
 * 幂等：每步以目标状态存在性为判据，重跑只补齐缺失；完成后校验三项计数为 0
 * （无 account 用户、无 tenantId 用户、tenantId != _id 用户），非 0 抛错由 runner 下次启动重试。
 */
export async function run(): Promise<void> {
  const stats: Migration012Stats = { users: 0, accounts: 0, userPatches: 0, tenants: 0 };
  let lastId: mongoose.Types.ObjectId | null = null;

  for (;;) {
    const filter: Record<string, unknown> = {};
    if (lastId) filter._id = { $gt: lastId };
    const users = (await User.find(filter).sort({ _id: 1 }).limit(BATCH_SIZE).lean()) as unknown as UserRow[];
    if (users.length === 0) break;

    for (const user of users) {
      await migrateUser(user, stats);
    }

    stats.users += users.length;
    lastId = users[users.length - 1]._id;
    console.log(
      `[Migration 012] processed ${stats.users} users (+${stats.accounts} accounts, +${stats.tenants} tenants)`,
    );
    if (users.length < BATCH_SIZE) break;
  }

  const noAccount = await User.countDocuments({
    $or: [{ accountId: { $exists: false } }, { accountId: null }],
  });
  const noTenant = await User.countDocuments({
    $or: [{ tenantId: { $exists: false } }, { tenantId: null }],
  });
  const mismatched = await User.countDocuments({
    $expr: { $ne: ['$tenantId', '$_id'] },
  } as never);

  console.log(
    `[Migration 012] verification: noAccount=${noAccount} noTenant=${noTenant} tenantIdMismatch=${mismatched} (scanned ${stats.users})`,
  );
  if (noAccount > 0 || noTenant > 0 || mismatched > 0) {
    throw new Error(
      `migration 012 verification failed (noAccount=${noAccount}, noTenant=${noTenant}, tenantIdMismatch=${mismatched})`,
    );
  }
}

async function migrateUser(user: UserRow, stats: Migration012Stats): Promise<void> {
  const userId = user._id;

  // 步骤 1：账户（按 username 判缺；accountId 已存在则信任既有账户）
  let accountId = user.accountId ?? null;
  if (!accountId) {
    const username = user.username;
    let account = username ? await Account.findOne({ username }).lean() : null;
    if (!account) {
      if (!username || !user.passwordHash) {
        console.warn(`[Migration 012] skip user ${String(userId)}: missing username/passwordHash`);
        return;
      }
      account = await Account.create({ username, passwordHash: user.passwordHash });
      stats.accounts += 1;
    }
    accountId = account._id as mongoose.Types.ObjectId;
  }

  // 步骤 2：用户字段（tenantId=userId；只补齐缺失项，不 $unset 原登录字段）
  const patch: Record<string, unknown> = {};
  if (!user.name && user.username) patch.name = user.username;
  if (!user.tenantId) patch.tenantId = userId;
  if (!user.accountId) patch.accountId = accountId;
  if (Object.keys(patch).length > 0) {
    await User.updateOne({ _id: userId }, { $set: patch });
    stats.userPatches += 1;
  }

  // 步骤 3：个人专属租户（_id 复用 userId）
  const tenant = await Tenant.findById(userId).lean();
  if (!tenant) {
    const tenantName = user.name ?? user.username ?? String(userId);
    await Tenant.create({ _id: userId, name: tenantName, type: 'personal' });
    stats.tenants += 1;
  }
}
