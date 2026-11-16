import { expect, test, type Page } from '@playwright/test';
import {
  adminGqlRequest,
  adminLoginApi,
  createFrontUser,
  loginViaUI,
} from './helpers';
import { sectionToggle } from './phase4-helpers';

/**
 * 知识库 E2E（需求 #495 / 计划 §6.3 E2E-KB1~7）。
 *
 * 造数经 agent-api GraphQL（`createKnowledgeBase` / `createKnowledgeBaseDocument` 等），
 * UI 驱动关键路径；团队租户经 admin-api（`adminCreateTeamTenant` / `adminAddTenantMember`）准备。
 * 串行执行（playwright.config.ts 已强制 workers=1）。
 */

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const FRONT_WEB_URL = process.env.BASE_URL || 'http://localhost:35273';
const SIDEBAR = 'nav[aria-label="Sidebar"]';
const KB_SECTION = '[data-testid="sidebar-section-knowledgeBases"]';

type GqlResult<T = any> = { data?: T; errors?: Array<{ message: string }> };

async function gqlAs<T = any>(
  page: Page,
  token: string,
  query: string,
  variables?: Record<string, unknown>,
  workspaceId?: string,
): Promise<GqlResult<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  if (workspaceId) headers['x-workspace-id'] = workspaceId;
  const response = await page.request.post(API_URL, { headers, data: { query, variables } });
  return (await response.json()) as GqlResult<T>;
}

function expectNoErrors<T>(result: GqlResult<T>): T {
  expect(result.errors, JSON.stringify(result.errors)).toBeUndefined();
  return result.data as T;
}

const KB_FIELDS = `
  id name permissionMode global
  myAccess { canRead canCreate canUpdate canDelete canManage }
  createdAt updatedAt
`;

interface KbData {
  id: string;
  name: string;
  permissionMode: string;
  global: boolean;
  myAccess: {
    canRead: boolean;
    canCreate: boolean;
    canUpdate: boolean;
    canDelete: boolean;
    canManage: boolean;
  };
}

interface DocMeta {
  path: string;
  title: string;
  tags: string[];
  description: string;
  updatedAt: string;
}

interface DocData extends DocMeta {
  content: string;
}

async function apiCreateKb(
  page: Page,
  token: string,
  name: string,
  workspaceId?: string,
): Promise<KbData> {
  const result = await gqlAs<{ createKnowledgeBase: KbData }>(
    page,
    token,
    `mutation CreateKb($name: String!) { createKnowledgeBase(name: $name) { ${KB_FIELDS} } }`,
    { name },
    workspaceId,
  );
  return expectNoErrors(result).createKnowledgeBase;
}

async function apiCreateDoc(
  page: Page,
  token: string,
  kbId: string,
  path: string,
  input: { title: string; tags?: string[]; description?: string; content?: string },
  workspaceId?: string,
): Promise<DocData> {
  const result = await gqlAs<{ createKnowledgeBaseDocument: DocData }>(
    page,
    token,
    `mutation CreateDoc($knowledgeBaseId: ID!, $path: String!, $input: KnowledgeBaseDocumentInput!) {
      createKnowledgeBaseDocument(knowledgeBaseId: $knowledgeBaseId, path: $path, input: $input) {
        path title tags description content
      }
    }`,
    {
      knowledgeBaseId: kbId,
      path,
      input: {
        title: input.title,
        tags: input.tags ?? [],
        description: input.description ?? '',
        content: input.content ?? '',
      },
    },
    workspaceId,
  );
  return expectNoErrors(result).createKnowledgeBaseDocument;
}

async function apiUpdateDoc(
  page: Page,
  token: string,
  kbId: string,
  path: string,
  input: { title: string; tags?: string[]; description?: string; content?: string },
  workspaceId?: string,
): Promise<DocData> {
  const result = await gqlAs<{ updateKnowledgeBaseDocument: DocData }>(
    page,
    token,
    `mutation UpdateDoc($knowledgeBaseId: ID!, $path: String!, $input: KnowledgeBaseDocumentInput!) {
      updateKnowledgeBaseDocument(knowledgeBaseId: $knowledgeBaseId, path: $path, input: $input) {
        path title tags description content
      }
    }`,
    {
      knowledgeBaseId: kbId,
      path,
      input: {
        title: input.title,
        tags: input.tags ?? [],
        description: input.description ?? '',
        content: input.content ?? '',
      },
    },
    workspaceId,
  );
  return expectNoErrors(result).updateKnowledgeBaseDocument;
}

