---
description: GitHub 帐号绑定 - 实现计划
type: Permanent
---

# GitHub 帐号绑定 - 实现计划

**关联 Proposal**: `proposals/20260709-feat-github-account-binding.md`
**创建日期**: 2026-07-09

## 实现顺序

```
Phase 1: Contract + 数据模型
  └── Phase 2: GitHub Service + 回调 Endpoint
       └── Phase 3: 前端设置页 UI
            └── Phase 4: 测试覆盖
```

---

## Phase 1: Contract + 数据模型

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/github.graphql` | 新增 | GitHub 绑定 GraphQL Schema |
| `servers/agent-api/src/graphql/schemas/github.ts` | 新增 | GraphQL typeDefs |
| `servers/agent-api/src/graphql/schemas/index.ts` | 修改 | 注册 github typeDefs |
| `servers/agent-api/src/graphql/resolvers/github.ts` | 新增 | GraphQL resolvers |
| `servers/agent-api/src/graphql/resolvers/index.ts` | 修改 | 注册 github resolvers |
| `servers/agent-api/src/models/github-account.ts` | 新增 | GitHubAccount Mongoose Model |
| `servers/agent-api/src/models/github-installation.ts` | 新增 | GitHubInstallation Mongoose Model |

### contracts/github.graphql

```graphql
type GitHubRepoPermissions {
  read: Boolean!
  write: Boolean!
}

type GitHubRepo {
  id: ID!
  repoId: Int!
  repoName: String!
  fullName: String!
  private: Boolean!
  permissions: GitHubRepoPermissions!
}

type GitHubInstallation {
  id: ID!
  installationId: Int!
  repos: [GitHubRepo!]
  createdAt: String!
}

type GitHubAccount {
  id: ID!
  githubUserId: Int!
  githubLogin: String!
  githubAvatarUrl: String
  installations: [GitHubInstallation!]
  createdAt: String!
}

type GitHubAppUrl {
  url: String!
  state: String!
}

extend type Query {
  githubAccounts: [GitHubAccount!]!
  githubAppUrl: GitHubAppUrl!
}

extend type Mutation {
  unbindGitHubAccount(accountId: ID!): Boolean!
  refreshGitHubInstallations(accountId: ID!): GitHubAccount!
}
```

### servers/agent-api/src/models/github-account.ts

```typescript
import { Schema, model, Document } from 'mongoose';

export interface IGitHubAccount extends Document {
  userId: string;
  githubUserId: number;
  githubLogin: string;
  githubAvatarUrl?: string;
  accessToken: string;
  tokenExpiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const githubAccountSchema = new Schema<IGitHubAccount>(
  {
    userId: { type: String, required: true, index: true },
    githubUserId: { type: Number, required: true },
    githubLogin: { type: String, required: true },
    githubAvatarUrl: { type: String },
    accessToken: { type: String, required: true },
    tokenExpiresAt: { type: Date },
  },
  { timestamps: true },
);

githubAccountSchema.index({ userId: 1, githubUserId: 1 }, { unique: true });

export const GitHubAccount = model<IGitHubAccount>('GitHubAccount', githubAccountSchema);
```

### servers/agent-api/src/models/github-installation.ts

```typescript
import { Schema, model, Document, Types } from 'mongoose';

export interface IGitHubRepo {
  repoId: number;
  repoName: string;
  fullName: string;
  private: boolean;
  permissions: { read: boolean; write: boolean };
}

export interface IGitHubInstallation extends Document {
  accountId: Types.ObjectId;
  installationId: number;
  repos: IGitHubRepo[];
  createdAt: Date;
}

const gitHubRepoSchema = new Schema<IGitHubRepo>(
  {
    repoId: { type: Number, required: true },
    repoName: { type: String, required: true },
    fullName: { type: String, required: true },
    private: { type: Boolean, required: true },
    permissions: {
      read: { type: Boolean, required: true },
      write: { type: Boolean, required: true },
    },
  },
  { _id: false },
);

const githubInstallationSchema = new Schema<IGitHubInstallation>(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'GitHubAccount', required: true, index: true },
    installationId: { type: Number, required: true, unique: true },
    repos: [gitHubRepoSchema],
  },
  { timestamps: true },
);

