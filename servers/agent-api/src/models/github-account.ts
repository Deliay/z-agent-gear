import mongoose from 'mongoose';

const githubAccountSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  githubUserId: { type: Number, required: true },
  githubLogin: { type: String, required: true },
  githubAvatarUrl: { type: String },
  accessToken: { type: String, required: true },
  tokenExpiresAt: { type: Date },
}, { timestamps: true });

githubAccountSchema.index({ userId: 1, githubUserId: 1 }, { unique: true });

export const GitHubAccount = mongoose.model('GitHubAccount', githubAccountSchema);
export type IGitHubAccount = mongoose.InferSchemaType<typeof githubAccountSchema>;
