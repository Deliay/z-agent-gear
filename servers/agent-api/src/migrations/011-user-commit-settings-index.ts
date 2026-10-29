import mongoose from 'mongoose';
import { ensureIndex } from './index-utils.js';

export const name = '011-user-commit-settings-index';

/**
 * Commit 设置按 `userId` upsert / 查询，必须保证每用户单行。
 *
 * Mongoose `autoIndex` 在关闭索引自动创建的部署（或存量集合）下会静默缺失，
 * 由迁移显式创建唯一索引（幂等）。
 *
 * 存量环境里 Mongoose 可能已用默认名 `userId_1` 建过同键索引，直接 createIndex
 * 会抛 IndexOptionsConflict（code 85），因此走 ensureIndex 先清理同键旧索引。
 */
export async function run(): Promise<void> {
  const collection = mongoose.connection.collection('user_commit_settings');
  await ensureIndex(collection, { userId: 1 }, { unique: true, name: 'uniq_user_commit_setting' });
  console.log('[Migration 011] Ensured unique index uniq_user_commit_setting on user_commit_settings');
}
