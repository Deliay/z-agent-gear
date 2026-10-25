import mongoose from 'mongoose';

export const name = '009-todo-harness-login';

/**
 * harness 登录引导待办的幂等 upsert / 终态收敛按 `harnessLoginData.requestId` 定位。
 *
 * Mongoose `autoIndex` 在关闭索引自动创建的部署（或存量集合）下会静默缺失，
 * 导致每次登录引导都走全集合扫描；由迁移显式创建（幂等）。
 */
export async function run(): Promise<void> {
  const collection = mongoose.connection.collection('todoitems');
  await collection.createIndex(
    { 'harnessLoginData.requestId': 1 },
    { name: 'harness_login_request_id' },
  );
  console.log('[Migration 009] Ensured index harness_login_request_id on todoitems');
}
