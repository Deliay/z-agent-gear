import mongoose from 'mongoose';
import { applyTenantScope } from '../services/tenant-scope.js';

const githubAccountSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  tenantId: { type: String, required: true, index: true },
  githubUserId: { type: Number, required: true },
  githubLogin: { type: String, required: true },
  githubAvatarUrl: { type: String },
  accessToken: { type: String, required: true },
  tokenExpiresAt: { type: Date },
}, { timestamps: true });

// 多租户一期（F6）：唯一索引扩展为 {tenantId,userId,githubUserId}，保留 userId 维度。
githubAccountSchema.index({ tenantId: 1, userId: 1, githubUserId: 1 }, { unique: true });

applyTenantScope(githubAccountSchema);

export const GitHubAccount = mongoose.model('GitHubAccount', githubAccountSchema);
export type IGitHubAccount = mongoose.InferSchemaType<typeof githubAccountSchema>;
