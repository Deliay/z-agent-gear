import mongoose from 'mongoose';

/**
 * 云主机 Github 项目绑定（集合 `cloud_host_github_bindings`）。
 * `controllerId` 唯一；设置批次下发前 upsert，供容器凭据管理器按 controllerId 取回本机绑定仓库。
 */
const cloudHostGithubBindingSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    controllerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Controller',
      required: true,
      unique: true,
    },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'GitHubAccount', required: true },
    repoFullName: { type: String, required: true },
    targetPath: { type: String, required: true },
  },
  { collection: 'cloud_host_github_bindings', timestamps: true },
);

export const CloudHostGithubBinding = mongoose.model(
  'CloudHostGithubBinding',
  cloudHostGithubBindingSchema,
);
export type ICloudHostGithubBinding = mongoose.InferSchemaType<
  typeof cloudHostGithubBindingSchema
>;