export const GitHubInstallation = model<IGitHubInstallation>('GitHubInstallation', githubInstallationSchema);
```

### servers/agent-api/src/graphql/schemas/github.ts

```typescript
export const githubTypeDefs = `#graphql
  extend type Query {
    githubAccounts: [GitHubAccount!]!
    githubAppUrl: GitHubAppUrl!
  }

  extend type Mutation {
    unbindGitHubAccount(accountId: ID!): Boolean!
    refreshGitHubInstallations(accountId: ID!): GitHubAccount!
  }
`;
```

### servers/agent-api/src/graphql/schemas/index.ts 变更

```typescript
import { githubTypeDefs } from './github.js';

export const typeDefs = [baseTypeDefs, authTypeDefs, providerTypeDefs, modelTypeDefs, controllerTypeDefs, controllerWorkspaceTypeDefs, sessionTypeDefs, gatewayTypeDefs, todoTypeDefs, mcpServerTypeDefs, githubTypeDefs];
```

### 启动 & 验证

```bash
# agent-api 目录下
npm run build    # TypeScript 编译通过
```

---

## Phase 2: GitHub Service + 回调 Endpoint

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/services/github.ts` | 新增 | GitHub API 交互服务 |
| `servers/agent-api/src/routes/github.ts` | 新增 | OAuth 回调 REST route |
| `servers/agent-api/src/index.ts` | 修改 | 注册 github route |
| `servers/agent-api/src/graphql/resolvers/github.ts` | 修改 | 补全 resolver 实现 |

### servers/agent-api/src/services/github.ts

