import { expect, test, type Page } from '@playwright/test';
import mongoose from 'mongoose';
import {
  createControllerKey,
  createFrontUser,
  createWorkspace,
  gqlRequest,
  loginViaUI,
  registerController,
  type FakeController,
  type FakeControllerOptions,
} from './helpers';
import { sectionToggle } from './phase4-helpers';

/**
 * 仓库内建知识库 E2E（E2E-RKB1~5，需求 #545）。
 *
 * 前置：Aspire 全量（agent-web / agent-api / controller-api）+ `INTERNAL_API_TOKEN`（开户）
 * + `MONGODB_URI`（直插 RUNNING 云电脑夹具）。fake controller version=2.19.0 并应答
 * `knowledge-bases:scan`（fixture 与 agent-gear 真实回包同形态）。串行执行（workers=1）。
 */

const MONGODB_URI = process.env.MONGODB_URI ?? '';
const KB_SECTION = '[data-testid="sidebar-section-knowledgeBases"]';

const scanFixture: Record<string, any> = {
  success: true,
  sources: [
    {
      source: 'zag',
      knowledgeBases: [
        {
          folder: 'team-rules',
          schema: '{"name":"团队规范","description":"规范库"}',
          documents: [
            {
              path: 'guides/git.md',
              content: '---\ntitle: Git 规范\ntags: [git]\ncustom: 自定义值\n---\n# 正文',
            },
            { path: 'onboarding.md', content: '# 上手' },
          ],
          truncated: false,
        },
        { folder: 'broken', schema: '{bad json', documents: [] },
      ],
      truncated: false,
    },
    {
      source: 'docs',
      knowledgeBases: [{ folder: 'product-docs', schema: '{"name":"产品文档"}', documents: [] }],
      truncated: false,
    },
  ],
  truncated: false,
};

async function mongoDb() {
  if (!MONGODB_URI) throw new Error('MONGODB_URI required');
  if (mongoose.connection.readyState === 0) await mongoose.connect(MONGODB_URI);
  return mongoose.connection.db!;
}

