import mongoose from 'mongoose';

export const name = '016-github-installation-github-user-id';

/**
 * 迁移 016：githubinstallations 补 `githubUserId`（多租户二期 GitHub 绑定共享读）。
 *
 * 同一 GitHub 账号可在多个租户工作区各有绑定行；安装数据按 `githubUserId` 共享关联，
 * 避免 handleSetup 按 installationId 单行 upsert 时把安装行“改嫁”给最新绑定。
 * - 逐行经 accountId 回填 githubUserId（缺失账户置 null）；
 * - 建 `{githubUserId:1}` 普通索引；幂等可重跑。
 */
export async function run(): Promise<void> {
  const installations = mongoose.connection.collection('githubinstallations');
  const accounts = mongoose.connection.collection('githubaccounts');
  const rows = await installations
    .find(
      {
        $or: [
          { githubUserId: { $exists: false } },
          { githubUserId: null },
        ],
      },
      { projection: { _id: 1, accountId: 1 } },
    )
    .toArray();
  for (const row of rows) {
    let githubUserId: number | null = null;
    if (row.accountId) {
      const account = await accounts.findOne(
        { _id: row.accountId },
        { projection: { githubUserId: 1 } },
      );
      githubUserId =
        typeof account?.githubUserId === 'number' ? account.githubUserId : null;
    }
    await installations.updateOne(
      { _id: row._id },
      { $set: { githubUserId } },
    );
  }
  await installations.createIndex({ githubUserId: 1 });
  console.log(`[Migration 016] githubinstallations githubUserId backfilled: ${rows.length}`);
}
