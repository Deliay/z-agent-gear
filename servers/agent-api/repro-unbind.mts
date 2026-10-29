/**
 * 复现：unbindAccount 的「存活绑定」判定被 workspace-scope 读过滤收窄，
 * 跨工作区存活绑定不可见 → 误删共享安装数据（阻断-E 残留）。
 */
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/repro-unbind';
process.env.GITHUB_APP_ID = '1';
process.env.GITHUB_APP_PRIVATE_KEY = Buffer.from('dummy').toString('base64');
process.env.GITHUB_TOKEN_ENCRYPTION_KEY = '00'.repeat(32);

import mongoose from 'mongoose';

await mongoose.connect(process.env.MONGODB_URI!);
const { githubService } = await import('./src/services/github.js');
const { runWithWorkspace } = await import('./src/services/workspace-context.js');

const db = mongoose.connection.db!;
await db.dropDatabase().catch(() => undefined);

const GLOBAL_WS = '666000000000000000000001';
const NORMAL_WS = '666000000000000000000002';
const TENANT = '666000000000000000000003';

const accGlobal = new mongoose.Types.ObjectId();
const accNormal = new mongoose.Types.ObjectId();

await db.collection('githubaccounts').insertOne({
  _id: accGlobal, userId: 'user-admin', tenantId: TENANT, workspaceId: GLOBAL_WS,
  githubUserId: 4242, githubLogin: 'octo', githubAvatarUrl: null,
  accessToken: 'enc', tokenExpiresAt: null, createdAt: new Date(), updatedAt: new Date(),
});
// 普通工作区绑定行（同一 GitHub 账号，PRD 82/84 行允许）
await db.collection('githubaccounts').insertOne({
  _id: accNormal, userId: 'user-dev', tenantId: TENANT, workspaceId: NORMAL_WS,
  githubUserId: 4242, githubLogin: 'octo', githubAvatarUrl: null,
  accessToken: 'enc', tokenExpiresAt: null, createdAt: new Date(), updatedAt: new Date(),
});
// 共享安装数据
await db.collection('githubinstallations').insertOne({
  accountId: accGlobal, githubUserId: 4242, installationId: 777,
  accountLogin: 'octo', accountType: 'User',
  repos: [{ repoId: 1, repoName: 'r', fullName: 'o/r', private: false, permissions: { read: true, write: true } }],
  createdAt: new Date(), updatedAt: new Date(),
});

const globalCtx = {
  id: GLOBAL_WS, tenantId: TENANT, type: 'global' as const,
  role: 'admin' as const, readOnly: false, globalWorkspaceId: GLOBAL_WS,
};

let result: unknown;
try {
  result = await runWithWorkspace(globalCtx, () =>
    githubService.unbindAccount('user-admin', accGlobal.toString()),
  );
} catch (err) {
  result = `THROW: ${(err as Error).message}`;
}

const instLeft = await db.collection('githubinstallations').countDocuments({ githubUserId: 4242 });
const normalAccLeft = await db.collection('githubaccounts').countDocuments({ _id: accNormal });

console.log('unbind result:', result);
console.log('installations left (expect 1 if correct, 0 if bug):', instLeft);
console.log('normal-ws binding row left:', normalAccLeft);
console.log(
  instLeft === 0
    ? '>>> BUG CONFIRMED: 存活的 normal-ws 绑定被连带清空安装数据（阻断-E 同类数据破坏）'
    : '>>> OK: 安装数据保留',
);
await mongoose.disconnect();
