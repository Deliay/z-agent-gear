import mongoose from 'mongoose';

export const name = '004-provider-scope-name-index';

export async function run(): Promise<void> {
  const collection = mongoose.connection.collection('providers');

  // 旧索引 providers.name_1 为集合级唯一，改为按 scope 唯一后可 drop（不存在时忽略）
  await collection.dropIndex('name_1').catch(() => {});

  // 复合唯一索引 { scope: 1, name: 1 }；createIndex 对同规格索引幂等
  await collection.createIndex(
    { scope: 1, name: 1 },
    { unique: true, name: 'scope_1_name_1' },
  );

  console.log('[Migration 004] Ensured providers compound unique index { scope, name }');
}
