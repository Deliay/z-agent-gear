import { test, expect, type Page } from '@playwright/test';
import mongoose from 'mongoose';
import { loginViaUI, registerUser } from './helpers';

/**
 * 云电脑 GitHub Issues 联动 —— E2E-33 / E2E-34 / E2E-37。
 *
 * fixture 驱动：直接写 Mongo 构造云电脑、已配置工作流与联动配置，
 * 避免依赖真实 K8s 与 GitHub App（标签同步/触发链路见 tests/api T-GHIL/T-GHI）。
 */
const HAS_MONGO = Boolean(process.env.MONGODB_URI);

async function mongoDb(): Promise<mongoose.mongo.Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
  return mongoose.connection.db ?? null;
}

interface Fixture {
  controllerId: mongoose.Types.ObjectId;
  username: string;
  cleanup: () => Promise<void>;
}

async function setupFixture(
  page: Page,
  options: {
    hostStatus?: 'RUNNING' | 'STOPPED';
    workflows: Array<{ name: string; human: boolean }>;
    linkages?: Array<{ labelName: string; repos: string[] }>;
  },
): Promise<Fixture> {
  const { username } = await registerUser(page);
  const db = (await mongoDb())!;
  const userDoc = await db.collection('users').findOne({ username });
  const userId = userDoc!._id;
  const now = new Date();
  const controllerId = new mongoose.Types.ObjectId();
  const hostId = new mongoose.Types.ObjectId();

  const workflowDocs = options.workflows.map((workflow) => ({
    _id: new mongoose.Types.ObjectId(),
    userId,
    controllerId,
    name: workflow.name,
    nodes: [
      {
        nodeKey: 'human',
        type: workflow.human ? 'HUMAN' : 'AI',
        name: workflow.name,
        stage: '默认阶段',
        dependsOn: [],
        requiresWorktree: false,
        linkUpstreamPullRequest: false,
      },
    ],
    createdBy: 'HUMAN',
    createdAt: now,
    updatedAt: now,
  }));

  await db.collection('controllers').insertOne({
    _id: controllerId,
    userId,
    name: `issues-${controllerId.toString()}`,
    hostname: `issues-${controllerId.toString()}`,
    type: 'cloud',
    status: 'offline',
    keyId: new mongoose.Types.ObjectId(),
    version: '2.5.0',
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('cloudhosts').insertOne({
    _id: hostId,
    userId,
    controllerId,
    name: `issues-host-${controllerId.toString()}`,
    status: options.hostStatus ?? 'RUNNING',
    harnessTypes: ['OPENCODE'],
    keyId: new mongoose.Types.ObjectId(),
    workspaceId: null,
    containerId: null,
    defaultSessionId: null,
    startedAt: now,
    readyAt: now,
    stoppedAt: options.hostStatus === 'STOPPED' ? now : null,
    failureReason: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  if (workflowDocs.length > 0) {
    await db.collection('configuredworkflows').insertMany(workflowDocs);
  }
  if (options.linkages?.length) {
    await db.collection('cloud_host_issues_linkages').insertMany(
      options.linkages.map((linkage, index) => ({
        userId,
        controllerId,
        configuredWorkflowId: workflowDocs[index]?._id ?? workflowDocs[0]?._id,
        configuredWorkflowName: workflowDocs[index]?.name ?? workflowDocs[0]?.name,
        labelName: linkage.labelName,
        labelNameLower: linkage.labelName.toLowerCase(),
        repoFullNames: linkage.repos,
        createdAt: now,
        updatedAt: now,
      })),
    );
  }

  return {
    controllerId,
    username,
    cleanup: async () => {
      await db.collection('cloud_host_issues_linkages').deleteMany({ controllerId });
      await db.collection('configuredworkflows').deleteMany({ controllerId });
      await db.collection('cloudhosts').deleteOne({ _id: hostId });
      await db.collection('controllers').deleteOne({ _id: controllerId });
    },
  };
}

test.describe('Cloud Host Issues linkage', () => {
  test.skip(!HAS_MONGO, '需要 MONGODB_URI 写入联动 fixture');

  test('E2E-33 配置列表与加配置弹窗（标签预填 + 同步提示）', async ({ page }) => {
    const fixture = await setupFixture(page, {
      workflows: [{ name: '开发流程', human: true }],
      linkages: [{ labelName: 'start-开发流程', repos: ['a/b', 'c/d'] }],
    });
    try {
      await loginViaUI(page, fixture.username);
      await page.goto(`/settings?controllerId=${fixture.controllerId.toString()}`);

      await page.getByTestId('config-tab-github').click();
      await expect(page.getByTestId('issues-linkage-section')).toBeVisible();
      await expect(page.getByText('start-开发流程')).toBeVisible();
      await expect(page.getByText('a/b')).toBeVisible();

      await page.getByRole('button', { name: '加Issue联动配置' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel('标签名')).toHaveValue('start-开发流程');
      await expect(dialog.getByTestId('issue-linkage-sync-hint')).toContainText('start-开发流程');
    } finally {
      await fixture.cleanup();
    }
  });

  test('E2E-34 无可用工作流 → 配置工作流入口且禁用保存', async ({ page }) => {
    const fixture = await setupFixture(page, {
      workflows: [{ name: '纯 AI 流程', human: false }],
    });
    try {
      await loginViaUI(page, fixture.username);
      await page.goto(`/settings?controllerId=${fixture.controllerId.toString()}`);

      await page.getByTestId('config-tab-github').click();
      await page.getByRole('button', { name: '加Issue联动配置' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText('暂无包含人类节点的工作流。')).toBeVisible();
      await expect(dialog.getByRole('button', { name: '配置工作流' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: '保存配置' })).toBeDisabled();
    } finally {
      await fixture.cleanup();
    }
  });

  test('E2E-37 销毁云电脑时出现标签清理询问（默认不清理）', async ({ page }) => {
    const fixture = await setupFixture(page, {
      hostStatus: 'STOPPED',
      workflows: [{ name: '开发流程', human: true }],
      linkages: [{ labelName: 'start-开发流程', repos: ['a/b'] }],
    });
    try {
      await loginViaUI(page, fixture.username);
      await page.goto(`/settings?controllerId=${fixture.controllerId.toString()}`);

      await page.getByRole('button', { name: '删除云电脑' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel('同时删除已同步到仓库的标签')).toBeVisible();
      await expect(dialog.getByText('同时删除已同步到仓库的标签（1 条配置）')).toBeVisible();

      await dialog.getByRole('button', { name: '确认删除' }).click();
      await expect(page.getByTestId('cloud-host-panel')).toHaveCount(0, { timeout: 15000 });
    } finally {
      await fixture.cleanup();
    }
  });
});
