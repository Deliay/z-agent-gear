import { test, expect } from '@playwright/test';
import mongoose from 'mongoose';
import { gqlRequest, loginViaUI, registerFundedUser } from './helpers';

// 云存储归档优化 E2E（Issue #434）：
// E2E-CSO1 停止对话框归档勾选（默认勾选/不勾选 → 待挂载）；
// E2E-CSO2 设置页「归档 / 复原到归档 / fork」三操作成功路径。
// K8S_ENABLED=false 无真实 worker/archiver：作业完成由测试经内部回调模拟（真实集群产生同一报文）。
const HARNESS_ENABLED = process.env.HARNESS_ENABLED === 'true';
const STORAGE_ENABLED = process.env.CLOUD_STORAGE_ENABLED !== 'false';
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN;
const MONGO_URI = process.env.MONGODB_URI;
const AGENT_BASE = (process.env.API_URL || 'http://localhost:10001/graphql').replace(
  /\/graphql\/?$/,
  '',
);

const sidebar = () => 'nav[aria-label="Sidebar"]';

async function expandHosts(page: import('@playwright/test').Page): Promise<void> {
  const header = page.locator(sidebar()).getByRole('button', { name: /^主机/ });
  const expanded = await header.getAttribute('aria-expanded');
  if (expanded === 'false') await header.click();
}

const CREATE_STORAGE = `
  mutation Create($input: CreateCloudStorageInput!) {
    createCloudStorage(input: $input) { id name sizeGi status }
  }
`;
const STORAGE_DETAIL = `
  query Storage($id: ID!) {
    cloudStorage(id: $id) {
      id name sizeGi status hourlyCredits hourlyCreditsFull
      currentArchive { id fileName status }
      currentRestore { id status }
    }
  }
`;
const CREATE_HOST = `
  mutation CreateHost($input: CreateCloudHostInput!) {
    createCloudHost(input: $input) { id name status containerId storage { id status } }
  }
`;
const STOP_HOST = `
  mutation Stop($id: ID!, $force: Boolean, $archiveStorage: Boolean) {
    stopCloudHost(id: $id, force: $force, archiveStorage: $archiveStorage) { id status }
  }
`;
const ARCHIVE_STORAGE = `mutation($id: ID!) { archiveCloudStorage(id: $id) { id status } }`;
const RESTORE_STORAGE = `mutation($id: ID!) { restoreCloudStorageToArchive(id: $id) { id status } }`;
const DESTROY_STORAGE = `mutation($id: ID!) { destroyCloudStorage(id: $id) { id status } }`;

async function mongo(): Promise<void> {
  if (mongoose.connection.readyState === 0) await mongoose.connect(MONGO_URI!);
}

async function storageById(id: string): Promise<any> {
  await mongo();
  return mongoose.connection
    .collection('cloudstorages')
    .findOne({ _id: new mongoose.Types.ObjectId(id) });
}

async function waitStorageStatus(
  page: import('@playwright/test').Page,
  token: string,
  id: string,
  expected: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let status = '';
  while (Date.now() < deadline) {
    const body = await (await gqlRequest(page, STORAGE_DETAIL, { id }, token)).json();
    status = body.data?.cloudStorage?.status ?? '';
    if (status === expected) return;
    await page.waitForTimeout(300);
  }
  expect(status).toBe(expected);
}

