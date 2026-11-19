import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';

/**
 * 云主机 Github 项目绑定（集合 `cloud_host_github_bindings`）。
 * 一机多项目：`{controllerId, repoFullName}` 组合唯一；设置批次下发前 upsert，
 * 供容器凭据管理器按 controllerId + 项目取回对应仓库凭据（无项目参数时回退主项目）。
 */
const cloudHostGithubBindingSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    controllerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Controller',
      required: true,
    },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'GitHubAccount', required: true },
    repoFullName: { type: String, required: true },
    targetPath: { type: String, required: true },
  },
  { collection: 'cloud_host_github_bindings', timestamps: true },
);

// 一机多项目：同一云主机下同一仓库唯一（GitHub 仓库名大小写不敏感由读取侧归一，见 D9）。
cloudHostGithubBindingSchema.index(
  { controllerId: 1, repoFullName: 1 },
  { unique: true, name: 'uniq_cloud_host_github_binding' },
);

applyTenantScope(cloudHostGithubBindingSchema);

export const CloudHostGithubBinding = mongoose.model('CloudHostGithubBinding', cloudHostGithubBindingSchema);
export type ICloudHostGithubBinding = mongoose.InferSchemaType<
  typeof cloudHostGithubBindingSchema
>;
