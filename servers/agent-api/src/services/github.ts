import { config } from '../config/index.js';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { GitHubAccount } from '../models/github-account.js';
import { GitHubInstallation } from '../models/github-installation.js';

interface GitHubRepoInfo {
  repoId: number;
  repoName: string;
  fullName: string;
  private: boolean;
  permissions: { read: boolean; write: boolean };
}

interface GitHubInstallationInfo {
  id: string;
  installationId: number;
  managementUrl: string;
  createdAt: string;
  repos: GitHubRepoInfo[];
}

interface GitHubAccountInfo {
  id: string;
  githubUserId: number;
  githubLogin: string;
  githubAvatarUrl?: string;
  createdAt: string;
  installations: GitHubInstallationInfo[];
}

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

function encrypt(text: string): string {
  const key = Buffer.from(config.githubTokenEncryptionKey, 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decrypt(encryptedText: string): string {
  const key = Buffer.from(config.githubTokenEncryptionKey, 'hex');
  const [ivHex, authTagHex, encrypted] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export class GitHubService {
  async getAppUrl(userId: string): Promise<{ url: string; state: string }> {
    const state = crypto.randomUUID();
    const baseUrl = config.githubAppUrl || `https://github.com/apps/${config.githubAppId}`;
    const url = `${baseUrl}/installations/new?state=${state}`;
    return { url, state };
  }

  async handleSetup(params: { installationId: number; state: string; userId: string }): Promise<void> {
    const tokenResponse = await this.getInstallationToken(params.installationId);
    const accountInfo = await this.getInstallationAccount(params.installationId);
    const repos = await this.getRepositories(tokenResponse.token);

    const encryptedToken = encrypt(tokenResponse.token);
    const account = await GitHubAccount.findOneAndUpdate(
      { userId: params.userId, githubUserId: accountInfo.id },
      {
        userId: params.userId,
        githubUserId: accountInfo.id,
        githubLogin: accountInfo.login,
        githubAvatarUrl: accountInfo.avatar_url,
        accessToken: encryptedToken,
        tokenExpiresAt: tokenResponse.expiresAt,
      },
      { upsert: true, new: true },
    );

    await GitHubInstallation.findOneAndUpdate(
      { installationId: params.installationId },
      {
        accountId: account._id,
        installationId: params.installationId,
        accountLogin: accountInfo.login,
        accountType: accountInfo.type,
        repos: repos.map(r => ({
          repoId: r.id,
          repoName: r.name,
          fullName: r.full_name,
          private: r.private,
          permissions: {
            read: r.permissions.pull || r.permissions.push || r.permissions.admin,
            write: r.permissions.push || r.permissions.admin,
          },
        })),
      },
      { upsert: true, new: true },
    ).lean();
  }

  async getAccounts(userId: string): Promise<GitHubAccountInfo[]> {
    const accounts = await GitHubAccount.find({ userId }).lean();
    const installations = await GitHubInstallation.find({
      accountId: { $in: accounts.map(a => a._id) },
    }).lean();

    return accounts.map(account => ({
      id: account._id.toString(),
      githubUserId: account.githubUserId,
      githubLogin: account.githubLogin,
      githubAvatarUrl: account.githubAvatarUrl,
      createdAt: account.createdAt instanceof Date ? account.createdAt.toISOString() : String(account.createdAt),
      installations: installations
        .filter(i => i.accountId.toString() === account._id.toString())
        .map(i => ({
          id: i._id.toString(),
          installationId: i.installationId,
          managementUrl: i.accountType === 'Organization'
            ? `https://github.com/organizations/${i.accountLogin}/settings/installations/${i.installationId}`
            : `https://github.com/settings/installations/${i.installationId}`,
          createdAt: i.createdAt instanceof Date ? i.createdAt.toISOString() : String(i.createdAt),
          repos: (i.repos || []).map(r => ({
            id: String(r.repoId),
            repoId: r.repoId,
            repoName: r.repoName,
            fullName: r.fullName,
            private: r.private,
            permissions: { read: r.permissions.read, write: r.permissions.write },
          })),
        })),
    }));
  }

  async unbindAccount(userId: string, accountId: string): Promise<boolean> {
    const account = await GitHubAccount.findOneAndDelete({ _id: accountId, userId });
    if (account) {
      await GitHubInstallation.deleteMany({ accountId: account._id });
      return true;
    }
    return false;
  }

  async refreshInstallations(userId: string, accountId: string): Promise<GitHubAccountInfo | undefined> {
    const account = await GitHubAccount.findOne({ _id: accountId, userId });
    if (!account) throw new Error('Account not found');

    const token = decrypt(account.accessToken);
    const repos = await this.getRepositories(token);

    const installations = await GitHubInstallation.find({ accountId: account._id });
    for (const inst of installations) {
      inst.repos = repos.map(r => ({
        repoId: r.id,
        repoName: r.name,
        fullName: r.full_name,
        private: r.private,
        permissions: {
          read: r.permissions.pull || r.permissions.push || r.permissions.admin,
          write: r.permissions.push || r.permissions.admin,
        },
      })) as any;
      await inst.save();
    }

    const accounts = await this.getAccounts(userId);
    return accounts.find(a => a.id === accountId);
  }

  private async getInstallationToken(installationId: number): Promise<{ token: string; expiresAt: Date }> {
    const appJwt = this.createAppJwt();
    const response = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${appJwt}`,
          Accept: 'application/vnd.github+json',
        },
      },
    );
    if (!response.ok) throw new Error(`Failed to get installation token: ${response.status}`);
    const data = await response.json() as any;
    return { token: data.token, expiresAt: new Date(data.expires_at) };
  }

  private createAppJwt(): string {
    const privateKey = config.githubAppPrivateKey;
    if (!privateKey) {
      throw new Error('GitHub App private key is not configured');
    }
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iat: now - 60,
      exp: now + 600,
      iss: config.githubAppId,
    };
    return jwt.sign(payload, privateKey, { algorithm: 'RS256' });
  }

  private async getInstallationAccount(installationId: number): Promise<{ id: number; login: string; avatar_url: string; type: 'User' | 'Organization' }> {
    const appJwt = this.createAppJwt();
    const response = await fetch(
      `https://api.github.com/app/installations/${installationId}`,
      {
        headers: {
          Authorization: `Bearer ${appJwt}`,
          Accept: 'application/vnd.github+json',
        },
      },
    );
    if (!response.ok) throw new Error('Failed to get installation account info');
    const data = await response.json() as any;
    return data.account;
  }

  private async getRepositories(token: string): Promise<any[]> {
    const response = await fetch('https://api.github.com/installation/repositories', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error('Failed to get repositories');
    const data = await response.json() as any;
    return data.repositories;
  }
}

export const githubService = new GitHubService();
