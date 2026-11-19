/**
 * 云电脑项目级 Github 凭据端点（A.2 内部接口）API 回归 —— Issue #566。
 *
 * 覆盖（计划 T-GPT-API1~6）：
 * - 带 `repoFullName` 时按项目签发并回显绑定仓库名（大小写不敏感命中）；
 * - 未绑定项目 → 404 `PROJECT_NOT_BOUND`；
 * - 绑定存在但账号无仓库权限 → 403 `REPO_NOT_AUTHORIZED`；
 * - 非法 `repoFullName` → 400 `INVALID_REPO`；
 * - 无 body（主项目口径）→ 取最早绑定并回显。
 *
 * 前置：agent-api 就绪、`INTERNAL_API_TOKEN`、`MONGODB_URI`（缺任一项显式失败）。
 * 200 签发路径需要 `GITHUB_APP_PRIVATE_KEY` + `GITHUB_API_BASE`（mock GitHub），缺失时按 D11 跳过。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const API_BASE = API_URL.replace(/\/graphql\/?$/, '');
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN ?? '';
const MONGODB_URI = process.env.MONGODB_URI ?? '';
const HAS_SIGNING = Boolean(process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_API_BASE);

const skippable = !HAS_SIGNING;

async function mongoDb(): Promise<mongoose.mongo.Db> {
  if (mongoose.connection.readyState === 0) await mongoose.connect(MONGODB_URI);
  return mongoose.connection.db!;
}

function objectId(): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId();
}

interface Fixtures {
  controllerId: string;
  tenantId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  accountId: mongoose.Types.ObjectId;
  installationId: mongoose.Types.ObjectId;
}

async function seedMovable(): Promise<Fixtures> {
  const db = await mongoDb();
  const fixtures: Fixtures = {
    controllerId: String(objectId()),
    tenantId: objectId(),
    userId: objectId(),
    accountId: objectId(),
    installationId: objectId(),
  };

  await db.collection('controllers').insertOne({
    _id: new mongoose.Types.ObjectId(fixtures.controllerId),
    userId: fixtures.userId,
    tenantId: fixtures.tenantId,
    name: 'gpt-test-controller',
    type: 'cloud',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await db.collection('cloudhosts').insertOne({
    _id: objectId(),
    userId: fixtures.userId,
    tenantId: fixtures.tenantId,
    controllerId: new mongoose.Types.ObjectId(fixtures.controllerId),
    name: 'gpt-test-host',
    status: 'RUNNING',
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });

  await db.collection('githubaccounts').insertOne({
    _id: fixtures.accountId,
    userId: fixtures.userId,
    tenantId: fixtures.tenantId,
    githubUserId: 900566,
    githubLogin: 'octo-gpt',
    accessTokenEncrypted: 'unused',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // 只授权 owner/a，用于覆盖 owner/b 的 REPO_NOT_AUTHORIZED。
  await db.collection('githubinstallations').insertOne({
    _id: fixtures.installationId,
    accountId: fixtures.accountId,
    githubUserId: 900566,
    installationId: 424566,
    accountLogin: 'octo-gpt',
    accountType: 'Organization',
    repos: [{ repoId: 1, repoName: 'a', fullName: 'owner/a', private: false }],
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await db.collection('cloud_host_github_bindings').insertMany([
    {
      _id: objectId(),
      userId: fixtures.userId,
      tenantId: fixtures.tenantId,
      controllerId: new mongoose.Types.ObjectId(fixtures.controllerId),
      accountId: fixtures.accountId,
      repoFullName: 'owner/a',
      targetPath: '/home/worker/workspace/owner/a',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
    {
      _id: objectId(),
      userId: fixtures.userId,
      tenantId: fixtures.tenantId,
      controllerId: new mongoose.Types.ObjectId(fixtures.controllerId),
      accountId: fixtures.accountId,
      repoFullName: 'owner/b',
      targetPath: '/home/worker/workspace/owner/b',
      createdAt: new Date('2026-01-02T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    },
  ]);

  return fixtures;
}

async function cleanup(fixtures: Fixtures | null): Promise<void> {
  if (!fixtures) return;
  const db = await mongoDb();
  await db.collection('cloud_host_github_bindings').deleteMany({
    controllerId: new mongoose.Types.ObjectId(fixtures.controllerId),
  });
  await db.collection('githubinstallations').deleteMany({ _id: fixtures.installationId });
  await db.collection('githubaccounts').deleteMany({ _id: fixtures.accountId });
  await db.collection('cloudhosts').deleteMany({
    controllerId: new mongoose.Types.ObjectId(fixtures.controllerId),
  });
  await db.collection('controllers').deleteMany({
    _id: new mongoose.Types.ObjectId(fixtures.controllerId),
  });
}

function credential(body?: Record<string, unknown>): Promise<Response> {
  if (!fixtures) throw new Error('fixtures not ready');
  return fetch(`${API_BASE}/internal/cloud-hosts/${fixtures.controllerId}/github-credential`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${INTERNAL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

let fixtures: Fixtures | null = null;

beforeAll(async () => {
  if (!INTERNAL_TOKEN) throw new Error('INTERNAL_API_TOKEN 缺失：无法调用内部凭据端点');
  if (!MONGODB_URI) throw new Error('MONGODB_URI 缺失：无法构造云主机/绑定夹具');
  fixtures = await seedMovable();
}, 60_000);

afterAll(async () => {
  await cleanup(fixtures);
  fixtures = null;
  await mongoose.disconnect();
});

describe('云电脑项目级 Github 凭据端点', () => {
  it('T-GPT-API2: 未绑定项目 → 404 PROJECT_NOT_BOUND', async () => {
    const res = await credential({ repoFullName: 'owner/unknown' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'PROJECT_NOT_BOUND' });
  });

  it('T-GPT-API3: 绑定存在但账号无权限 → 403 REPO_NOT_AUTHORIZED', async () => {
    const res = await credential({ repoFullName: 'owner/b' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'REPO_NOT_AUTHORIZED' });
  });

  it('T-GPT-API4: 非法 repoFullName → 400 INVALID_REPO', async () => {
    for (const repoFullName of ['bad', 'a/b/c', 'own er/repo']) {
      const res = await credential({ repoFullName });
      expect(res.status, repoFullName).toBe(400);
      expect(await res.json()).toEqual({ error: 'INVALID_REPO' });
    }
  });

  it.skipIf(skippable)('T-GPT-API1: 带 body 签发项目级 token 并回显', async () => {
    const res = await credential({ repoFullName: 'owner/a' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.repoFullName).toBe('owner/a');
    expect(typeof body.token).toBe('string');
  });

  it.skipIf(skippable)('T-GPT-API5: 大小写不敏感命中绑定', async () => {
    const res = await credential({ repoFullName: 'OWNER/A' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.repoFullName).toBe('owner/a');
  });

  it.skipIf(skippable)('T-GPT-API6: 无 body 取最早绑定（主项目口径）并回显', async () => {
    const res = await credential();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.repoFullName).toBe('owner/a');
  });
});