async function apiDeleteDoc(
  page: Page,
  token: string,
  kbId: string,
  path: string,
  workspaceId?: string,
): Promise<void> {
  const result = await gqlAs<{ deleteKnowledgeBaseDocument: boolean }>(
    page,
    token,
    `mutation DeleteDoc($knowledgeBaseId: ID!, $path: String!) {
      deleteKnowledgeBaseDocument(knowledgeBaseId: $knowledgeBaseId, path: $path)
    }`,
    { knowledgeBaseId: kbId, path },
    workspaceId,
  );
  expectNoErrors(result);
}

function docUrl(kbId: string, path: string, edit = false): string {
  const encoded = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `/knowledge-bases/${kbId}${encoded}${edit ? '?edit=1' : ''}`;
}

async function openKnowledgeBases(page: Page) {
  const toggle = page.locator(sectionToggle('knowledgeBases'));
  if ((await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click();
  }
  await expect(page.locator(KB_SECTION)).toBeVisible();
}

interface TeamFixture {
  teamId: string;
  globalWorkspaceId: string;
  owner: { token: string; username: string; userId: string };
  developer: { token: string; username: string; userId: string };
}

async function createTeamFixture(page: Page): Promise<TeamFixture> {
  const adminToken = await adminLoginApi(page);
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const owner = await createFrontUser(page, { prefix: 'kbo' });
  const developer = await createFrontUser(page, { prefix: 'kbd' });

  const created = await adminGqlRequest(
    page,
    `mutation CreateTeamTenant($name: String!) {
      adminCreateTeamTenant(name: $name) { id name type }
    }`,
    { name: `e2e-kb-${suffix}`.slice(0, 60) },
    adminToken,
  );
  const createdBody = await created.json();
  expect(createdBody.errors, JSON.stringify(createdBody.errors)).toBeUndefined();
  const teamId = createdBody.data.adminCreateTeamTenant.id as string;

  const detail = await adminGqlRequest(
    page,
    `query Tenant($id: ID!) { adminTenant(id: $id) { workspaces { id type name } } }`,
    { id: teamId },
    adminToken,
  );
  const detailBody = await detail.json();
  expect(detailBody.errors, JSON.stringify(detailBody.errors)).toBeUndefined();
  const globalWorkspace = (
    detailBody.data.adminTenant.workspaces as Array<{ id: string; type: string }>
  ).find((workspace) => workspace.type === 'global');
  expect(globalWorkspace, 'team 租户应自动开通全局工作区').toBeTruthy();

  for (const [username, role] of [
    [owner.username, 'admin'],
    [developer.username, 'developer'],
  ] as const) {
    const added = await adminGqlRequest(
      page,
      `mutation AddMember($tenantId: ID!, $username: String!, $role: TenantRole) {
        adminAddTenantMember(tenantId: $tenantId, username: $username, role: $role) {
          id username role
        }
      }`,
      { tenantId: teamId, username, role },
      adminToken,
    );
    const body = await added.json();
    expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
  }

  return {
    teamId,
    globalWorkspaceId: globalWorkspace!.id,
    owner,
    developer,
  };
}

/** 让指定用户在 UI 登录后默认落在给定工作区（persisted workspace 口径）。 */
async function pinWorkspace(page: Page, userId: string, workspaceId: string) {
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, value);
    },
    { key: `zag:current-workspace:${userId}`, value: workspaceId },
  );
}

/** 新隔离上下文（同一浏览器；用于「另一个用户」视角）。 */
function newIsolatedPage(page: Page): Promise<Page> {
  return page
    .context()
    .browser()!
    .newContext({ baseURL: FRONT_WEB_URL })
    .then((context) => context.newPage());
}

