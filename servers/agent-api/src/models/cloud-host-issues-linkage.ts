import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';

/**
 * 云电脑 GitHub Issues 联动配置（集合 `cloud_host_issues_linkages`）。
 *
 * 每条配置 = 一个已配置工作流 + 一个触发标签 + 一组仓库；
 * 同一控制器内标签名唯一（大小写不敏感，冗余 `labelNameLower` 参与唯一索引）。
 */
const cloudHostIssuesLinkageSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    controllerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Controller', required: true },
    configuredWorkflowId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ConfiguredWorkflow',
      required: true,
    },
    /** 工作流名称快照（配置删除后仍可读） */
    configuredWorkflowName: { type: String, required: true },
    /** 触发标签（trim 后落库） */
    labelName: { type: String, required: true },
    /** 小写归一列（唯一索引与事件匹配口径） */
    labelNameLower: { type: String, required: true },
    repoFullNames: { type: [String], default: [] },
  },
  { collection: 'cloud_host_issues_linkages', timestamps: true },
);

// 同云电脑内标签同名唯一（大小写不敏感由 labelNameLower 承担）
cloudHostIssuesLinkageSchema.index(
  { controllerId: 1, labelNameLower: 1 },
  { unique: true, name: 'uniq_cloud_host_issues_linkage_label' },
);
cloudHostIssuesLinkageSchema.index({ userId: 1 });
// 事件入口按仓库反查候选配置
cloudHostIssuesLinkageSchema.index({ repoFullNames: 1 });

/** 写入前兜底归一：标签 trim + 小写列、仓库 trim/去重/去空。 */
cloudHostIssuesLinkageSchema.pre('validate', function preValidate(
  this: { labelName?: string; labelNameLower?: string; repoFullNames?: unknown[] },
) {
  if (typeof this.labelName === 'string') {
    this.labelName = this.labelName.trim();
    this.labelNameLower = this.labelName.toLowerCase();
  }
  if (Array.isArray(this.repoFullNames)) {
    this.repoFullNames = dedupeRepoNames(this.repoFullNames);
  }
});

export const LABEL_NAME_MAX_LENGTH = 50;
export const REPO_FULL_NAMES_MAX = 50;

/** 仓库列表归一：trim、去空、去重（保留首次出现顺序）。 */
export function dedupeRepoNames(repos: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of repos) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

applyTenantScope(cloudHostIssuesLinkageSchema);

export const CloudHostIssuesLinkage = mongoose.model('CloudHostIssuesLinkage', cloudHostIssuesLinkageSchema);
export type ICloudHostIssuesLinkage = mongoose.InferSchemaType<
  typeof cloudHostIssuesLinkageSchema
>;
