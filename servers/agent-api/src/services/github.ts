import { config } from '../config/index.js';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { GitHubAccount } from '../models/github-account.js';
import { GitHubInstallation } from '../models/github-installation.js';
import { User } from '../models/user.js';
import { Workspace } from '../models/workspace.js';
import { TenantMember } from '../models/tenant-member.js';
import { WorkspaceMember } from '../models/workspace-member.js';
import { actorFilter, getWorkspaceContext, WORKSPACE_READ_ONLY_MESSAGE } from './workspace-context.js';
import { getRedisClient } from '../middleware/redis.js';

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
  /** 所属租户工作区 id（多租户二期） */
  workspaceId?: string;
  createdAt: string;
  installations: GitHubInstallationInfo[];
}

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

/** Issues 联动同步标签的固定颜色与描述（用于识别平台同步过的标签） */
export const ISSUES_LINKAGE_LABEL_COLOR = '0e8a16';
export const ISSUES_LINKAGE_LABEL_DESCRIPTION = '由 z-agent-gear 云电脑 Issues 联动同步';

const GITHUB_API = 'https://api.github.com';

/** 仓库级 installation token 进程内缓存（不落库、不写日志；到期前 5 分钟作废） */
interface RepoTokenCacheEntry {
  token: string;
  expiresAt: Date;
}
const repoTokenCache = new Map<string, RepoTokenCacheEntry>();
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/** 测试用：清空 token 缓存（生产代码不调用） */
export function resetRepoTokenCache(): void {
  repoTokenCache.clear();
}

