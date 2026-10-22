import mongoose from 'mongoose';

export const name = '005-cloud-host-active-unique-index';

/**
 * R2-17：每用户同时最多 1 个活跃云电脑的 DB 兜底索引。
 *
 * 仅靠 Mongoose `autoIndex` 在存量违例数据/关闭 autoIndex 的部署下会静默缺失，
 * 因此由迁移显式创建（幂等）；若存量数据已有同用户多个活跃主机，createIndex 会失败，
 * 迁移记录不落库、下次启动重试，并在日志中暴露需要人工清理的数据。
 */
export async function run(): Promise<void> {
  const collection = mongoose.connection.collection('cloudhosts');
  await collection.createIndex(
    { userId: 1 },
    {
      unique: true,
      name: 'uniq_active_cloud_host_per_user',
      partialFilterExpression: {
        status: { $in: ['STARTING', 'RUNNING', 'STOPPING'] },
        deletedAt: null,
      },
    },
  );
  console.log(
    '[Migration 005] Ensured partial unique index uniq_active_cloud_host_per_user on cloudhosts',
  );
}
