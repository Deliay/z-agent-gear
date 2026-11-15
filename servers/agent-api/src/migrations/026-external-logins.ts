import mongoose from 'mongoose';
import { logger } from '../observability/logger.js';
import { ensureIndex } from './index-utils.js';

const log = logger.child({ component: 'migration/026-external-logins' });

export const name = '026-external-logins';

type Collection = ReturnType<typeof mongoose.connection.collection>;

/**
 * 026-external-logins：前台外部身份集合 `externallogins` 索引（幂等）。
 *
 * - `{providerId:1, issuer:1, subject:1}` 唯一（`uniq_external_login_subject`）：
 *   身份幂等锚点（跨租户全局唯一，不含 tenantId 维度）；并发首登 E11000 回读既有行。
 * - `{userId:1}`：按用户查询已绑定外部身份。
 *
 * 只建索引、不回填（新集合无存量）；迁移 013 的存量回填对本集合为 no-op。
 */
export const EXTERNAL_LOGIN_INDEXES = [
  {
    keys: { providerId: 1, issuer: 1, subject: 1 },
    options: { unique: true, name: 'uniq_external_login_subject' },
  },
  {
    keys: { userId: 1 },
    options: { name: 'external_login_user' },
  },
] as const;

export async function createExternalLoginIndexes(): Promise<void> {
  const collection = mongoose.connection.collection('externallogins') as Collection;
  for (const entry of EXTERNAL_LOGIN_INDEXES) {
    await ensureIndex(collection, entry.keys, entry.options as never);
  }
}

export async function run(): Promise<void> {
  await createExternalLoginIndexes();
  const indexes = await mongoose.connection
    .collection('externallogins')
    .indexes()
    .catch(() => []);
  log.info({ indexes: indexes.map((index) => index.name) }, 'migration completed');
}
