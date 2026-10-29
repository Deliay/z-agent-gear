import mongoose from 'mongoose';

const gitHubRepoSchema = new mongoose.Schema({
  repoId: { type: Number, required: true },
  repoName: { type: String, required: true },
  fullName: { type: String, required: true },
  private: { type: Boolean, required: true },
  permissions: {
    read: { type: Boolean, required: true },
    write: { type: Boolean, required: true },
  },
}, { _id: false });

const githubInstallationSchema = new mongoose.Schema({
  // accountId 语义：任一存活绑定行（多工作区共享时指向最新/存活绑定；读路径按 githubUserId 关联）
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'GitHubAccount', required: true, index: true },
  // 多租户二期：GitHub 用户 id（同一账号可在多个工作区各有绑定行；安装数据按 githubUserId 共享读取）
  githubUserId: { type: Number, default: null, index: true },
  installationId: { type: Number, required: true, unique: true },
  accountLogin: { type: String, required: true },
  accountType: { type: String, enum: ['User', 'Organization'], required: true },
  repos: [gitHubRepoSchema],
}, { timestamps: true });

export const GitHubInstallation = mongoose.model('GitHubInstallation', githubInstallationSchema);
export type IGitHubInstallation = mongoose.InferSchemaType<typeof githubInstallationSchema>;