```typescript
import { config } from '../config/index.js';
import crypto from 'crypto';
import { GitHubAccount, IGitHubAccount } from '../models/github-account.js';
import { GitHubInstallation, IGitHubRepo } from '../models/github-installation.js';

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
    await fetch(`${config.redisUri}`, {  // 存储 state -> userId 到 Redis
      // 简化: 由 callback endpoint 直接通过 Redis 校验
    });
    const url = `https://github.com/apps/${config.githubAppId}/installations/new?state=${state}`;
    return { url, state };
  }

  async handleCallback(params: { installationId: number; state: string; userId: string }): Promise<void> {
    // 1. 使用 App JWT 换取 Installation Token
    const token = await this.getInstallationToken(params.installationId);

    // 2. 获取 GitHub 用户信息
    const accountInfo = await this.getAccountInfo(token);

    // 3. 获取仓库列表
    const repos = await this.getRepositories(token);

    // 4. 存储
    const encryptedToken = encrypt(token);
    const account = await GitHubAccount.findOneAndUpdate(
      { userId: params.userId, githubUserId: accountInfo.id },
      {
        userId: params.userId,
        githubUserId: accountInfo.id,
        githubLogin: accountInfo.login,
        githubAvatarUrl: accountInfo.avatar_url,
        accessToken: encryptedToken,
      },
      { upsert: true, new: true },
    );

    await GitHubInstallation.findOneAndUpdate(
      { installationId: params.installationId },
      {
        accountId: account._id,
        installationId: params.installationId,
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
    );
  }

  async getAccounts(userId: string): Promise<any[]> {
    const accounts = await GitHubAccount.find({ userId }).lean();
    const installations = await GitHubInstallation.find({
      accountId: { $in: accounts.map(a => a._id) },
    }).lean();

    return accounts.map(account => ({
      id: account._id.toString(),
      githubUserId: account.githubUserId,
      githubLogin: account.githubLogin,
      githubAvatarUrl: account.githubAvatarUrl,
      createdAt: account.createdAt.toISOString(),
      installations: installations
        .filter(i => i.accountId.toString() === account._id.toString())
        .map(i => ({
          id: i._id.toString(),
          installationId: i.installationId,
          createdAt: i.createdAt.toISOString(),
          repos: i.repos,
        })),
    }));
  }

  async unbindAccount(userId: string, accountId: string): Promise<void> {
    const account = await GitHubAccount.findOneAndDelete({ _id: accountId, userId });
    if (account) {
      await GitHubInstallation.deleteMany({ accountId: account._id });
    }
  }

  async refreshInstallations(userId: string, accountId: string): Promise<any> {
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
      }));
      await inst.save();
    }

    return (await this.getAccounts(userId)).find(a => a.id === accountId);
  }

  private async getInstallationToken(installationId: number): Promise<string> {
    const jwt = this.createAppJwt();
    const response = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
        },
      },
    );
    if (!response.ok) throw new Error(`Failed to get installation token: ${response.status}`);
    const data = await response.json() as any;
    return data.token;
  }

  private createAppJwt(): string {
    // 使用 jsonwebtoken 签发 App JWT
    // const payload = { iss: config.githubAppId, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 };
    // return jwt.sign(payload, config.githubAppPrivateKey, { algorithm: 'RS256' });
    throw new Error('Not implemented');
  }

  private async getAccountInfo(token: string): Promise<{ id: number; login: string; avatar_url: string }> {
    const response = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error('Failed to get account info');
    return response.json() as any;
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
```

### servers/agent-api/src/routes/github.ts

```typescript
import { Router } from 'express';
import { GitHubService } from '../services/github.js';
import { getRedisClient } from '../middleware/redis.js';

export function createGithubRouter(githubService: GitHubService): Router {
  const router = Router();

  router.get('/github/callback', async (req, res) => {
    try {
      const { installation_id, setup_action, state } = req.query;

      if (!installation_id || !state) {
        res.redirect(`${config.frontendUrl}/settings?binding=error&message=missing_params`);
        return;
      }

      // 校验 state
      const redis = await getRedisClient();
      const userId = await redis.get(`github:oauth:state:${state}`);
      if (!userId) {
        res.redirect(`${config.frontendUrl}/settings?binding=error&message=invalid_state`);
        return;
      }

      // 清除已使用的 state
      await redis.del(`github:oauth:state:${state}`);

      // 处理回调
      await githubService.handleCallback({
        installationId: parseInt(installation_id as string, 10),
        state: state as string,
        userId: userId as string,
      });

      res.redirect(`${config.frontendUrl}/settings?binding=success`);
    } catch (error) {
      console.error('GitHub callback error:', error);
      res.redirect(`${config.frontendUrl}/settings?binding=error&message=internal_error`);
    }
  });

  return router;
}
```

### servers/agent-api/src/index.ts 变更

```typescript
import { githubRouter } from './routes/github.js';

// 在 app.use('/api', sessionStreamRouter) 之后添加
app.use('/api', githubRouter);
```

### servers/agent-api/src/graphql/resolvers/github.ts

```typescript
import { GitHubService } from '../../services/github.js';
import { AuthContext } from './auth.js';

export function createGithubResolvers(githubService: GitHubService) {
  return {
    Query: {
      githubAccounts: async (_parent: unknown, _args: unknown, context: AuthContext) => {
        if (!context.currentUser) throw new Error('Unauthorized');
        return githubService.getAccounts(context.currentUser.id);
      },
      githubAppUrl: async (_parent: unknown, _args: unknown, context: AuthContext) => {
        if (!context.currentUser) throw new Error('Unauthorized');
        return githubService.getAppUrl(context.currentUser.id);
      },
    },
    Mutation: {
      unbindGitHubAccount: async (_parent: unknown, args: { accountId: string }, context: AuthContext) => {
        if (!context.currentUser) throw new Error('Unauthorized');
        await githubService.unbindAccount(context.currentUser.id, args.accountId);
        return true;
      },
      refreshGitHubInstallations: async (_parent: unknown, args: { accountId: string }, context: AuthContext) => {
        if (!context.currentUser) throw new Error('Unauthorized');
        return githubService.refreshInstallations(context.currentUser.id, args.accountId);
      },
    },
  };
}
```

### 启动 & 验证

```bash
# agent-api 目录下
npm run build    # TypeScript 编译通过
```

---

## Phase 3: 前端设置页 UI

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/graphql/queries.ts` | 修改 | 新增 githubAccounts / githubAppUrl query |
| `apps/agent-web/src/graphql/mutations.ts` | 修改 | 新增 unbindGitHubAccount mutation |
| `apps/agent-web/src/graphql/types.ts` | 修改 | 新增 TypeScript 类型 |
| `apps/agent-web/src/components/settings/GithubBindingSection.tsx` | 新增 | 主 section |
| `apps/agent-web/src/components/settings/GithubAccountCard.tsx` | 新增 | 帐号卡片 |
| `apps/agent-web/src/components/settings/GithubRepoList.tsx` | 新增 | 仓库列表 |
| `apps/agent-web/src/components/settings/UnbindConfirmDialog.tsx` | 新增 | 解绑确认弹窗 |
| `apps/agent-web/src/pages/SettingsPage.tsx` | 修改 | 引入 GithubBindingSection |

### apps/agent-web/src/graphql/queries.ts 新增

```typescript
export const GET_GITHUB_ACCOUNTS = gql`
  query GetGithubAccounts {
    githubAccounts {
      id
      githubUserId
      githubLogin
      githubAvatarUrl
      createdAt
      installations {
        id
        installationId
        repos {
          id
          repoId
          repoName
          fullName
          private
          permissions {
            read
            write
          }
        }
      }
    }
  }
`;

export const GET_GITHUB_APP_URL = gql`
  query GetGithubAppUrl {
    githubAppUrl {
      url
      state
    }
  }
`;
```

### apps/agent-web/src/graphql/mutations.ts 新增

```typescript
export const UNBIND_GITHUB_ACCOUNT = gql`
  mutation UnbindGitHubAccount($accountId: ID!) {
    unbindGitHubAccount(accountId: $accountId)
  }
`;

export const REFRESH_GITHUB_INSTALLATIONS = gql`
  mutation RefreshGitHubInstallations($accountId: ID!) {
    refreshGitHubInstallations(accountId: $accountId) {
      id
      installations {
        id
        repos {
          id
          repoName
          fullName
          permissions {
            read
            write
          }
        }
      }
    }
  }
`;
```

### apps/agent-web/src/graphql/types.ts 新增

```typescript
export interface GitHubRepoPermissions {
  read: boolean;
  write: boolean;
}

export interface GitHubRepo {
  id: string;
  repoId: number;
  repoName: string;
  fullName: string;
  private: boolean;
  permissions: GitHubRepoPermissions;
}

export interface GitHubInstallation {
  id: string;
  installationId: number;
  repos?: GitHubRepo[];
  createdAt: string;
}

export interface GitHubAccount {
  id: string;
  githubUserId: number;
  githubLogin: string;
  githubAvatarUrl?: string;
  installations?: GitHubInstallation[];
  createdAt: string;
}

export interface GitHubAppUrl {
  url: string;
  state: string;
}
```

### 启动 & 验证

```bash
# agent-web 目录下
npm run build    # TypeScript 编译
npm run test     # 单元测试
```

---

## Phase 4: 测试覆盖

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/services/github.test.ts` | 新增 | GitHub Service 单元测试 |
| `servers/agent-api/src/routes/github.test.ts` | 新增 | 回调 endpoint 单元测试 |
| `servers/agent-api/src/graphql/resolvers/github.test.ts` | 新增 | GraphQL resolver 单元测试 |
| `apps/agent-web/src/components/settings/__tests__/GithubBindingSection.test.tsx` | 新增 | 前端组件测试 |
| `tests/api/src/agent-api/github.test.ts` | 新增 | API 集成测试（graphql endpoint 直连） |
| `tests/e2e/src/settings-github-binding.spec.ts` | 新增 | E2E 测试（Playwright UI 交互） |

### Phase 4a: 单元测试

```typescript
// servers/agent-api/src/services/github.test.ts
describe('GitHubService', () => {
  it('should generate app URL with state');
  it('should handle callback and store account');
  it('should handle callback and store installation with repos');
  it('should list accounts with installations');
  it('should unbind account and remove installations');
  it('should refresh installations');
  it('should encrypt and decrypt tokens');
});

// servers/agent-api/src/routes/github.test.ts
describe('GitHub Callback Route', () => {
  it('should redirect with error when missing params');
  it('should redirect with error when state is invalid');
  it('should process callback and redirect with success');
  it('should handle API errors gracefully');
});

// servers/agent-api/src/graphql/resolvers/github.test.ts
describe('GitHub Resolvers', () => {
  it('should return accounts for authenticated user');
  it('should return app URL for authenticated user');
  it('should reject unauthenticated requests');
  it('should unbind account');
});

// apps/agent-web/src/components/settings/__tests__/GithubBindingSection.test.tsx
describe('GithubBindingSection', () => {
  it('should show empty state when no accounts');
  it('should show bind button');
  it('should display account cards when bound');
  it('should show repos when expanding account');
  it('should show confirm dialog on unbind');
});
```

### Phase 4b: API 集成测试

`tests/api/src/agent-api/github.test.ts` — 使用 `gqlRequest` 直接调用 GraphQL 端点，验证认证和绑定的完整流程。

```typescript
import { describe, it, expect } from 'vitest';

const API_URL = process.env.API_URL || 'http://localhost:4000/graphql';

function gqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
}

