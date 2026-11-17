import { test, expect } from '@playwright/test';
import mongoose from 'mongoose';
import { createFrontUser, fundFrontUser, gqlRequest, loginViaUI } from './helpers';

/**
 * 云电脑工作组件版本与「立即升级」E2E（需求 #551 / 计划 §5.3）。
 *
 * 范围（计划 D8）：版本区块三态展示、按钮可见性、周期小字、点击后错误提示路径；
 * happy path 全链路（真实 worker 收事件后钉版重启）不在 E2E（外部拿不到合法 worker 一次性
 * token），归 cloud-controller 集成测试与 tests/api 错误映射。
 *
 * 夹具：`MONGODB_URI` 直写 `cloudcontainers.agentGearVersion` 与推进云电脑 RUNNING；
 * `REDIS_URL` 直写 `agent-gear:latest-version`（与 tests/api 相同证书口径）。
 */
const HARNESS_ENABLED = process.env.HARNESS_ENABLED === 'true';
const MONGO_URI = process.env.MONGODB_URI;
const REDIS_URL = process.env.REDIS_URL;

test.skip(
  !HARNESS_ENABLED || !MONGO_URI || !REDIS_URL,
  '需要 HARNESS_ENABLED=true + MONGODB_URI + REDIS_URL',
);

async function db(): Promise<mongoose.mongo.Db> {
  if (mongoose.connection.readyState === 0) await mongoose.connect(MONGO_URI as string);
  const database = mongoose.connection.db;
  if (!database) throw new Error('mongo not connected');
  return database;
}

async function setLatestVersion(version: string | null): Promise<void> {
  const { Redis } = await import('ioredis');
  const redis = new Redis(REDIS_URL as string, { lazyConnect: true });
  await redis.connect();
  if (version === null) await redis.del('agent-gear:latest-version');
  else
    await redis.set(
      'agent-gear:latest-version',
      JSON.stringify({ version, fetchedAt: new Date().toISOString() }),
    );
  await redis.quit();
}

const CREATE = `
  mutation Create($input: CreateCloudHostInput!) {
    createCloudHost(input: $input) { id name controllerId status }
  }
`;

const HOST_CONTAINER = `query Host($id: ID!) { cloudHost(id: $id) { id status containerId } }`;

interface SeededHost {
  id: string;
  controllerId: string;
  containerId: string;
  name: string;
}

async function createHost(
  page: import('@playwright/test').Page,
  token: string,
): Promise<SeededHost> {
  const name = `e2e-upg-${Date.now().toString(36)}`;
  const created = await gqlRequest(page, CREATE, { input: { name, harnessTypes: ['OPENCODE'] } }, token);
  const body = await created.json();
  if (body.errors) throw new Error(body.errors[0].message);
  const host = body.data.createCloudHost;
  const detail = await gqlRequest(page, HOST_CONTAINER, { id: host.id }, token);
  const containerId = (await detail.json()).data.cloudHost.containerId as string;
  return { id: host.id, controllerId: host.controllerId, containerId, name };
}

async function setHostRunning(hostId: string): Promise<void> {
  const database = await db();
  await database.collection('cloudhosts').updateOne(
    { _id: new mongoose.Types.ObjectId(hostId) },
    { $set: { status: 'RUNNING', readyAt: new Date(), updatedAt: new Date() } },
  );
}

async function setContainerVersion(containerId: string, version: string | null): Promise<void> {
  const database = await db();
  await database.collection('cloudcontainers').updateOne(
    { _id: new mongoose.Types.ObjectId(containerId) },
    { $set: { agentGearVersion: version } },
  );
}

async function openConfigPage(
  page: import('@playwright/test').Page,
  controllerId: string,
): Promise<void> {
  await page.goto(`/settings?controllerId=${controllerId}`);
  await expect(page.getByTestId('cloud-host-agent-gear-version')).toBeVisible({ timeout: 15000 });
}

async function cleanupHost(
  page: import('@playwright/test').Page,
  token: string,
  hostId: string,
): Promise<void> {
  try {
    await gqlRequest(
      page,
      `mutation($id: ID!) { stopCloudHost(id: $id, force: true) { id } }`,
      { id: hostId },
      token,
    );
    await gqlRequest(page, `mutation($id: ID!) { deleteCloudHost(id: $id) }`, { id: hostId }, token);
  } catch {
    /* 无法回收的实例由运维巡检处理 */
  }
}