async function insertCloudHost(input: {
  userId: string;
  tenantId: string;
  controllerId: string;
  workspaceId: string;
  name: string;
}) {
  const db = await mongoDb();
  const _id = new mongoose.Types.ObjectId();
  await db.collection('cloudhosts').insertOne({
    _id,
    userId: new mongoose.Types.ObjectId(input.userId),
    tenantId: new mongoose.Types.ObjectId(input.tenantId),
    name: input.name,
    harnessTypes: [],
    status: 'RUNNING',
    controllerId: new mongoose.Types.ObjectId(input.controllerId),
    keyId: new mongoose.Types.ObjectId(),
    workspaceId: new mongoose.Types.ObjectId(input.workspaceId),
    resourceWorkspaceId: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return _id.toString();
}

async function openRepoGroup(page: Page) {
  await page.locator(sectionToggle('knowledgeBases')).click();
  await expect(page.locator(KB_SECTION)).toBeVisible();
  await expect(page.locator('[data-testid="repo-knowledge-base-section"]')).toBeVisible();
}

test.describe('仓库内建知识库 E2E', () => {
  test.skip(!MONGODB_URI, '需要 MONGODB_URI 直插云电脑夹具');

  let user: Awaited<ReturnType<typeof createFrontUser>>;
  let fake: FakeController;
  let oldFake: FakeController;
  let oldHostName = '';

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    user = await createFrontUser(page);

    const options: FakeControllerOptions = { version: '2.19.0', repoKnowledgeBases: scanFixture };
    const key = await createControllerKey(page, user.token);
    fake = await registerController(key.rawKey, options);
    const workspace = await createWorkspace(
      page,
      fake.controllerId,
      `/tmp/rkb-e2e-${Date.now()}`,
      user.token,
    );
    await insertCloudHost({
      userId: user.userId,
      tenantId: user.userId,
      controllerId: fake.controllerId,
      workspaceId: workspace.id,
      name: '仓库云电脑',
    });

    const oldKey = await createControllerKey(page, user.token);
    oldFake = await registerController(oldKey.rawKey, { version: '2.18.0' });
    const oldWorkspace = await createWorkspace(
      page,
      oldFake.controllerId,
      `/tmp/rkb-e2e-old-${Date.now()}`,
      user.token,
    );
    oldHostName = '旧版云电脑';
    await insertCloudHost({
      userId: user.userId,
      tenantId: user.userId,
      controllerId: oldFake.controllerId,
      workspaceId: oldWorkspace.id,
      name: oldHostName,
    });
    await page.close();
  });

  test.afterAll(async () => {
    fake?.disconnect();
    oldFake?.disconnect();
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  });

  test('E2E-RKB1 分组与候选云电脑：初始全部折叠（零扫描）', async ({ page }) => {
    await loginViaUI(page, user.username);
    await openRepoGroup(page);

    await expect(page.locator('[data-testid="repo-knowledge-base-section"]')).toContainText(
      '仓库知识库',
    );
    const host = page.getByRole('button', { name: /仓库云电脑/ });
    await expect(host).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('[data-testid^="repo-kb-item-"]')).toHaveCount(0);
  });

  test('E2E-RKB2 逐级展开与只读预览', async ({ page }) => {
    await loginViaUI(page, user.username);
    await openRepoGroup(page);
    await page.getByRole('button', { name: /仓库云电脑/ }).click();

    await expect(page.getByText('团队规范')).toBeVisible();
    await expect(page.getByTestId('repo-kb-source-badge').first()).toHaveText('zag');
    await expect(page.getByTestId('repo-kb-error')).toContainText('不是合法的 JSON');
    await expect(page.getByRole('button', { name: /broken/ })).toBeDisabled();

    await page.getByRole('button', { name: /团队规范/ }).click();
    await expect(page.getByTestId('repo-kb-folder-node')).toContainText('guides');
    await page.getByTestId('repo-kb-document-link').first().click();
    await expect(page).toHaveURL(/\/knowledge-bases\/repo:.*\/guides\/git$/);
    await expect(page.getByTestId('knowledge-base-title')).toHaveText('Git 规范');
  });

  test('E2E-RKB3 预览 front matter 表格与只读（?edit=1 忽略）', async ({ page }) => {
    await loginViaUI(page, user.username);
    await openRepoGroup(page);
    await page.getByRole('button', { name: /仓库云电脑/ }).click();
    await page.getByRole('button', { name: /团队规范/ }).click();
    await page.getByTestId('repo-kb-document-link').first().click();

    const table = page.getByTestId('repo-kb-front-matter-table');
    await expect(table).toBeVisible();
    await expect(table).toContainText('custom');
    await expect(table).toContainText('自定义值');
    await expect(page.getByTestId('repo-knowledge-base-content')).toContainText('正文');

    await expect(page.getByRole('button', { name: '编辑文档' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '删除文档' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '历史版本' })).toHaveCount(0);

    await page.goto(page.url() + '?edit=1');
    await expect(page.getByTestId('knowledge-base-editor')).toHaveCount(0);
    await expect(page.getByTestId('repo-kb-front-matter-table')).toBeVisible();
  });

  test('E2E-RKB4 修改 fixture 后「重新检测」按新内容呈现', async ({ page }) => {
    await loginViaUI(page, user.username);
    await openRepoGroup(page);
    await page.getByRole('button', { name: /仓库云电脑/ }).click();
    await expect(page.getByText('团队规范')).toBeVisible();

    scanFixture.sources[0].knowledgeBases[0].documents.push({
      path: 'new-doc.md',
      content: '# 新增文档',
    });
    try {
      await page.getByTestId('repo-kb-refresh').click();
      await page.getByRole('button', { name: /团队规范/ }).click();
      await expect(page.getByText('新增文档')).toBeVisible();
    } finally {
      scanFixture.sources[0].knowledgeBases[0].documents.pop();
    }
  });

  test('E2E-RKB5 版本 2.18.0：升级提示且不发起扫描', async ({ page }) => {
    await loginViaUI(page, user.username);
    await openRepoGroup(page);

    const oldHost = page.getByRole('button', { name: new RegExp(oldHostName) });
    await expect(oldHost).toBeDisabled();
    await expect(page.getByTestId('repo-kb-upgrade-hint')).toContainText('升级云电脑工作组件后可加载');
    await expect(page.getByTestId(/repo-kb-host-/).filter({ hasText: oldHostName })).toContainText(
      '升级',
    );
  });

  test('E2E-RKB6 零回归：平台知识库树与分区入口不变', async ({ page }) => {
    const res = await gqlRequest(
      page,
      `mutation CreateKb($name: String!) { createKnowledgeBase(name: $name) { id name } }`,
      { name: `平台库-${Date.now()}` },
      user.token,
    );
    const body = await res.json();
    expect(body.errors).toBeUndefined();
    const name = body.data.createKnowledgeBase.name as string;

    await loginViaUI(page, user.username);
    await openRepoGroup(page);
    await expect(page.locator(KB_SECTION)).toContainText(name);
  });
});
