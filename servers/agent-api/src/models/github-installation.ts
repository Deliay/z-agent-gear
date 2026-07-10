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
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'GitHubAccount', required: true, index: true },
  installationId: { type: Number, required: true, unique: true },
  repos: [gitHubRepoSchema],
}, { timestamps: true });

export const GitHubInstallation = mongoose.model('GitHubInstallation', githubInstallationSchema);
export type IGitHubInstallation = mongoose.InferSchemaType<typeof githubInstallationSchema>;
