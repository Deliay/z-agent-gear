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
 * 仓库内建知识库 E2E（E2E-RKB1~6，需求 #545）。
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
      knowledgeBases: [
        { folder: 'product-docs', schema: '{"name":"产品文档"}', documents: [] },
        {
          folder: 'truncated-docs',
          schema: '{"name":"截断展示库"}',
          documents: [{ path: 'x.md', content: '# X' }],
          truncated: true,
        },
        {
          folder: 'error-docs',
          schema: '{"name":"错误文档库"}',
          documents: [{ path: 'big.md', error: 'file too large' }],
        },
      ],
      truncated: true,
    },
    {
      source: 'docs-root',
      knowledgeBases: [
        {
          folder: 'guides',
          schema: '{"name":"仓库指南"}',
          documents: [{ path: 'api/rest.md', content: '# REST 指南' }],
          truncated: false,
        },
      ],
      truncated: false,
    },
  ],
  truncated: true,
};

function hostRow(page: Page, name: string) {
  return page.locator('[data-testid^="repo-kb-host-"]').filter({ hasText: name });
}

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
  let emptyFake: FakeController;
  let oldHostName = '';
  let emptyHostName = '';

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

    const emptyKey = await createControllerKey(page, user.token);
    emptyFake = await registerController(emptyKey.rawKey, {
      version: '2.19.0',
      repoKnowledgeBases: { success: true, sources: [], truncated: false },
    });
    const emptyWorkspace = await createWorkspace(
      page,
      emptyFake.controllerId,
      `/tmp/rkb-e2e-empty-${Date.now()}`,
      user.token,
    );
    emptyHostName = '空知识库云电脑';
    await insertCloudHost({
      userId: user.userId,
      tenantId: user.userId,
      controllerId: emptyFake.controllerId,
      workspaceId: emptyWorkspace.id,
      name: emptyHostName,
    });
    await page.close();
  });

  test.afterAll(async () => {
    fake?.disconnect();
    oldFake?.disconnect();
    emptyFake?.disconnect();
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
    // 初始加载不得触发任何仓库扫描
    expect(fake.scans).toHaveLength(0);
    expect(oldFake.scans).toHaveLength(0);
    expect(emptyFake.scans).toHaveLength(0);
  });

  test('E2E-RKB2 逐级展开与只读预览；已截断/文件过大标示', async ({ page }) => {
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

    // 已截断徽标与「文件过大」不可点击节点（二期 #559）
    await openRepoGroup(page);
    await page.getByRole('button', { name: /仓库云电脑/ }).click();
    await expect(page.getByTestId('repo-kb-truncated-badge')).toHaveText('已截断');
    await page.getByRole('button', { name: /错误文档库/ }).click();
    await expect(page.getByTestId('repo-kb-document-error')).toHaveText('文件过大');
    const errorNode = page
      .locator('[data-testid="repo-kb-document-node"][data-unavailable="true"]')
      .filter({ hasText: 'big' });
    await expect(errorNode).toBeVisible();
    await expect(errorNode.getByTestId('repo-kb-document-link')).toHaveCount(0);
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

  test('E2E-RKB4 修改 fixture 后折叠态「重新检测」按新内容呈现', async ({ page }) => {
    await loginViaUI(page, user.username);
    await openRepoGroup(page);
    // 折叠态即可刷新（D10）；不在展开区提供独立刷新行
    const row = hostRow(page, '仓库云电脑');
    await expect(row.getByTestId('repo-kb-refresh')).toBeVisible();
    await expect(page.locator('[data-testid="repo-kb-refresh"]')).toHaveCount(1);

    scanFixture.sources[0].knowledgeBases[0].documents.push({
      path: 'new-doc.md',
      content: '# 新增文档',
    });
    try {
      await row.getByTestId('repo-kb-refresh').click();
      await page.getByRole('button', { name: /仓库云电脑/ }).click();
      await expect(page.getByText('团队规范')).toBeVisible();
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
    expect(oldFake.scans).toHaveLength(0);
  });

  test('E2E-RKB6 空态与平台知识库零回归', async ({ page }) => {
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

    // 未放置知识库的云电脑展开为空态
    await page.getByRole('button', { name: new RegExp(emptyHostName) }).click();
    await expect(page.getByText('未检测到仓库知识库')).toBeVisible();
    expect(emptyFake.scans.length).toBeGreaterThanOrEqual(1);
  });

  test('E2E-RKB7 空态三态：平台空+仓库有内容 / 两者皆空 / 平台非空（独立用户隔离）', async ({
    browser,
  }) => {
    // A：平台库空 + 仓库有内容 → 不出现「暂无知识库」
    const pageA = await browser.newPage();
    try {
      const userA = await createFrontUser(pageA);
      const keyA = await createControllerKey(pageA, userA.token);
      const fakeA = await registerController(keyA.rawKey, {
        version: '2.19.0',
        repoKnowledgeBases: scanFixture,
      });
      try {
        const wsA = await createWorkspace(
          pageA,
          fakeA.controllerId,
          `/tmp/rkb-e2e-iso-a-${Date.now()}`,
          userA.token,
        );
        await insertCloudHost({
          userId: userA.userId,
          tenantId: userA.userId,
          controllerId: fakeA.controllerId,
          workspaceId: wsA.id,
          name: '隔离云电脑A',
        });

        await loginViaUI(pageA, userA.username);
        await openRepoGroup(pageA);
        await expect(pageA.getByText('暂无知识库')).toHaveCount(0);
        await expect(pageA.locator('[data-testid="repo-knowledge-base-section"]')).toBeVisible();
      } finally {
        fakeA.disconnect();
      }
    } finally {
      await pageA.close();
    }

    // B：平台空 + 无仓库知识库（无候选云电脑）→ 出现「暂无知识库」
    const pageB = await browser.newPage();
    try {
      const userB = await createFrontUser(pageB);
      await loginViaUI(pageB, userB.username);
      await openRepoGroup(pageB);
      await expect(pageB.getByText('暂无知识库')).toBeVisible();
    } finally {
      await pageB.close();
    }

    // C：平台非空 → 不出现「暂无知识库」
    const pageC = await browser.newPage();
    try {
      const userC = await createFrontUser(pageC);
      const res = await gqlRequest(
        pageC,
        `mutation CreateKbIso($name: String!) { createKnowledgeBase(name: $name) { id name } }`,
        { name: `隔离平台库C-${Date.now()}` },
        userC.token,
      );
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      const name = body.data.createKnowledgeBase.name as string;

      await loginViaUI(pageC, userC.username);
      await openRepoGroup(pageC);
      await expect(pageC.getByText('暂无知识库')).toHaveCount(0);
      await expect(pageC.locator(KB_SECTION)).toContainText(name);
    } finally {
      await pageC.close();
    }
  });

  test('E2E-RKB9 docs 一层文件夹来源：独立徽标、可展开并阅读文档', async ({ page }) => {
    await loginViaUI(page, user.username);
    await openRepoGroup(page);
    await page.getByRole('button', { name: /仓库云电脑/ }).click();

    const badge = page
      .locator('[data-testid="repo-kb-item-"]')
      .filter({ hasText: '仓库指南' })
      .getByTestId('repo-kb-source-badge');
    await expect(badge).toHaveText('docs/');
    await expect(badge).toHaveAttribute('title', 'docs（一层文件夹）');

    await page.getByRole('button', { name: /仓库指南/ }).click();
    await page.getByRole('button', { name: 'api' }).click();
    await expect(page.getByText('rest')).toBeVisible();
    await page.getByTestId('repo-kb-document-link').first().click();
    await expect(page).toHaveURL(/\/knowledge-bases\/repo:.*docs-root.*\/api\/rest$/);
    await expect(page.getByTestId('knowledge-base-title')).toHaveText('rest');
    await expect(page.getByTestId('repo-knowledge-base-content')).toContainText('REST 指南');
  });

  test('E2E-RKB8 刷新图标在云电脑条目标题行尾部、无文字、折叠态点击生效、重复点击不异常', async ({
    page,
  }) => {
    await loginViaUI(page, user.username);
    await openRepoGroup(page);

    const row = hostRow(page, '仓库云电脑');
    const toggle = row.getByRole('button', { name: /仓库云电脑/ });
    const refresh = row.getByTestId('repo-kb-refresh');
    await expect(refresh).toBeVisible();
    await expect(refresh).toHaveAttribute('aria-label', '重新检测');
    await expect(refresh).toHaveAttribute('title', '重新检测');
    await expect(refresh).toHaveText('');
    // 与折叠切换按钮是兄弟节点（禁止按钮嵌套）
    await expect(toggle.getByTestId('repo-kb-refresh')).toHaveCount(0);

    const before = fake.scans.length;
    await refresh.click();
    await expect.poll(() => fake.scans.length).toBeGreaterThan(before);
    await expect(refresh).toBeEnabled();

    // 重复点击不异常，且仍能正常展开看到结果
    await refresh.click();
    await toggle.click();
    await expect(page.getByText('团队规范')).toBeVisible();
  });
});