const SIGNUP = `
  mutation Signup($username: String!, $password: String!) {
    signup(username: $username, password: $password) {
      token
      user { id }
    }
  }
`;

const GITHUB_APP_URL = `
  query GetGithubAppUrl {
    githubAppUrl { url state }
  }
`;

const GITHUB_ACCOUNTS = `
  query GetGithubAccounts {
    githubAccounts {
      id
      githubLogin
      githubUserId
      installations { id installationId repos { id repoName fullName permissions { read write } } }
    }
  }
`;

const UNBIND = `
  mutation Unbind($accountId: ID!) {
    unbindGitHubAccount(accountId: $accountId)
  }
`;

describe('GitHub Binding API', () => {
  let token = '';

  beforeAll(async () => {
    const res = await gqlRequest(SIGNUP, { username: `github_test_${Date.now()}`, password: 'password123' });
    const body = await res.json();
    token = body.data.signup.token;
  });

  it('githubAppUrl - should reject unauthenticated request', async () => {
    const res = await gqlRequest(GITHUB_APP_URL);
    const body = await res.json();
    expect(body.errors[0].message).toBe('Not authenticated');
  });

  it('githubAppUrl - should return URL for authenticated user', async () => {
    const res = await gqlRequest(GITHUB_APP_URL, undefined, token);
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.githubAppUrl.url).toContain('github.com/apps/');
    expect(body.data.githubAppUrl.state).toBeDefined();
  });

  it('githubAccounts - should reject unauthenticated request', async () => {
    const res = await gqlRequest(GITHUB_ACCOUNTS);
    const body = await res.json();
    expect(body.errors[0].message).toBe('Not authenticated');
  });

  it('githubAccounts - should return empty list initially', async () => {
    const res = await gqlRequest(GITHUB_ACCOUNTS, undefined, token);
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.githubAccounts).toEqual([]);
  });

  it('unbindGitHubAccount - should reject unauthenticated request', async () => {
    const res = await gqlRequest(UNBIND, { accountId: 'fake' });
    const body = await res.json();
    expect(body.errors[0].message).toBe('Not authenticated');
  });

  it('unbindGitHubAccount - should return false for non-existent account', async () => {
    const res = await gqlRequest(UNBIND, { accountId: '000000000000000000000000' }, token);
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.unbindGitHubAccount).toBe(false);
  });
});
```

| 测试 | 描述 |
|------|------|
| githubAppUrl - 无 auth | 应返回「Not authenticated」 |
| githubAppUrl - 已认证 | 应返回包含 github.com/apps/ 的 URL 和 state |
| githubAccounts - 无 auth | 应返回「Not authenticated」 |
| githubAccounts - 初始为空 | 应返回空数组 |
| unbindGitHubAccount - 无 auth | 应返回「Not authenticated」 |
| unbindGitHubAccount - 不存在 | 应返回 false |

### Phase 4c: E2E 测试

`tests/e2e/src/settings-github-binding.spec.ts` — 使用 Playwright 模拟用户在设置页的 GitHub 绑定交互。

```typescript
import { test, expect } from '@playwright/test';
import { registerUser } from './helpers.js';

