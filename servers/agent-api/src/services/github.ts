import { config } from '../config/index.js';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { GitHubAccount } from '../models/github-account.js';
import { GitHubInstallation } from '../models/github-installation.js';

export interface GitHubRepoInfo {
  repoId: number;
  repoName: string;
  fullName: string;
  private: boolean;
  permissions: { read: boolean; write: boolean };
}

export interface GitHubInstallationInfo {
  id: string;
  installationId: number;
  managementUrl: string;
  createdAt: string;
  repos: GitHubRepoInfo[];
}

export interface GitHubAccountInfo {
  id: string;
  githubUserId: number;
  githubLogin: string;
  githubAvatarUrl?: string;
  createdAt: string;
  installations: GitHubInstallationInfo[];
}

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

/** Issues 联动同步标签的固定颜色与描述（用于识别平台同步过的标签） */
export const ISSUES_LINKAGE_LABEL_COLOR = '0e8a16';
export const ISSUES_LINKAGE_LABEL_DESCRIPTION = '由 z-agent-gear 云电脑 Issues 联动同步';

const GITHUB_API = 'https://api.github.com';

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
      githubAvatarUrl: account.githubAvatarUrl ?? undefined,
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
            permissions: { read: r.permissions?.read ?? false, write: r.permissions?.write ?? false },
          })),
        })),
    }));
  }

  async unbindAccount(userId: string, accountId: string): Promise<boolean> {
    const account = await GitHubAccount.findOne({ _id: accountId, userId });
    if (!account) return false;

    const installations = await GitHubInstallation.find({ accountId: account._id });
    for (const inst of installations) {
      try {
        await this.uninstallApp(inst.installationId);
      } catch {
        // ignore uninstall failure — clean up local data regardless
      }
    }

    await GitHubInstallation.deleteMany({ accountId: account._id });
    await GitHubAccount.deleteOne({ _id: accountId, userId });
    return true;
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

  async handleSetupUpdate(installationId: number): Promise<void> {
    const installation = await GitHubInstallation.findOne({ installationId });
    if (!installation) return;

    const tokenResponse = await this.getInstallationToken(installationId);
    const repos = await this.getRepositories(tokenResponse.token);

    installation.repos = repos.map(r => ({
      repoId: r.id,
      repoName: r.name,
      fullName: r.full_name,
      private: r.private,
      permissions: {
        read: r.permissions.pull || r.permissions.push || r.permissions.admin,
        write: r.permissions.push || r.permissions.admin,
      },
    })) as any;
    await installation.save();
  }

  /**
   * 签发仅对目标仓库有效的 installation token，权限与 App 安装授权保持一致：
   * actions / contents / deployments / environments / issues / pull_requests / workflows 均为 write。
   * 错误信息不含 GitHub 响应体，避免泄露凭据/内部细节。
   */
  async createRepoScopedToken(
    accountId: string,
    repoFullName: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const account = await GitHubAccount.findById(accountId).lean();
    if (!account) throw new Error('account not found');

    const installations = await GitHubInstallation.find({ accountId: account._id }).lean();
    const match = installations.find((installation) =>
      (installation.repos ?? []).some(
        (repo) => repo.fullName.toLowerCase() === repoFullName.toLowerCase(),
      ),
    );
    if (!match) throw new Error('repository is not authorized');

    const repoName = repoFullName.split('/').pop();
    if (!repoName) throw new Error('repository is not authorized');

    const appJwt = this.createAppJwt();
    const response = await fetch(
      `https://api.github.com/app/installations/${match.installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${appJwt}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          repositories: [repoName],
          permissions: {
            actions: 'write',
            contents: 'write',
            deployments: 'write',
            environments: 'write',
            issues: 'write',
            pull_requests: 'write',
            workflows: 'write',
          },
        }),
      },
    );
    if (!response.ok) throw new Error('failed to issue github token');
    const data = (await response.json()) as { token?: string; expires_at?: string };
    if (!data.token || !data.expires_at) throw new Error('failed to issue github token');
    return { token: data.token, expiresAt: new Date(data.expires_at) };
  }

  /** 确保仓库存在同名标签（存在即返回；并发创建 422 视为幂等成功）。 */
  async ensureIssueLabel(userId: string, repoFullName: string, name: string): Promise<void> {
    const token = await this.repoToken(userId, repoFullName);
    const base = `${GITHUB_API}/repos/${repoFullName}/labels`;
    const existing = await fetch(`${base}/${encodeURIComponent(name)}`, {
      headers: this.githubHeaders(token),
    });
    if (existing.ok) return;
    if (existing.status !== 404) throw new Error(`label sync failed: ${repoFullName}`);

    const created = await fetch(base, {
      method: 'POST',
      headers: this.githubHeaders(token),
      body: JSON.stringify({
        name,
        color: ISSUES_LINKAGE_LABEL_COLOR,
        description: ISSUES_LINKAGE_LABEL_DESCRIPTION,
      }),
    });
    if (created.ok || created.status === 422) return;
    throw new Error(`label sync failed: ${repoFullName}`);
  }

  /** 删除仓库同名标签（404 视为成功）。 */
  async deleteIssueLabel(userId: string, repoFullName: string, name: string): Promise<void> {
    const token = await this.repoToken(userId, repoFullName);
    const response = await fetch(
      `${GITHUB_API}/repos/${repoFullName}/labels/${encodeURIComponent(name)}`,
      { method: 'DELETE', headers: this.githubHeaders(token) },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`label delete failed: ${repoFullName}`);
    }
  }

  /** 发布 Issue 评论，返回 comment id。 */
  async createIssueComment(
    userId: string,
    repoFullName: string,
    issueNumber: number,
    body: string,
  ): Promise<number> {
    const token = await this.repoToken(userId, repoFullName);
    const response = await fetch(
      `${GITHUB_API}/repos/${repoFullName}/issues/${issueNumber}/comments`,
      {
        method: 'POST',
        headers: this.githubHeaders(token),
        body: JSON.stringify({ body }),
      },
    );
    if (!response.ok) throw new Error(`issue comment failed: ${repoFullName}`);
    const data = (await response.json()) as { id?: number };
    if (typeof data.id !== 'number') throw new Error(`issue comment failed: ${repoFullName}`);
    return data.id;
  }

  /** 解析仓库归属账号（`GitHubInstallation.repos[].fullName` 大小写不敏感反查，多匹配取首个）。 */
  async resolveRepoAccount(userId: string, repoFullName: string): Promise<string> {
    const target = repoFullName.trim().toLowerCase();
    const accounts = await GitHubAccount.find({ userId }).sort({ createdAt: 1 }).lean();
    for (const account of accounts) {
      const installations = await GitHubInstallation.find({ accountId: account._id }).lean();
      const matched = installations.some((installation) =>
        (installation.repos ?? []).some((repo) => repo.fullName.toLowerCase() === target),
      );
      if (matched) return account._id.toString();
    }
    throw new Error(`repo not authorized: ${repoFullName}`);
  }

  private githubHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    };
  }

  private async repoToken(userId: string, repoFullName: string): Promise<string> {
    const accountId = await this.resolveRepoAccount(userId, repoFullName);
    const { token } = await this.createRepoScopedToken(accountId, repoFullName);
    return token;
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

  private async uninstallApp(installationId: number): Promise<void> {
    const appJwt = this.createAppJwt();
    const response = await fetch(
      `https://api.github.com/app/installations/${installationId}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${appJwt}`,
          Accept: 'application/vnd.github+json',
        },
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to uninstall app: ${response.status}`);
    }
  }
}

export const githubService = new GitHubService();
