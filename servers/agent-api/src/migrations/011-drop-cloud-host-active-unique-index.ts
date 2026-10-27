import mongoose from 'mongoose';

export const name = '011-drop-cloud-host-active-unique-index';

/**
 * PRD v1.0：用户开放无限制云电脑。下线「每用户同时最多 1 个活跃云电脑」的唯一索引。
 *
 * 迁移 005 只读不回改，下线由本迁移表达；索引已不存在（IndexNotFound，code 27）时跳过（幂等）。
 */
export async function run(): Promise<void> {
  const collection = mongoose.connection.collection('cloudhosts');
  try {
    await collection.dropIndex('uniq_active_cloud_host_per_user');
    console.log('[Migration 011] Dropped uniq_active_cloud_host_per_user on cloudhosts');
  } catch (err) {
    if ((err as { code?: number }).code === 27) {
      console.log('[Migration 011] uniq_active_cloud_host_per_user already absent; skipped');
      return;
    }
    throw err;
  }
}