function tokenCacheKey(accountId: string, repoFullName: string): string {
  return `${accountId}:${repoFullName.toLowerCase()}`;
}

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

  /**
   * 解析 OAuth 绑定落点（多租户二期）：state 携带发起绑定的工作区；
   * 校验租户成员资格与 normal 工作区成员资格，全局工作区 + developer 拒绝（只读红线）。
   * 缺失 workspaceId（一期旧 state）回退个人租户全局工作区。
   */
  private async resolveSetupWorkspace(
    userId: string,
    workspaceId?: string,
  ): Promise<{ workspaceId: string; tenantId: string }> {
    if (!workspaceId) {
      const user = await User.findById(userId).select('tenantId').lean();
      const tenantId = user?.tenantId ? String(user.tenantId) : userId;
      const global = await Workspace.findOne({ tenantId, type: 'global' }).select('_id').lean();
      return { workspaceId: global ? String(global._id) : '', tenantId };
    }
    if (!mongoose.isValidObjectId(workspaceId)) throw new Error('workspace not found');
    const workspace = await Workspace.findById(workspaceId).lean();
    if (!workspace) throw new Error('workspace not found');
    const tenantId = String(workspace.tenantId);
    const membership = await TenantMember.findOne({ tenantId, userId }).lean();
    if (!membership) throw new Error('workspace not found');
    const role = membership.role === 'admin' ? 'admin' : 'developer';
    const type = workspace.type === 'global' ? 'global' : 'normal';
    if (type === 'global' && role === 'developer') {
      throw new Error(WORKSPACE_READ_ONLY_MESSAGE);
    }
    if (type === 'normal' && role !== 'admin') {
      const join = await WorkspaceMember.findOne({ workspaceId: workspace._id, userId }).lean();
      if (!join) throw new Error('workspace not found');
    }
    return { workspaceId: String(workspace._id), tenantId };
  }

  async handleSetup(params: {
    installationId: number;
    state: string;
    userId: string;
    workspaceId?: string;
  }): Promise<void> {
    const tokenResponse = await this.getInstallationToken(params.installationId);
    const accountInfo = await this.getInstallationAccount(params.installationId);
    const repos = await this.getRepositories(tokenResponse.token);
    const { workspaceId, tenantId } = await this.resolveSetupWorkspace(
      params.userId,
      params.workspaceId,
    );

    const encryptedToken = encrypt(tokenResponse.token);
    // 阻断-F：upsert 键与唯一索引 {tenantId,workspaceId,githubUserId} 对齐；userId 仅首次落创建者
    const accountFilter = {
      // githubaccounts.tenantId/workspaceId 为 String 口径（F8）
      tenantId,
      workspaceId,
      githubUserId: accountInfo.id,
    };
    let account;
    try {
      account = await GitHubAccount.findOneAndUpdate(
        accountFilter,
        {
          $set: {
            tenantId,
            workspaceId,
            githubUserId: accountInfo.id,
            githubLogin: accountInfo.login,
            githubAvatarUrl: accountInfo.avatar_url,
            accessToken: encryptedToken,
            tokenExpiresAt: tokenResponse.expiresAt,
          },
          $setOnInsert: { userId: params.userId },
        },
        { upsert: true, returnDocument: 'after' },
      );
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        account = await GitHubAccount.findOneAndUpdate(
          accountFilter,
          {
            $set: {
              githubLogin: accountInfo.login,
              githubAvatarUrl: accountInfo.avatar_url,
              accessToken: encryptedToken,
              tokenExpiresAt: tokenResponse.expiresAt,
            },
          },
          { returnDocument: 'after' },
        );
      } else {
        throw err;
      }
    }
    if (!account) throw new Error('account not found');

    await GitHubInstallation.findOneAndUpdate(
      { installationId: params.installationId },
      {
        accountId: (account as unknown as { _id: unknown })._id,
        githubUserId: accountInfo.id,
        installationId: params.installationId,
        accountLogin: accountInfo.login,
        accountType: accountInfo.type,
        repos: repos.map((r: Record<string, any>) => ({
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
      { upsert: true, returnDocument: 'after' },
    ).lean();
  }

  /** 同一 GitHub 用户在各工作区的绑定共享同一份安装数据（按 githubUserId 关联；旧行按 accountId 兜底）。 */
  private async installationsForAccount(account: {
    _id: unknown;
    githubUserId: number;
  }): Promise<Array<Record<string, any>>> {
    const accountRef = mongoose.isValidObjectId(account._id)
      ? new mongoose.Types.ObjectId(String(account._id))
      : account._id;
    const query = GitHubInstallation.find({
      $or: [
        { githubUserId: account.githubUserId },
        { accountId: accountRef as never },
      ],
    }) as unknown as { lean?: () => Promise<unknown> };
    const rows = (typeof query.lean === 'function'
      ? await query.lean()
      : await (query as unknown as Promise<unknown>)) as Array<Record<string, any>>;
    // 旧行补齐 githubUserId（幂等）
    const legacyIds = rows
      .filter((row) => row.githubUserId === null || row.githubUserId === undefined)
      .map((row) => row._id);
    if (legacyIds.length > 0) {
      await GitHubInstallation.updateMany(
        { _id: { $in: legacyIds } },
        { $set: { githubUserId: account.githubUserId } },
      );
      for (const row of rows) {
        if (row.githubUserId === null || row.githubUserId === undefined) {
          row.githubUserId = account.githubUserId;
        }
      }
    }
    return rows.filter(
      (row) =>
        row.githubUserId === account.githubUserId ||
        String(row.accountId) === String(account._id),
    );
  }

  async getAccounts(userId: string): Promise<GitHubAccountInfo[]> {
    const accounts = await GitHubAccount.find(actorFilter(userId)).lean();
    const installationsByUser = new Map<number, Array<Record<string, any>>>();
    for (const account of accounts) {
      if (!installationsByUser.has(account.githubUserId)) {
        installationsByUser.set(
          account.githubUserId,
          await this.installationsForAccount(account as { _id: unknown; githubUserId: number }),
        );
      }
    }

    return accounts.map(account => ({
      id: account._id.toString(),
      githubUserId: account.githubUserId,
      githubLogin: account.githubLogin,
      githubAvatarUrl: account.githubAvatarUrl ?? undefined,
      workspaceId: account.workspaceId ? String(account.workspaceId) : '',
      createdAt: account.createdAt instanceof Date ? account.createdAt.toISOString() : String(account.createdAt),
      installations: (installationsByUser.get(account.githubUserId) ?? [])
        .map(i => ({
          id: i._id.toString(),
          installationId: i.installationId,
          managementUrl: i.accountType === 'Organization'
            ? `https://github.com/organizations/${i.accountLogin}/settings/installations/${i.installationId}`
            : `https://github.com/settings/installations/${i.installationId}`,
          createdAt: i.createdAt instanceof Date ? i.createdAt.toISOString() : String(i.createdAt),
          repos: (i.repos || []).map((r: Record<string, any>) => ({
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

  /**
   * 同账号的其它工作区/租户绑定行（阻断-I）：必须绕过 workspace-scope 读过滤，
   * 否则「最后一个绑定」判定会被当前可见集收窄而误删共享安装数据。
   * 单测无 DB 连接时回退普通查询（mock 友好）。
   */
  private async findSurvivingBindings(account: {
    _id: unknown;
    githubUserId: number;
  }): Promise<Array<{ _id: unknown }>> {
    const db = mongoose.connection.db;
    if (!db) {
      return (await GitHubAccount.find({
        githubUserId: account.githubUserId,
        _id: { $ne: account._id },
      })
        .select('_id')
        .lean()) as Array<{ _id: unknown }>;
    }
    return (await db
      .collection('githubaccounts')
      .find({ githubUserId: account.githubUserId, _id: { $ne: account._id as never } })
      .project({ _id: 1 })
      .toArray()) as Array<{ _id: unknown }>;
  }

  async unbindAccount(userId: string, accountId: string): Promise<boolean> {
    const account = await GitHubAccount.findOne({ _id: accountId, ...actorFilter(userId) });
    if (!account) return false;

    // 多租户二期：共享读可能命中全局/他人工作区行；写（解绑）仅允许当前工作区自身行，
    // 越界统一 Not found（在删除安装数据之前校验，避免“假成功 + 半删除”）。
    const context = getWorkspaceContext();
    if (context?.readOnly) throw new Error(WORKSPACE_READ_ONLY_MESSAGE);
    if (context && String(account.workspaceId ?? '') !== context.id) {
      throw new Error('workspace not found');
    }

    const installations = await this.installationsForAccount(
      account as unknown as { _id: unknown; githubUserId: number },
    );
    // 同一 GitHub 账号可能在其他工作区仍有绑定行：只有最后一个绑定才卸载 App 并清理安装数据，
    // 否则把安装行 accountId 改指存活绑定（避免“改嫁”与误删）。
    const survivors = await this.findSurvivingBindings(account as unknown as {
      _id: unknown;
      githubUserId: number;
    });
    if (survivors.length === 0) {
      for (const inst of installations) {
        try {
          await this.uninstallApp(Number(inst.installationId));
        } catch {
          // ignore uninstall failure — clean up local data regardless
        }
      }
      await GitHubInstallation.deleteMany({ githubUserId: account.githubUserId });
    } else if (installations.length > 0) {
      await GitHubInstallation.updateMany(
        { githubUserId: account.githubUserId },
        { $set: { accountId: survivors[0]._id } },
      );
    }

    await GitHubAccount.deleteOne({ _id: accountId, ...actorFilter(userId) });
    return true;
  }

  async refreshInstallations(userId: string, accountId: string): Promise<GitHubAccountInfo | undefined> {
    const account = await GitHubAccount.findOne({ _id: accountId, ...actorFilter(userId) });
    if (!account) throw new Error('Account not found');

    // 阻断-G：刷新写安装数据属于写操作，与 unbind 同款前置校验（只读/越界）
    const context = getWorkspaceContext();
    if (context?.readOnly) throw new Error(WORKSPACE_READ_ONLY_MESSAGE);
    if (context && String(account.workspaceId ?? '') !== context.id) {
      throw new Error('workspace not found');
    }

    const token = decrypt(account.accessToken);
    const repos = await this.getRepositories(token);

    const installations = await this.installationsForAccount(
      account as unknown as { _id: unknown; githubUserId: number },
    );
    for (const inst of installations) {
      const doc = await GitHubInstallation.findById(inst._id);
      if (!doc) continue;
      doc.repos = repos.map((r: Record<string, any>) => ({
        repoId: r.id,
        repoName: r.name,
        fullName: r.full_name,
        private: r.private,
        permissions: {
          read: r.permissions.pull || r.permissions.push || r.permissions.admin,
          write: r.permissions.push || r.permissions.admin,
        },
      })) as any;
      await doc.save();
    }

    const accounts = await this.getAccounts(userId);
    return accounts.find(a => a.id === accountId);
  }

  async handleSetupUpdate(installationId: number): Promise<void> {
    const installation = await GitHubInstallation.findOne({ installationId });
    if (!installation) return;

    const tokenResponse = await this.getInstallationToken(installationId);
    const repos = await this.getRepositories(tokenResponse.token);

    installation.repos = repos.map((r: Record<string, any>) => ({
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
   * actions / contents / checks / deployments / environments / issues / pull_requests / workflows 均为 write。
   * 错误信息不含 GitHub 响应体，避免泄露凭据/内部细节。
   * 进程内缓存复用：命中要求剩余有效期 > `options.minRemainingMs`（缺省 5 分钟，保持 Check Runs 等
   * 既有调用方行为）；容器凭据端点传 55 分钟（`CONTAINER_CREDENTIAL_MIN_REMAINING_MS`），
   * 避免 50 分钟续期拿到只剩 10 分钟的近过期 token。
   */
  async createRepoScopedToken(
    accountId: string,
    repoFullName: string,
    options?: { minRemainingMs?: number },
  ): Promise<{ token: string; expiresAt: Date }> {
    const account = await GitHubAccount.findById(accountId).lean();
    if (!account) throw new Error('account not found');

    const cached = this.readCachedToken(
      String(account._id),
      repoFullName,
      options?.minRemainingMs,
    );
    if (cached) return cached;

    const installations = await this.installationsForAccount(account as unknown as { _id: unknown; githubUserId: number });
    const match = installations.find((installation) =>
      (installation.repos ?? []).some(
        (repo: { fullName: string }) => repo.fullName.toLowerCase() === repoFullName.toLowerCase(),
      ),
    );
    if (!match) throw new Error('repository is not authorized');

    return this.mintRepoToken(String(account._id), match.installationId, repoFullName);
  }

  /**
   * 按用户解析仓库级 token：遍历该用户绑定的 GitHub 帐号，首个授权目标仓库的安装胜出。
   * 供 Check Runs 同步链路使用（用户会话只携带 userId，不携带账号 ID）。
   */
  async createRepoScopedTokenForUser(
    userId: string,
    repoFullName: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const accounts = await GitHubAccount.find(actorFilter(userId)).lean();
    for (const account of accounts) {
      const accountId = String(account._id);
      const cached = this.readCachedToken(accountId, repoFullName);
      if (cached) return cached;

      const installations = await this.installationsForAccount(account as unknown as { _id: unknown; githubUserId: number });
      const match = installations.find((installation) =>
        (installation.repos ?? []).some(
          (repo: { fullName: string }) => repo.fullName.toLowerCase() === repoFullName.toLowerCase(),
        ),
      );
      if (match) {
        return this.mintRepoToken(accountId, match.installationId, repoFullName);
      }
    }
    throw new Error('repository is not authorized');
  }

  /**
   * 读缓存：先按硬余量（5 分钟）作废，再按调用方要求的 `minRemainingMs` 判定命中。
   * 未达调用方要求但仍在硬余量之上时**只 miss 不删除**——小余量调用方（Check Runs 等）仍可复用，
   * 需要更长余量的调用方（容器 50 分钟续期）自行重新签发。
   */
  private readCachedToken(
    accountId: string,
    repoFullName: string,
    minRemainingMs: number = TOKEN_EXPIRY_MARGIN_MS,
  ): { token: string; expiresAt: Date } | null {
    const key = tokenCacheKey(accountId, repoFullName);
    const entry = repoTokenCache.get(key);
    if (!entry) return null;
    const remainingMs = entry.expiresAt.getTime() - Date.now();
    if (remainingMs <= TOKEN_EXPIRY_MARGIN_MS) {
      repoTokenCache.delete(key);
      return null;
    }
    if (remainingMs <= minRemainingMs) return null;
    return { token: entry.token, expiresAt: entry.expiresAt };
  }

  private async mintRepoToken(
    accountId: string,
    installationId: number,
    repoFullName: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const repoName = repoFullName.split('/').pop();
    if (!repoName) throw new Error('repository is not authorized');

    const appJwt = this.createAppJwt();
    const response = await fetch(
      `${config.githubApiBaseUrl || 'https://api.github.com'}/app/installations/${installationId}/access_tokens`,
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
            checks: 'write',
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
    const issued = { token: data.token, expiresAt: new Date(data.expires_at) };
    repoTokenCache.set(tokenCacheKey(accountId, repoFullName), issued);
    return issued;
  }

  /** 读取仓库默认分支（GitHub API）；任何失败（未授权/404/网络）返回 null，由候选探测兜底。 */
  async getRepoDefaultBranch(userId: string, repoFullName: string): Promise<string | null> {
    try {
      const token = await this.repoToken(userId, repoFullName);
      const response = await fetch(`${GITHUB_API}/repos/${repoFullName}`, {
        headers: this.githubHeaders(token),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as { default_branch?: unknown };
      return typeof data.default_branch === 'string' && data.default_branch
        ? data.default_branch
        : null;
    } catch {
      return null;
    }
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
    const accounts = await GitHubAccount.find(actorFilter(userId)).sort({ createdAt: 1 }).lean();
    for (const account of accounts) {
      const installations = await this.installationsForAccount(account as unknown as { _id: unknown; githubUserId: number });
      const matched = installations.some((installation) =>
        (installation.repos ?? []).some((repo: { fullName: string }) => repo.fullName.toLowerCase() === target),
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

  /**
   * 解析 GitHub App bot 身份（提交身份来源）。
   *
   * `createAppJwt()` → `GET /app` 取 `slug` → `GET /users/{slug}[bot]` 取 `id`；
   * 组装 `{ slug, botUserId, name, email }`，邮箱固定为 GitHub noreply 形式。
   *
   * 缓存：Redis `github:app-bot-identity` 成功 TTL 24h、失败 sentinel 60s（防击穿），
   * 进程内 Map 同口径兜底。任何异常一律返回 `null`（调用方按 `unset` 降级），
   * 告警不含 JWT / slug 以外的敏感信息。
   */
  async resolveAppBotIdentity(): Promise<AppBotIdentity | null> {
    const cached = readBotIdentityMemory();
    if (cached !== undefined) return cached;

    const redis = safeRedis();
    if (redis) {
      try {
        const raw = await redis.get(APP_BOT_IDENTITY_CACHE_KEY);
        if (raw === APP_BOT_IDENTITY_FAIL_SENTINEL) {
          writeBotIdentityMemory(null, Date.now() + APP_BOT_IDENTITY_FAIL_TTL_MS);
          return null;
        }
        if (raw) {
          const parsed = parseBotIdentity(raw);
          if (parsed) {
            writeBotIdentityMemory(parsed, Date.now() + APP_BOT_IDENTITY_TTL_MS);
            return parsed;
          }
        }
      } catch {
        // Redis 不可用：继续走外部解析（内存兜底仍然生效）。
      }
    }

    try {
      const identity = await this.fetchAppBotIdentity();
      await writeBotIdentityCache(identity);
      return identity;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      // 只记录状态 / 结构错误，绝不记录 JWT 或身份之外的响应内容。
      console.warn(`[GitHub] app bot identity unavailable: ${reason}`);
      await writeBotIdentityCache(null);
      return null;
    }
  }

  private async fetchAppBotIdentity(): Promise<AppBotIdentity> {
    const appJwt = this.createAppJwt();
    const base = config.githubApiBaseUrl || GITHUB_API;
    const headers = {
      Authorization: `Bearer ${appJwt}`,
      Accept: 'application/vnd.github+json',
    };

    const appResponse = await fetchWithTimeout(`${base}/app`, headers);
    if (!appResponse.ok) throw new Error(`GET /app failed: ${appResponse.status}`);
    const app = (await appResponse.json()) as { slug?: unknown };
    const slug = typeof app.slug === 'string' ? app.slug.trim() : '';
    if (!slug) throw new Error('GET /app response missing slug');

    const botLogin = `${slug}[bot]`;
    const userResponse = await fetchWithTimeout(
      `${base}/users/${encodeURIComponent(botLogin)}`,
      headers,
    );
    if (!userResponse.ok) {
      throw new Error(`GET /users/${botLogin} failed: ${userResponse.status}`);
    }
    const user = (await userResponse.json()) as { id?: unknown };
    const botUserId = typeof user.id === 'number' ? user.id : Number.NaN;
    if (!Number.isFinite(botUserId)) {
      throw new Error('GET /users/{slug}[bot] response missing id');
    }

    return {
      slug,
      botUserId,
      name: botLogin,
      email: `${botUserId}+${botLogin}@users.noreply.github.com`,
    };
  }
}

/** App bot 身份（提交身份来源；`email` 为 GitHub noreply 形式）。 */
export interface AppBotIdentity {
  slug: string;
  botUserId: number;
  name: string;
  email: string;
}

const APP_BOT_FETCH_TIMEOUT_MS = 10_000;

/** GitHub App 身份解析的出站请求超时（10s）；失败统一走降级。 */
async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APP_BOT_FETCH_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const APP_BOT_IDENTITY_CACHE_KEY = 'github:app-bot-identity';
const APP_BOT_IDENTITY_TTL_MS = 24 * 60 * 60 * 1000;
const APP_BOT_IDENTITY_FAIL_TTL_MS = 60 * 1000;
const APP_BOT_IDENTITY_FAIL_SENTINEL = '__fail__';

interface BotIdentityMemoryEntry {
  value: AppBotIdentity | null;
  expiresAt: number;
}

const botIdentityMemory = new Map<string, BotIdentityMemoryEntry>();

/** 测试用：清空进程内 bot 身份缓存（生产代码不调用）。 */
export function resetAppBotIdentityCache(): void {
  botIdentityMemory.clear();
}

function readBotIdentityMemory(): AppBotIdentity | null | undefined {
  const entry = botIdentityMemory.get(APP_BOT_IDENTITY_CACHE_KEY);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    botIdentityMemory.delete(APP_BOT_IDENTITY_CACHE_KEY);
    return undefined;
  }
  return entry.value;
}

function writeBotIdentityMemory(value: AppBotIdentity | null, expiresAt: number): void {
  botIdentityMemory.set(APP_BOT_IDENTITY_CACHE_KEY, { value, expiresAt });
}

function parseBotIdentity(raw: string): AppBotIdentity | null {
  try {
    const parsed = JSON.parse(raw) as Partial<AppBotIdentity> | null;
    if (!parsed || typeof parsed.slug !== 'string' || typeof parsed.botUserId !== 'number') {
      return null;
    }
    if (typeof parsed.name !== 'string' || typeof parsed.email !== 'string') return null;
    return {
      slug: parsed.slug,
      botUserId: parsed.botUserId,
      name: parsed.name,
      email: parsed.email,
    };
  } catch {
    return null;
  }
}

function safeRedis(): { get(key: string): Promise<string | null>; set(...args: unknown[]): Promise<unknown> } | null {
  try {
    return getRedisClient() as never;
  } catch {
    return null;
  }
}

async function writeBotIdentityCache(identity: AppBotIdentity | null): Promise<void> {
  const ttlSeconds = identity
    ? APP_BOT_IDENTITY_TTL_MS / 1000
    : APP_BOT_IDENTITY_FAIL_TTL_MS / 1000;
  writeBotIdentityMemory(
    identity,
    Date.now() + (identity ? APP_BOT_IDENTITY_TTL_MS : APP_BOT_IDENTITY_FAIL_TTL_MS),
  );
  const redis = safeRedis();
  if (!redis) return;
  try {
    await redis.set(
      APP_BOT_IDENTITY_CACHE_KEY,
      identity ? JSON.stringify(identity) : APP_BOT_IDENTITY_FAIL_SENTINEL,
      'EX',
      ttlSeconds,
    );
  } catch {
    // 缓存写失败不影响本次结果。
  }
}

export const githubService = new GitHubService();