test.describe('知识库', () => {
  test('E2E-KB1 分区默认折叠；管理员可见「+」并创建；developer 无创建入口', async ({ page }) => {
    // 管理员（个人租户全局工作区默认 admin）
    const admin = await createFrontUser(page, { prefix: 'kba' });
    await loginViaUI(page, admin.username);

    await expect(page.locator(sectionToggle('knowledgeBases'))).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await openKnowledgeBases(page);
    const kbName = `团队规范-${Date.now().toString(36)}`;
    await page.getByRole('button', { name: '新建知识库' }).click();
    await page.getByLabel('知识库名称').fill(kbName);
    await page.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.locator(KB_SECTION)).toContainText(kbName);

    // developer：团队全局工作区的知识库可见，但无分区「+」
    const team = await createTeamFixture(page);
    await apiCreateKb(page, team.owner.token, `团队共享-${kbName}`, team.globalWorkspaceId);

    const developerPage = await newIsolatedPage(page);
    try {
      await pinWorkspace(developerPage, team.developer.userId, team.globalWorkspaceId);
      await loginViaUI(developerPage, team.developer.username);
      await openKnowledgeBases(developerPage);
      await expect(developerPage.locator(KB_SECTION)).toContainText(`团队共享-${kbName}`);
      await expect(
        developerPage.getByRole('button', { name: '新建知识库' }),
      ).toHaveCount(0);
    } finally {
      await developerPage.context().close();
    }
  });

  test('E2E-KB2 树形展示与条目「+」创建子文档并进入编辑模式', async ({ page }) => {
    const user = await createFrontUser(page, { prefix: 'kbb' });
    const kb = await apiCreateKb(page, user.token, `树-${Date.now().toString(36)}`);
    await apiCreateDoc(page, user.token, kb.id, '/guide', {
      title: '指南',
      content: '指南内容',
    });

    await loginViaUI(page, user.username);
    await openKnowledgeBases(page);
    const kbRow = page.locator(`[data-testid="knowledge-base-item-${kb.id}"]`);
    await expect(kbRow).toContainText('指南');

    // 文档条目「+」→ 持久化子文档 `新文档-XXXX` 并跳 `?edit=1`
    await page.getByRole('button', { name: '在 指南 下新建文档' }).click();
    await expect(page).toHaveURL(
      new RegExp(`/knowledge-bases/${kb.id}/guide/%E6%96%B0%E6%96%87%E6%A1%A3-[a-z0-9]{4}\\?edit=1$`),
    );
    await expect(page.getByTestId('knowledge-base-editor')).toBeVisible();
    await expect(page.getByLabel('标题')).toHaveValue(/^新文档-[a-z0-9]{4}$/);

    // 保存后进入预览，树中出现新文档标题
    await page.getByLabel('标题').fill('子文档');
    await page.getByRole('textbox', { name: '内容' }).fill('# 子文档内容');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByTestId('knowledge-base-preview')).toBeVisible();
    await expect(page.getByTestId('knowledge-base-title')).toHaveText('子文档');
    await expect(kbRow).toContainText('子文档');
  });

  test('E2E-KB3 分栏编辑实时预览、保存清草稿、刷新后草稿恢复/放弃两分支', async ({ page }) => {
    const user = await createFrontUser(page, { prefix: 'kbc' });
    const kb = await apiCreateKb(page, user.token, `编辑-${Date.now().toString(36)}`);
    const doc = await apiCreateDoc(page, user.token, kb.id, '/edit', {
      title: '编辑文档',
      content: '已保存内容',
    });

    await loginViaUI(page, user.username);
    await page.goto(docUrl(kb.id, doc.path, true));
    await expect(page.getByTestId('knowledge-base-editor')).toBeVisible();

    // 右侧输入左侧实时预览
    await page.getByRole('textbox', { name: '内容' }).fill('## 实时预览内容');
    await expect(page.getByTestId('knowledge-base-editor-preview')).toContainText('实时预览内容');

    // 保存后预览生效、草稿清除
    await page.getByLabel('标题').fill('保存后的标题');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByTestId('knowledge-base-title')).toHaveText('保存后的标题');
    await expect(page.getByTestId('knowledge-base-content')).toContainText('实时预览内容');
    const draftKey = `kb-doc-draft:${kb.id}:${doc.path}`;
    expect(await page.evaluate((key) => localStorage.getItem(key), draftKey)).toBeNull();

    // 恢复分支：输入未保存内容 → 防抖落盘 → 刷新重进编辑 → 询问恢复
    await page.goto(docUrl(kb.id, doc.path, true));
    await page.getByRole('textbox', { name: '内容' }).fill('未保存的恢复内容');
    await page.waitForTimeout(400);
    await page.reload();
    await expect(page.getByText('恢复未保存的内容？')).toBeVisible();
    await page.getByRole('button', { name: '恢复' }).click();
    await expect(page.getByRole('textbox', { name: '内容' })).toHaveValue('未保存的恢复内容');

    // 放弃分支：再次输入 → 刷新 → 放弃 → 回到已保存内容
    await page.getByRole('textbox', { name: '内容' }).fill('未保存的放弃内容');
    await page.waitForTimeout(400);
    await page.reload();
    await expect(page.getByText('恢复未保存的内容？')).toBeVisible();
    await page.getByRole('button', { name: '放弃' }).click();
    await expect(page.getByRole('textbox', { name: '内容' })).toHaveValue('## 实时预览内容');
  });

  test('E2E-KB4 预览页元素、地址栏路径与超长内容无横向溢出', async ({ page }) => {
    const user = await createFrontUser(page, { prefix: 'kbd4' });
    const kb = await apiCreateKb(page, user.token, `预览-${Date.now().toString(36)}`);
    const longWord = 'A'.repeat(400);
    const doc = await apiCreateDoc(page, user.token, kb.id, '/guides/setup', {
      title: '环境搭建',
      description: '新同学的第一份上手指南',
      tags: ['入门', '规范'],
      content: `# 安装\n\n${longWord}\n\n\`\`\`bash\npnpm install\n\`\`\``,
    });

    await page.setViewportSize({ width: 1100, height: 900 });
    await loginViaUI(page, user.username);
    await page.goto(docUrl(kb.id, doc.path));

    await expect(page.getByTestId('knowledge-base-breadcrumb')).toContainText('根目录');
    await expect(page.getByTestId('knowledge-base-title')).toHaveText('环境搭建');
    await expect(page.getByTestId('knowledge-base-description')).toContainText(
      '新同学的第一份上手指南',
    );
    await expect(page.getByTestId('knowledge-base-tags')).toContainText('入门');
    await expect(page.getByTestId('knowledge-base-content')).toContainText('安装');
    await expect(page).toHaveURL(new RegExp(`/knowledge-bases/${kb.id}/guides/setup$`));

    // 超长无空格内容：内容区与整页均无横向溢出
    const contentOverflow = await page
      .getByTestId('knowledge-base-preview')
      .evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(contentOverflow).toBeLessThanOrEqual(1);
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(pageOverflow).toBeLessThanOrEqual(1);
  });

  test('E2E-KB5 历史版本下拉时间倒序、选择版本只读预览（含已删除路径）', async ({ page }) => {
    const user = await createFrontUser(page, { prefix: 'kbe' });
    const kb = await apiCreateKb(page, user.token, `历史-${Date.now().toString(36)}`);
    await apiCreateDoc(page, user.token, kb.id, '/history', {
      title: '第一版',
      content: '第一版内容',
    });
    await apiUpdateDoc(page, user.token, kb.id, '/history', {
      title: '第二版',
      content: '第二版内容',
    });
    await apiDeleteDoc(page, user.token, kb.id, '/history');
    // 同路径重建：历史延续（CREATE/UPDATE/DELETE/CREATE）
    await apiCreateDoc(page, user.token, kb.id, '/history', {
      title: '重建版',
      content: '重建内容',
    });

    await loginViaUI(page, user.username);
    await page.goto(docUrl(kb.id, '/history'));
    await page.getByRole('button', { name: '历史版本' }).click();

    const select = page.getByTestId('knowledge-base-history-select');
    await expect(select).toBeVisible();
    const options = select.locator('option');
    await expect(options).toHaveCount(4);
    // 第一项为最新（重建 CREATE）
    await expect(options.first()).toContainText('创建');

    const deleteOptions = options.filter({ hasText: '删除' });
    await expect(deleteOptions).toHaveCount(1);
    const deleteValue = await deleteOptions.first().getAttribute('value');
    await select.selectOption(deleteValue!);
    await expect(page.getByTestId('knowledge-base-history-preview')).toContainText('第二版内容');
  });

  test('E2E-KB6 设置改权限后 developer 视野变化、全库历史倒序、删除知识库', async ({ page }) => {
    const team = await createTeamFixture(page);
    const kbName = `权限-${Date.now().toString(36)}`;
    const kb = await apiCreateKb(page, team.owner.token, kbName, team.globalWorkspaceId);
    await apiCreateDoc(page, team.owner.token, kb.id, '/a', { title: 'A' }, team.globalWorkspaceId);
    await apiCreateDoc(page, team.owner.token, kb.id, '/b', { title: 'B' }, team.globalWorkspaceId);

    const developerPage = await newIsolatedPage(page);
    try {
      await pinWorkspace(developerPage, team.developer.userId, team.globalWorkspaceId);
      await loginViaUI(developerPage, team.developer.username);
      await openKnowledgeBases(developerPage);
      await expect(developerPage.locator(KB_SECTION)).toContainText(kbName);

      await pinWorkspace(page, team.owner.userId, team.globalWorkspaceId);
      await loginViaUI(page, team.owner.username);
      await openKnowledgeBases(page);
      await page.getByRole('button', { name: `${kbName} 设置` }).click();

      // 全库历史时间倒序（先创建 /a 再创建 /b）
      const events = page.getByTestId('knowledge-base-event');
      await expect(events.first()).toContainText('创建');
      await expect(events.first()).toContainText('/b');
      await expect(events.nth(1)).toContainText('/a');

      // 改权限为 NONE → developer 刷新后不可见
      await page.getByRole('radio', { name: /NONE/ }).check();
      await expect(page.getByText('权限模式已更新')).toBeVisible();
      await page.getByRole('button', { name: '关闭' }).click();

      await developerPage.reload();
      await openKnowledgeBases(developerPage);
      await expect(developerPage.locator(KB_SECTION)).not.toContainText(kbName);
      await expect(developerPage.locator(KB_SECTION)).toContainText('暂无知识库');

      // 删除知识库（二次确认）后树下架
      await page.getByRole('button', { name: `${kbName} 设置` }).click();
      await page.getByRole('button', { name: '删除知识库' }).click();
      await page.getByRole('button', { name: '删除', exact: true }).click();
      await expect(page.locator(KB_SECTION)).not.toContainText(kbName);
      expect(
        (await gqlAs(page, team.owner.token, `query { knowledgeBases { id } }`, undefined, team.globalWorkspaceId))
          .data?.knowledgeBases ?? [],
      ).toHaveLength(0);
    } finally {
      await developerPage.context().close();
    }
  });

  test('E2E-KB7 删除文档路径释放、同路径重建与历史仍可查看', async ({ page }) => {
    const user = await createFrontUser(page, { prefix: 'kbg' });
    const kb = await apiCreateKb(page, user.token, `删除-${Date.now().toString(36)}`);
    const doc = await apiCreateDoc(page, user.token, kb.id, '/to-delete', {
      title: '待删除',
      content: '删除前内容',
    });

    await loginViaUI(page, user.username);
    await openKnowledgeBases(page);
    await page.goto(docUrl(kb.id, doc.path));
    await page.getByRole('button', { name: '删除文档' }).click();
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/knowledge-bases/${kb.id}/?$`));
    await expect(page.locator(KB_SECTION)).not.toContainText('待删除');

    // 同路径立即重建（API），历史包含删除前快照
    await apiCreateDoc(page, user.token, kb.id, '/to-delete', {
      title: '重建文档',
      content: '重建内容',
    });
    await page.goto(docUrl(kb.id, doc.path));
    await expect(page.getByTestId('knowledge-base-title')).toHaveText('重建文档');
    await page.getByRole('button', { name: '历史版本' }).click();
    const options = page.getByTestId('knowledge-base-history-select').locator('option');
    await expect(options.filter({ hasText: '删除' })).toHaveCount(1);
    await expect(options).toHaveCount(3);
  });

  test('E2E-KB8 编辑模式修改路径保存：导航新路径、历史含移动、原路径可重建、目标占用提示', async ({
    page,
  }) => {
    const user = await createFrontUser(page, { prefix: 'kbh' });
    const kb = await apiCreateKb(page, user.token, `移动-${Date.now().toString(36)}`);
    const doc = await apiCreateDoc(page, user.token, kb.id, '/origin', {
      title: '待移动',
      content: '移动前内容',
    });

    await loginViaUI(page, user.username);
    await page.goto(docUrl(kb.id, doc.path, true));
    await expect(page.getByTestId('knowledge-base-editor')).toBeVisible();

    // 修改路径并保存 → 地址栏跳新路径、预览生效
    await page.getByLabel('路径').fill('/moved/target');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page).toHaveURL(new RegExp(`/knowledge-bases/${kb.id}/moved/target$`));
    await expect(page.getByTestId('knowledge-base-title')).toHaveText('待移动');
    await expect(page.getByTestId('knowledge-base-content')).toContainText('移动前内容');

    // 历史版本含「移动」记录且路径位展示 fromPath → path
    await page.getByRole('button', { name: '历史版本' }).click();
    const options = page.getByTestId('knowledge-base-history-select').locator('option');
    await expect(options.filter({ hasText: '移动' })).toHaveCount(1);
    const moveValue = await options.filter({ hasText: '移动' }).first().getAttribute('value');
    await page.getByTestId('knowledge-base-history-select').selectOption(moveValue!);
    const pathLine = page.getByTestId('knowledge-base-history-path');
    await expect(pathLine).toContainText('/origin');
    await expect(pathLine).toContainText('/moved/target');
    await page.keyboard.press('Escape');

    // 原路径释放：可立即重建且历史独立
    await apiCreateDoc(page, user.token, kb.id, '/origin', {
      title: '重建文档',
      content: '重建内容',
    });
    await page.goto(docUrl(kb.id, '/origin'));
    await expect(page.getByTestId('knowledge-base-title')).toHaveText('重建文档');
    await page.getByRole('button', { name: '历史版本' }).click();
    const rebornOptions = page.getByTestId('knowledge-base-history-select').locator('option');
    await expect(rebornOptions).toHaveCount(1);
    await page.keyboard.press('Escape');

    // 目标被占用：提示「该路径已存在文档」并保持编辑态
    await page.goto(docUrl(kb.id, '/origin', true));
    await page.getByLabel('路径').fill('/moved/target');
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByTestId('knowledge-base-editor-error')).toContainText('该路径已存在文档');
    await expect(page.getByTestId('knowledge-base-editor')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/knowledge-bases/${kb.id}/origin\\?edit=1$`));
  });

  test('E2E-KB9 标签徽章编辑：回车/逗号生成、逐枚删除、空输退格、粘贴拆分去重、16 枚上限', async ({
    page,
  }) => {
    const user = await createFrontUser(page, { prefix: 'kbi' });
    const kb = await apiCreateKb(page, user.token, `标签-${Date.now().toString(36)}`);
    const doc = await apiCreateDoc(page, user.token, kb.id, '/tags', {
      title: '标签文档',
      content: '内容',
      tags: [],
    });

    await loginViaUI(page, user.username);
    await page.goto(docUrl(kb.id, doc.path, true));
    const tagInput = page.getByLabel('标签');

    // 三触发：Enter / 英文逗号 / 中文逗号
    await tagInput.fill('a');
    await tagInput.press('Enter');
    await tagInput.fill('b');
    await tagInput.press(',');
    await tagInput.fill('c');
    await tagInput.press('，');
    for (const tag of ['a', 'b', 'c']) {
      await expect(page.getByRole('button', { name: `删除标签 ${tag}` })).toBeVisible();
    }

    // 逐枚删除 + 空输退格删末枚
    await page.getByRole('button', { name: '删除标签 a' }).click();
    await expect(page.getByRole('button', { name: '删除标签 a' })).toHaveCount(0);
    await tagInput.press('Backspace');
    await expect(page.getByRole('button', { name: '删除标签 c' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '删除标签 b' })).toBeVisible();

    // 粘贴拆分（中英文逗号）并去重
    await tagInput.evaluate((element) => {
      const data = new DataTransfer();
      data.setData('text/plain', 'x, y，z');
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    });
    for (const tag of ['x', 'y', 'z']) {
      await expect(page.getByRole('button', { name: `删除标签 ${tag}` })).toBeVisible();
    }
    await tagInput.evaluate((element) => {
      const data = new DataTransfer();
      data.setData('text/plain', 'x, y');
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    });
    await expect(page.getByTestId('tag-badge')).toHaveCount(4);

    // 16 枚上限：输入框禁用并提示
    for (let index = 4; index < 16; index += 1) {
      await tagInput.fill(`t${index}`);
      await tagInput.press('Enter');
    }
    await expect(page.getByTestId('tag-badge')).toHaveCount(16);
    await expect(tagInput).toBeDisabled();
    await expect(tagInput).toHaveAttribute('placeholder', '最多 16 个标签');

    // 删除一枚后恢复可输
    await page.getByRole('button', { name: '删除标签 t15' }).click();
    await expect(tagInput).toBeEnabled();

    // 保存后预览页徽章展示零回归
    await page.getByRole('button', { name: '保存' }).click();
    await expect(page.getByTestId('knowledge-base-tags')).toContainText('t4');
    await expect(page.getByTestId('knowledge-base-tags')).toContainText('b');
  });

  test('E2E-KB1b 服务端拒绝越权创建（developer 直接调用）', async ({ page }) => {
    const team = await createTeamFixture(page);
    const result = await gqlAs(
      page,
      team.developer.token,
      `mutation CreateKb($name: String!) { createKnowledgeBase(name: $name) { id } }`,
      { name: 'developer-should-fail' },
      team.globalWorkspaceId,
    );
    expect(result.errors?.[0]?.message).toBe('not a tenant admin');
  });
});