test.describe('Cloud Storage Archive Optimization E2E', () => {
  test.skip(!HARNESS_ENABLED, 'HARNESS_ENABLED=false：云电脑入口关闭');
  test.skip(!STORAGE_ENABLED, 'CLOUD_STORAGE_ENABLED=false：云存储入口关闭');
  test.skip(!INTERNAL_TOKEN, 'INTERNAL_API_TOKEN 缺失：无法模拟 ready/terminal/归档回调');
  test.skip(!MONGO_URI, 'MONGODB_URI 缺失：无法构造归档夹具/读取 operationId');

  test('E2E-CSO1: 停止对话框默认勾选归档；不勾选 → 存储回到待挂载（全价）', async ({ page }) => {
    const { token, username } = await registerFundedUser(page);
    await loginViaUI(page, username);

    const storageName = `e2e-noarchive-${Date.now().toString(36)}`;
    let storageId = '';
    let hostId = '';

    try {
      const createdStorage = await (
        await gqlRequest(page, CREATE_STORAGE, { input: { name: storageName, sizeGi: 10 } }, token)
      ).json();
      expect(createdStorage.errors).toBeUndefined();
      storageId = createdStorage.data.createCloudStorage.id;

      const createdHost = await (
        await gqlRequest(
          page,
          CREATE_HOST,
          {
            input: {
              name: `e2e-cso1-host-${Date.now().toString(36)}`,
              harnessTypes: ['OPENCODE'],
              storageId,
            },
          },
          token,
        )
      ).json();
      expect(createdHost.errors).toBeUndefined();
      hostId = createdHost.data.createCloudHost.id;

      const ready = await page.request.post(
        `${AGENT_BASE}/internal/cloud-hosts/${hostId}/ready`,
        { headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` }, data: {} },
      );
      expect(ready.status()).toBe(200);

      await page.reload();
      await expandHosts(page);
      const hostRow = page.locator(sidebar()).locator('li', {
        hasText: createdHost.data.createCloudHost.name,
      });
      await hostRow.getByTitle('控制器配置').click();
      await expect(page.getByTestId('cloud-host-panel')).toBeVisible();

      await page.getByRole('button', { name: '停止云电脑' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: '停止云电脑' })).toBeVisible();
      const archiveCheckbox = dialog.getByLabel('归档云存储');
      await expect(archiveCheckbox).toBeVisible();
      await expect(archiveCheckbox).toBeChecked();
      await archiveCheckbox.uncheck();
      await dialog.getByRole('button', { name: '继续停止' }).click();
      await expect(page.getByTestId('cloud-host-panel')).toContainText('已销毁', {
        timeout: 15_000,
      });

      // 云电脑跳过归档标记（destroy storageArchive:false）
      await mongo();
      const container = await mongoose.connection
        .collection('cloudcontainers')
        .findOne({ hostId });
      expect(container?.storageArchiveSkipped).toBe(true);

      // 模拟 terminal 回调（真实集群由 cloud-controller 投递同一报文）
      const terminal = await page.request.post(
        `${AGENT_BASE}/internal/cloud-hosts/${hostId}/terminal`,
        {
          headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
          data: {
            status: 'stopped',
            storage: { id: storageId, archiveStatus: null, archiveSkipped: true },
          },
        },
      );
      expect(terminal.status()).toBe(200);
      await waitStorageStatus(page, token, storageId, 'IDLE');

      const detail = await (await gqlRequest(page, STORAGE_DETAIL, { id: storageId }, token)).json();
      expect(detail.data.cloudStorage.hourlyCredits).toBe(
        detail.data.cloudStorage.hourlyCreditsFull,
      );
      expect(detail.data.cloudStorage.currentArchive ?? null).toBeNull();

      await page.reload();
      const section = page.getByTestId('cloud-storage-section');
      await expect(section.getByText(storageName)).toBeVisible({ timeout: 15_000 });
      await expect(section.getByText('待挂载')).toBeVisible();
    } finally {
      if (hostId) {
        await gqlRequest(
          page,
          `mutation($id: ID!) { deleteCloudHost(id: $id) }`,
          { id: hostId },
          token,
        ).catch(() => undefined);
      }
      if (storageId) {
        await gqlRequest(page, DESTROY_STORAGE, { id: storageId }, token).catch(() => undefined);
      }
    }
  });

  test('E2E-CSO2: 设置页 归档 / 复原到归档 / fork 三操作成功路径', async ({ page }) => {
    const { token, username } = await registerFundedUser(page);
    await loginViaUI(page, username);

    const storageName = `e2e-ops-${Date.now().toString(36)}`;
    let storageId = '';
    let forkId = '';

    try {
      const createdStorage = await (
        await gqlRequest(page, CREATE_STORAGE, { input: { name: storageName, sizeGi: 10 } }, token)
      ).json();
      expect(createdStorage.errors).toBeUndefined();
      storageId = createdStorage.data.createCloudStorage.id;

      // 构造 IDLE + SUCCEEDED 归档夹具（等价于「已归档 → 重新挂载 → 未归档停止」后的状态）。
      await mongo();
      const now = new Date();
      await mongoose.connection.collection('cloudstorages').updateOne(
        { _id: new mongoose.Types.ObjectId(storageId) },
        {
          $set: {
            status: 'IDLE',
            billingRate: 'FULL',
            currentArchive: {
              archiveId: 'e'.repeat(24),
              containerId: null,
              cloudHostId: null,
              cloudHostName: null,
              fileName: `${storageName}-20261102-100000.tar.gz2`,
              path: `/archive/${'a'.repeat(24)}/${storageId}/${storageName}-20261102-100000.tar.gz2`,
              status: 'SUCCEEDED',
              usageBytes: 4096,
              startedAt: now,
              finishedAt: now,
              failureReason: null,
              operationId: null,
            },
          },
        },
      );

      await page.getByRole('link', { name: 'Settings' }).click();
      await page.getByRole('button', { name: '云存储', exact: true }).click();
      const section = page.getByTestId('cloud-storage-section');
      await expect(section.getByText(storageName)).toBeVisible({ timeout: 15_000 });
      await expect(section.getByRole('button', { name: `归档 ${storageName}` })).toBeVisible();
      await expect(
        section.getByRole('button', { name: `复原到归档 ${storageName}` }),
      ).toBeVisible();
      await expect(section.getByRole('button', { name: `fork ${storageName}` })).toBeVisible();

      // 1) 复原到归档：二次确认 → 模拟 restores SUCCEEDED → IDLE
      await section.getByRole('button', { name: `复原到归档 ${storageName}` }).click();
      const restoreConfirm = page.getByRole('dialog');
      await expect(
        restoreConfirm.getByText(/当前内容将被丢弃并回滚到归档版本，不可恢复/),
      ).toBeVisible();
      await restoreConfirm.getByRole('button', { name: '确认复原' }).click();
      let doc = await storageById(storageId);
      const restoreOpId = doc?.currentRestore?.operationId;
      expect(restoreOpId).toMatch(/^[a-f0-9]{24}$/);
      const restoreCallback = await page.request.post(
        `${AGENT_BASE}/internal/cloud-storages/${storageId}/restores`,
        {
          headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
          data: { operationId: restoreOpId, storageId, status: 'SUCCEEDED', usageBytes: 4096 },
        },
      );
      expect(restoreCallback.status()).toBe(200);
      await waitStorageStatus(page, token, storageId, 'IDLE');

      // 2) 归档：确认 → 模拟 archives SUCCEEDED → ARCHIVED（半价）
      await page.reload();
      const sectionAfterRestore = page.getByTestId('cloud-storage-section');
      await expect(sectionAfterRestore.getByRole('button', { name: `归档 ${storageName}` })).toBeVisible({
        timeout: 15_000,
      });
      await sectionAfterRestore.getByRole('button', { name: `归档 ${storageName}` }).click();
      const archiveConfirm = page.getByRole('dialog');
      await expect(archiveConfirm.getByText(/归档后将释放数据卷并转为半价计费/)).toBeVisible();
      await archiveConfirm.getByRole('button', { name: '确认归档' }).click();
      doc = await storageById(storageId);
      const archiveOpId = doc?.currentArchive?.operationId;
      expect(archiveOpId).toMatch(/^[a-f0-9]{24}$/);
      const archiveCallback = await page.request.post(
        `${AGENT_BASE}/internal/cloud-storages/${storageId}/archives`,
        {
          headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
          data: {
            archiveId: doc.currentArchive.archiveId,
            operationId: archiveOpId,
            storageId,
            fileName: doc.currentArchive.fileName,
            path: doc.currentArchive.path,
            status: 'SUCCEEDED',
            usageBytes: 4096,
            sourcePvcReleased: true,
          },
        },
      );
      expect(archiveCallback.status()).toBe(200);
      await waitStorageStatus(page, token, storageId, 'ARCHIVED');

      // 3) fork：容量只读与报价 → 提交 → 模拟 restores SUCCEEDED → 新存储 IDLE
      await page.reload();
      const sectionArchived = page.getByTestId('cloud-storage-section');
      await sectionArchived.getByRole('button', { name: `fork ${storageName}` }).click();
      const forkDialog = page.getByRole('dialog');
      await expect(forkDialog.getByText('容量与源一致：10Gi（不可调整）')).toBeVisible();
      await expect(forkDialog.getByText(/创建成功即开始计费/)).toBeVisible();
      const forkName = `fork-${Date.now().toString(36)}`;
      await forkDialog.getByLabel('fork 云存储名称').fill(forkName);
      await forkDialog.getByRole('button', { name: '确认 fork' }).click();

      await mongo();
      const deadline = Date.now() + 15_000;
      let forkDoc: any = null;
      while (Date.now() < deadline) {
        forkDoc = await mongoose.connection.collection('cloudstorages').findOne({ name: forkName });
        if (forkDoc) break;
        await page.waitForTimeout(300);
      }
      expect(forkDoc).toBeTruthy();
      forkId = String(forkDoc._id);
      const forkOpId = forkDoc?.currentRestore?.operationId;
      expect(forkOpId).toMatch(/^[a-f0-9]{24}$/);
      const forkCallback = await page.request.post(
        `${AGENT_BASE}/internal/cloud-storages/${forkId}/restores`,
        {
          headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
          data: { operationId: forkOpId, storageId: forkId, status: 'SUCCEEDED' },
        },
      );
      expect(forkCallback.status()).toBe(200);
      await waitStorageStatus(page, token, forkId, 'IDLE');

      await page.reload();
      const sectionFinal = page.getByTestId('cloud-storage-section');
      await expect(sectionFinal.getByText(forkName)).toBeVisible({ timeout: 15_000 });
      await expect(sectionFinal.getByText('已归档')).toBeVisible();
    } finally {
      for (const id of [forkId, storageId]) {
        if (!id) continue;
        await gqlRequest(page, DESTROY_STORAGE, { id }, token).catch(() => undefined);
      }
    }
  });
});