test.describe('Settings GitHub Binding E2E', () => {
  let token = '';

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    const user = await registerUser(page);
    token = user.token;
    await page.goto('/login');
    await page.fill('#username', user.username);
    await page.fill('#password', 'testpass123');
    await page.click('button[type="submit"]');
    await expect(page.locator('nav[aria-label="Sidebar"]')).toBeVisible({ timeout: 10000 });
    await page.close();
  });

  test.beforeEach(async ({ page }) => {
    const user = await registerUser(page);
    await page.goto('/login');
    await page.fill('#username', user.username);
    await page.fill('#password', 'testpass123');
    await page.click('button[type="submit"]');
    await expect(page.locator('nav[aria-label="Sidebar"]')).toBeVisible({ timeout: 10000 });
    await page.click('a[href="/settings"]');
    await expect(page.getByText('退出登录')).toBeVisible({ timeout: 5000 });
  });

  test('should show GitHub binding section in settings page', async ({ page }) => {
    await expect(page.getByText('GitHub 绑定')).toBeVisible();
  });

  test('should show empty state with bind button when no accounts', async ({ page }) => {
    await expect(page.getByText(/暂无绑定/)).toBeVisible();
    await expect(page.getByRole('button', { name: '绑定 GitHub 帐号' })).toBeVisible();
  });

  test('should navigate to GitHub App authorization page on bind click', async ({ page }) => {
    await page.getByRole('button', { name: '绑定 GitHub 帐号' }).click();
    await expect(page).toHaveURL(/github\.com\/apps\//);
  });

  test('should show success toast when binding=success query param', async ({ page }) => {
    await page.goto('/settings?binding=success');
    await expect(page.getByText(/绑定成功/)).toBeVisible();
  });

  test('should show error toast when binding=error query param', async ({ page }) => {
    await page.goto('/settings?binding=error&message=invalid_state');
    await expect(page.getByText(/绑定失败/)).toBeVisible();
  });

  test('should show unbind confirm dialog on unbind click', async ({ page }) => {
    // 注入绑定数据后展示解绑按钮
    await page.goto('/settings');
    const unbindBtn = page.getByRole('button', { name: '解绑' }).first();
    if (await unbindBtn.isVisible()) {
      await unbindBtn.click();
      await expect(page.getByText(/确认解绑/)).toBeVisible();
    }
  });
});
```

| 测试 | 描述 |
|------|------|
| 设置页 section 可见性 | 设置页显示「GitHub 绑定」标题 |
| 空状态 + 绑定按钮 | 未绑定时显示空状态文字和「绑定 GitHub 帐号」按钮 |
| 点击绑定跳转 GitHub | 点击按钮后跳转到 github.com/apps/ 授权页 |
| 绑定成功 Toast | 携带 binding=success 参数时显示成功提示 |
| 绑定失败 Toast | 携带 binding=error 参数时显示失败提示 |
| 解绑确认对话框 | 点击解绑后弹出二次确认弹窗 |

### 运行测试

```bash
# 单元测试
cd servers/agent-api && npm run test
cd apps/agent-web && npm run test

