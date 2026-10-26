import mongoose from 'mongoose';

export const name = '010-issues-linkage-indexes';

/**
 * Issues 联动两个新集合的索引显式创建（幂等）。
 *
 * `autoIndex` 关闭的部署下模型索引会静默缺失：
 * - `cloud_host_issues_linkages` 的 `(controllerId, labelNameLower)` 唯一索引是「同云电脑标签唯一」的兜底；
 * - `issue_workflow_triggers` 的 `(controllerId, repoFullName, labelName, issueId)` 唯一索引是触发幂等闸，
 *   缺失会导致同一 Issue 重复触发工作流。
 * 失败不落迁移记录，下次启动重试。
 */
export async function run(): Promise<void> {
  const linkages = mongoose.connection.collection('cloud_host_issues_linkages');
  await linkages.createIndex(
    { controllerId: 1, labelNameLower: 1 },
    { unique: true, name: 'uniq_cloud_host_issues_linkage_label' },
  );
  await linkages.createIndex({ userId: 1 });
  await linkages.createIndex({ repoFullNames: 1 });

  const triggers = mongoose.connection.collection('issue_workflow_triggers');
  await triggers.createIndex(
    { controllerId: 1, repoFullName: 1, labelName: 1, issueId: 1 },
    { unique: true, name: 'uniq_issue_workflow_trigger' },
  );
  await triggers.createIndex({ controllerId: 1, status: 1 });
  await triggers.createIndex({ status: 1, updatedAt: -1 });

  console.log('[Migration 010] Ensured issues linkage indexes');
}