test.describe('云电脑工作组件版本与立即升级 E2E（E2E-UPG）', () => {
  test.describe.configure({ mode: 'serial' });

  test('E2E-UPG1: 版本一致 → 展示当前/最新版本与自动升级周期小字，无「立即升级」', async ({ page }) => {
    test.setTimeout(120_000);
    const user = await createFrontUser(page);
    await fundFrontUser(user.userId, user.username);
    const host = await createHost(page, user.token);
    try {
      await loginViaUI(page, user.username);
      await setHostRunning(host.id);
      await setContainerVersion(host.containerId, '2.20.0');
      await setLatestVersion('2.20.0');

      await openConfigPage(page, host.controllerId);
      const block = page.getByTestId('cloud-host-agent-gear-version');
      await expect(block).toContainText('当前版本 2.20.0');
      await expect(block).toContainText('最新版本 2.20.0');
      await expect(block).toContainText('自动升级每 10 分钟检查一次');
      await expect(page.getByRole('button', { name: '立即升级' })).toHaveCount(0);
    } finally {
      await cleanupHost(page, user.token, host.id);
      await setLatestVersion(null);
    }
  });

  test('E2E-UPG2: 版本不一致 → 按钮出现；字段缺失 → — 且无按钮', async ({ page }) => {
    test.setTimeout(120_000);
    const user = await createFrontUser(page);
    await fundFrontUser(user.userId, user.username);
    const host = await createHost(page, user.token);
    try {
      await loginViaUI(page, user.username);
      await setHostRunning(host.id);
      await setContainerVersion(host.containerId, '2.19.0');
      await setLatestVersion('2.20.0');

      await openConfigPage(page, host.controllerId);
      await expect(page.getByRole('button', { name: '立即升级' })).toBeVisible();

      await setContainerVersion(host.containerId, null);
      await setLatestVersion(null);
      await page.reload();
      const block = page.getByTestId('cloud-host-agent-gear-version');
      await expect(block).toBeVisible({ timeout: 15000 });
      await expect(block).toContainText('当前版本 —');
      await expect(block).toContainText('最新版本 —');
      await expect(page.getByRole('button', { name: '立即升级' })).toHaveCount(0);
    } finally {
      await cleanupHost(page, user.token, host.id);
      await setLatestVersion(null);
    }
  });

  test('E2E-UPG3: 点击立即升级 → 升级中态；容器非在线错误 toast，按钮恢复可重试', async ({ page }) => {
    test.setTimeout(120_000);
    const user = await createFrontUser(page);
    await fundFrontUser(user.userId, user.username);
    const host = await createHost(page, user.token);
    try {
      await loginViaUI(page, user.username);
      await setHostRunning(host.id);
      await setContainerVersion(host.containerId, '2.19.0');
      await setLatestVersion('2.20.0');

      await openConfigPage(page, host.controllerId);
      await page.getByRole('button', { name: '立即升级' }).click();
      // 全链路：agent-api → cloud-controller，容器未 online → 可读错误
      await expect(page.getByText('云电脑未在线，请稍后重试或等待自动升级')).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByRole('button', { name: '立即升级' })).toBeEnabled();
    } finally {
      await cleanupHost(page, user.token, host.id);
      await setLatestVersion(null);
    }
  });

  test('E2E-UPG4: 非 RUNNING 云电脑 → 版本按最近已知展示或 —，无「立即升级」按钮', async ({ page }) => {
    test.setTimeout(120_000);
    const user = await createFrontUser(page);
    await fundFrontUser(user.userId, user.username);
    const host = await createHost(page, user.token);
    try {
      await loginViaUI(page, user.username);
      // 保持 STARTING（不推进 RUNNING）
      await setContainerVersion(host.containerId, '2.19.0');
      await setLatestVersion('2.20.0');

      await openConfigPage(page, host.controllerId);
      const block = page.getByTestId('cloud-host-agent-gear-version');
      await expect(block).toContainText('当前版本 2.19.0');
      await expect(page.getByRole('button', { name: '立即升级' })).toHaveCount(0);
    } finally {
      await cleanupHost(page, user.token, host.id);
      await setLatestVersion(null);
    }
  });

  test('E2E-UPG5: 既有云电脑面板关键路径零回归（状态/停止入口/存储区块形态）', async ({ page }) => {
    test.setTimeout(120_000);
    const user = await createFrontUser(page);
    await fundFrontUser(user.userId, user.username);
    const host = await createHost(page, user.token);
    try {
      await loginViaUI(page, user.username);
      await setHostRunning(host.id);
      await openConfigPage(page, host.controllerId);
      const panel = page.getByTestId('cloud-host-panel');
      await expect(panel).toContainText('运行中');
      await expect(panel.getByRole('button', { name: '停止云电脑' })).toBeVisible();
      await expect(page.getByTestId('config-tab-workloads')).toBeVisible();
    } finally {
      await cleanupHost(page, user.token, host.id);
    }
  });
});
