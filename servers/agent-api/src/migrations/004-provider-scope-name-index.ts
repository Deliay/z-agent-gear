import mongoose from 'mongoose';

export const name = '004-provider-scope-name-index';

export async function run(): Promise<void> {
  const collection = mongoose.connection.collection('providers');

  // 存量文档缺 scope 时补为 'user'：null 值会以 null 进入 {scope,name} 唯一索引，
  // 与 scope:'user' 新文档同名可并存，必须先回填再建索引（幂等）。
  await collection.updateMany(
    { scope: { $exists: false } },
    { $set: { scope: 'user' } },
  );

  // 先建复合唯一索引 { scope: 1, name: 1 }（createIndex 对同规格索引幂等），
  // 再删旧集合级唯一索引 providers.name_1，避免「先删后建」期间 name 无唯一约束的窗口。
  await collection.createIndex(
    { scope: 1, name: 1 },
    { unique: true, name: 'scope_1_name_1' },
  );

  // 旧索引 providers.name_1 不存在时忽略（幂等）
  await collection.dropIndex('name_1').catch(() => {});

  console.log('[Migration 004] Backfilled scope=user and ensured providers compound unique index { scope, name }');
}
