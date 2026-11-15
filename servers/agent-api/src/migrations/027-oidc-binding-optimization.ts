import mongoose from 'mongoose';
import { logger } from '../observability/logger.js';
import { ensureIndex } from './index-utils.js';

const log = logger.child({ component: 'migration/027-oidc-binding-optimization' });

export const name = '027-oidc-binding-optimization';

type Collection = ReturnType<typeof mongoose.connection.collection>;

/**
 * 每账户每 Provider 唯一（绑定路径的第二个裁决面）。
 *
 * 模型声明与迁移双写（与 026 的既有形态一致）；存量数据天然满足
 * （自动开户每身份一个全新用户，同一用户同 Provider 不可能两行）。
 */
export const USER_PROVIDER_INDEX = {
  keys: { userId: 1, providerId: 1 },
  options: { unique: true, name: 'uniq_external_login_user_provider' },
} as const;

function isNamespaceMissing(err: unknown): boolean {
  const code = (err as { code?: number }).code;
  return code === 26 || /ns not found|namespace not found/i.test((err as Error).message ?? '');
}

/** 幂等创建 `externallogins.uniq_external_login_user_provider`。 */
export async function ensureExternalLoginUserProviderIndex(): Promise<void> {
  const collection = mongoose.connection.collection('externallogins') as Collection;
  await ensureIndex(collection, USER_PROVIDER_INDEX.keys, USER_PROVIDER_INDEX.options as never);
}

/**
 * 回填存量无密码账户：`accounts._id ∈ externallogins.accountId` 且未设置 `passwordless`
 * 的文档置 `passwordless: true`（重复执行幂等）。
 *
 * 先建索引后回填（同一迁移内顺序执行）。
 */
export async function backfillPasswordless(): Promise<number> {
  const externalLogins = mongoose.connection.collection('externallogins') as Collection;
  const accounts = mongoose.connection.collection('accounts') as Collection;

  let accountIds: unknown[] = [];
  try {
    accountIds = (await externalLogins.distinct('accountId')) as unknown[];
  } catch (err) {
    if (isNamespaceMissing(err)) {
      log.info('externallogins collection not found, skip passwordless backfill');
      return 0;
    }
    throw err;
  }
  if (accountIds.length === 0) return 0;

  const result = await accounts.updateMany(
    { _id: { $in: accountIds as mongoose.Types.ObjectId[] }, passwordless: { $exists: false } },
    { $set: { passwordless: true } },
  );
  return result.modifiedCount ?? 0;
}

export async function run(): Promise<void> {
  await ensureExternalLoginUserProviderIndex();
  const backfilled = await backfillPasswordless();
  const indexes = await mongoose.connection
    .collection('externallogins')
    .indexes()
    .catch(() => []);
  log.info(
    { indexes: indexes.map((index) => index.name), backfilled },
    'migration completed',
  );
}