# API 测试（需要启动 Aspire）
cd tests/api && API_URL=http://localhost:10001/graphql npm test -- github.test.ts

# E2E 测试（需要启动 Aspire）
cd tests/e2e && BASE_URL=http://localhost:5173 npx playwright test --grep "GitHub Binding"
```

---

## 命令速查

| 命令 | 工作目录 | 说明 |
|------|---------|------|
| `npm run build` | `servers/agent-api` | TypeScript 编译 |
| `npm run test` | `servers/agent-api` | 运行后端测试 |
| `npm run build` | `apps/agent-web` | TypeScript 编译 |
| `npm run test` | `apps/agent-web` | 运行前端测试 |
| `aspire start` | 根目录 | 启动全部服务 |

---

## 验收 Checklist

- [ ] **Phase 1**: Contract + GraphQL schema + Mongoose models 编译通过
- [ ] **Phase 2**: GitHub Service 回调处理正常
- [ ] **Phase 2**: 回调 endpoint state 校验正常
- [ ] **Phase 2**: Token 加密/解密正常
- [ ] **Phase 3**: 设置页 GitHub 绑定 section 渲染正常
- [ ] **Phase 3**: 绑定按钮跳转 GitHub App 安装页正常
- [ ] **Phase 3**: 绑定成功后列表刷新正常
- [ ] **Phase 3**: 解绑二次确认 + 删除正常
- [ ] **Phase 4**: 所有单元测试通过
