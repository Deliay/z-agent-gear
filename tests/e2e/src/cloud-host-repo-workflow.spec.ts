import { test, expect, type Page } from '@playwright/test';
import mongoose from 'mongoose';
import {
  createControllerKey,
  createWorkspace,
  gqlRequest,
  loginViaUI,
  registerController,
  registerUser,
  type FakeController,
} from './helpers';

/**
 * 工作流模板项目持久化 —— E2E-RW1 / E2E-RW2 / E2E-RW5。
 *
 * 云电脑夹具直接写 Mongo 构造（controller 由 fake controller 注册后更新为 cloud + 插入 cloudhost），
 * 扫描应答由 fake controller 提供（fixture 与 agent-gear 真实回包同形态）。
 * GitHub 设置成功 / 手工新增工作目录的提示触发链路由 ControllerConfigPage 组件单测覆盖
 * （T-RW-WEB/T-RW 触发断言）；本文件聚焦「工作流」区块的检测-配置-列表链路与非 cloud 零回归。
 */
const HAS_MONGO = Boolean(process.env.MONGODB_URI);

const VALID_TEMPLATE = JSON.stringify({
  name: '项目开发流程',
  description: '仓库内开发流程',
  nodes: [
    {
      nodeKey: 'requirement',
      type: 'HUMAN',
      name: '产品需求',
      stage: '需求',
      dependsOn: [],
      requiresWorktree: false,
    },
    {
      nodeKey: 'design',
      type: 'AI',
      name: '技术方案',
      stage: '设计',
      prompts: ['产出技术方案'],
      artifactTitles: ['技术方案文档'],
      dependsOn: ['requirement'],
      requiresWorktree: false,
    },
  ],
});

async function mongoDb(): Promise<mongoose.mongo.Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
  return mongoose.connection.db ?? null;
}

interface RepoFixture {
  controllerId: string;
  controllerName: string;
  workspaceId: string;
  username: string;
  fake: FakeController;
}

async function setupCloudFixture(page: Page): Promise<RepoFixture> {
  const user = await registerUser(page);
  const { rawKey } = await createControllerKey(page, user.token);
  const fake = await registerController(rawKey, {
    version: '2.18.0',
    workflowTemplates: [
      { fileName: 'dev.json', content: VALID_TEMPLATE },
      { fileName: 'broken.json', content: '{ not json' },
    ],
  });
  const workspace = await createWorkspace(page, fake.controllerId, '/home/worker/workspace/project', user.token);
  const controllerName = `repo-wf-${fake.controllerId.slice(-6)}`;

  const db = (await mongoDb())!;
  const controllerDoc = await db.collection('controllers').findOne({
    _id: new mongoose.Types.ObjectId(fake.controllerId),
  });
  const globalWorkspaceId = controllerDoc?.workspaceId ?? user.userId;
  const now = new Date();
  await db.collection('controllers').updateOne(
    { _id: new mongoose.Types.ObjectId(fake.controllerId) },
    { $set: { type: 'cloud', status: 'online', name: controllerName } },
  );
  await db.collection('cloudhosts').insertOne({
    _id: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(user.userId),
    tenantId: new mongoose.Types.ObjectId(user.userId),
    resourceWorkspaceId: globalWorkspaceId,
    name: '项目模板云电脑',
    harnessTypes: ['OPENCODE'],
    status: 'RUNNING',
    controllerId: new mongoose.Types.ObjectId(fake.controllerId),
    keyId: controllerDoc?.keyId,
    workspaceId: new mongoose.Types.ObjectId(workspace.id),
    defaultWorkspace: workspace.path,
    containerId: `container-${Date.now()}`,
    defaultSessionId: null,
    createDefaultSession: false,
    startedAt: now,
    readyAt: now,
    createdAt: now,
    updatedAt: now,
  });

  return { controllerId: fake.controllerId, controllerName, workspaceId: workspace.id, username: user.username, fake };
}

test.describe('云电脑项目工作流模板', () => {
  test.skip(!HAS_MONGO, '需要 MONGODB_URI 直连云电脑夹具');

  test('E2E-RW1 工作流页签：合法模板可配置、不合法项标示原因、重新检测刷新', async ({ page }) => {
    const fixture = await setupCloudFixture(page);
    try {
      await loginViaUI(page, fixture.username);
      await page.goto(`/settings?controllerId=${fixture.controllerId}`);

      await expect(page.getByTestId('config-tab-workflow')).toBeVisible();
      await page.getByTestId('config-tab-workflow').click();

      await expect(page.getByTestId('repo-template-dev.json')).toContainText('项目开发流程');
      await expect(page.getByTestId('repo-template-dev.json').getByRole('button', { name: '配置' })).toBeVisible();
      await expect(page.getByTestId('repo-template-broken.json')).toContainText('不是合法的 JSON 文件');
      await expect(page.getByTestId('repo-template-broken.json').getByRole('button', { name: '配置' })).toHaveCount(0);

      await page.getByRole('button', { name: '重新检测' }).click();
      await expect(page.getByTestId('repo-template-dev.json')).toBeVisible();
    } finally {
      fixture.fake.disconnect();
    }
  });

  test('E2E-RW2 配置全流程：选模板 → 补 agentConfig → 提交 → 已配置列表出现（含来源路径）', async ({ page }) => {
    const fixture = await setupCloudFixture(page);
    try {
      await loginViaUI(page, fixture.username);
      await page.goto(`/settings?controllerId=${fixture.controllerId}`);
      await page.getByTestId('config-tab-workflow').click();

      await page.getByTestId('repo-template-dev.json').getByRole('button', { name: '配置' }).click();
      const dialog = page.getByTestId('configure-repo-workflow-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('工作流名称')).toHaveValue('项目开发流程');

      // 为 AI 节点选择 Harness 工具（模板预填时 agentConfig 为空）
      await dialog.getByLabel('技术方案 Harness 工具').click();
      await page.getByRole('option', { name: 'opencode', exact: true }).click();

      await dialog.getByRole('button', { name: '保存' }).click();
      await expect(dialog).toBeHidden({ timeout: 15000 });

      await expect(page.getByText('项目开发流程')).toBeVisible();
      await expect(page.getByText('.zag/workflow/templates/dev.json')).toBeVisible();
    } finally {
      fixture.fake.disconnect();
    }
  });

  test('E2E-RW5 零回归：非 cloud 控制器无「工作流」页签', async ({ page }) => {
    const user = await registerUser(page);
    const { rawKey } = await createControllerKey(page, user.token);
    const fake = await registerController(rawKey, { version: '2.18.0' });
    try {
      await loginViaUI(page, user.username);
      await page.goto(`/settings?controllerId=${fake.controllerId}`);
      await expect(page.getByTestId('config-tab-workspace')).toBeVisible();
      await expect(page.getByTestId('config-tab-workflow')).toHaveCount(0);
    } finally {
      fake.disconnect();
    }
  });
});
