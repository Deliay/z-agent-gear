/** 实证：tenant-scope 把显式 userId 复制为 tenantId，团队租户行（tenantId=teamId）恒不命中。 */
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/repro-tenantscope';
process.env.GITHUB_TOKEN_ENCRYPTION_KEY = '00'.repeat(32);

import mongoose from 'mongoose';

await mongoose.connect(process.env.MONGODB_URI!);
const { CloudHost } = await import('./src/models/cloud-host.js');

const db = mongoose.connection.db!;
await db.dropDatabase().catch(() => undefined);

const adminId = new mongoose.Types.ObjectId();
const teamId = new mongoose.Types.ObjectId();
const wsId = new mongoose.Types.ObjectId();
const hostId = new mongoose.Types.ObjectId();

await db.collection('cloudhosts').insertOne({
  _id: hostId,
  userId: adminId,
  tenantId: teamId,
  resourceWorkspaceId: wsId,
  workspaceId: null,
  controllerId: new mongoose.Types.ObjectId(),
  keyId: new mongoose.Types.ObjectId(),
  name: 'iso-cloud-host',
  harnessTypes: ['OPENCODE'],
  status: 'RUNNING',
  containerId: hostId.toString(),
  createDefaultSession: false,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

// 与 resolver cloudHost 完全一致的查询（请求上下文外——tenant-scope 注入与 ALS 无关）
const byResolverShape = await CloudHost.findOne({ _id: hostId, userId: adminId.toString() }).lean();
console.log('resolver 形态查询 {_id, userId} 命中:', byResolverShape ? 'YES' : 'NO (null)');

const withTenant = await CloudHost.findOne({
  _id: hostId,
  userId: adminId.toString(),
  tenantId: teamId.toString(),
}).lean();
console.log('显式 tenantId=teamId 命中:', withTenant ? 'YES' : 'NO (null)');

const raw = await db.collection('cloudhosts').findOne({ _id: hostId });
console.log('原始行存在:', raw ? 'YES' : 'NO');

console.log(
  byResolverShape === null && withTenant && raw
    ? '>>> BUG CONFIRMED: tenant-scope 把 tenantId 注成 userId，团队租户属主查询恒空'
    : '>>> 需进一步分析',
);
await mongoose.disconnect();
