import { test, expect } from '@playwright/test';
import { gqlRequest, loginViaUI, registerFundedUser } from './helpers';

// 云存储 E2E：设置页创建 → 新建云电脑挂载 → 停止归档（半价）→ 销毁 → 已销毁折叠区。
// K8S_ENABLED=false 下归档由 InMemory 实现完成；CLOUD_STORAGE_ENABLED=false 时整套跳过。
const HARNESS_ENABLED = process.env.HARNESS_ENABLED === 'true';
const STORAGE_ENABLED = process.env.CLOUD_STORAGE_ENABLED !== 'false';

const CREATE_STORAGE = `
  mutation CreateStorage($input: CreateCloudStorageInput!) {
    createCloudStorage(input: $input) { id name sizeGi status }
  }
`;
const DESTROY_STORAGE = `mutation Destroy($id: ID!) { destroyCloudStorage(id: $id) { id status } }`;
const STORAGE_STATUS = `query($id: ID!) { cloudStorage(id: $id) { id status hourlyCredits currentArchive { status } } }`;
const ATTACHABLE = `query { cloudStorages(onlyAttachable: true) { id name status } }`;
const CREATE_HOST = `
  mutation CreateHost($input: CreateCloudHostInput!) {
    createCloudHost(input: $input) { id name status storage { id status } }
  }
`;
const STOP_HOST = `mutation Stop($id: ID!, $force: Boolean) { stopCloudHost(id: $id, force: $force) { id status } }`;
const DELETE_HOST = `mutation Delete($id: ID!) { deleteCloudHost(id: $id) }`;

test.describe('Cloud Storage E2E', () => {
  test.skip(!HARNESS_ENABLED, 'HARNESS_ENABLED=false：云电脑入口关闭');
  test.skip(!STORAGE_ENABLED, 'CLOUD_STORAGE_ENABLED=false：云存储入口关闭');

  test('E2E-CS1/CS2: create → mount → archive → destroy → folded', async ({ page }) => {
    const { token, username } = await registerFundedUser(page);
    await loginViaUI(page, username);

    const storageName = `e2e-store-${Date.now().toString(36)}`;
    let storageId = '';
    let hostId = '';

    try {
      // 设置页入口可见并进入云存储区块
      await page.getByRole('button', { name: '设置' }).click();
      await page.getByRole('button', { name: '云存储', exact: true }).click();
      const section = page.getByTestId('cloud-storage-section');
      await expect(section).toBeVisible();

      // 创建 + 报价（全价 / 归档半价）
      await section.getByRole('button', { name: '新建云存储' }).first().click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: '新建云存储' })).toBeVisible();
      await dialog.locator('#cloud-storage-name').fill(storageName);
      await dialog.locator('#cloud-storage-size').fill('10');
      await expect(dialog.getByTestId('cloud-storage-quote')).toContainText('全价：5 credits/小时');
      await expect(dialog.getByTestId('cloud-storage-quote')).toContainText(
        '已归档半价：2.5 credits/小时',
      );
      await dialog.getByRole('button', { name: '创建云存储' }).click();
      await expect(section.getByText(storageName)).toBeVisible({ timeout: 15000 });
      await expect(section.getByText('待挂载')).toBeVisible();

      const listed = await (await gqlRequest(page, ATTACHABLE, undefined, token)).json();
      const created = (listed.data?.cloudStorages ?? []).find(
        (item: { name: string }) => item.name === storageName,
      );
      expect(created).toBeTruthy();
      storageId = created.id;

      // 挂载到云电脑
      const hostName = `e2e-cs-host-${Date.now().toString(36)}`;
      const hostRes = await gqlRequest(
        page,
        CREATE_HOST,
        { input: { name: hostName, harnessTypes: [], storageId } },
        token,
      );
      const hostBody = await hostRes.json();
      expect(hostBody.errors).toBeUndefined();
      hostId = hostBody.data.createCloudHost.id;
      expect(hostBody.data.createCloudHost.storage).toMatchObject({ id: storageId });

      // 已挂载存储不再出现在其他云电脑的可挂载下拉
      const afterMount = await (await gqlRequest(page, ATTACHABLE, undefined, token)).json();
      expect((afterMount.data?.cloudStorages ?? []).map((item: { id: string }) => item.id)).not.toContain(
        storageId,
      );

      // 设置页刷新后展示「已挂载」且无销毁入口
      await section.getByRole('button', { name: '云存储', exact: true }).click();
      await page.reload();
      await page.getByTestId('cloud-storage-section').getByText(storageName).waitFor({ timeout: 15000 });
      await expect(page.getByTestId('cloud-storage-section').getByText('已挂载')).toBeVisible();
      await expect(
        page.getByRole('button', { name: `销毁 ${storageName}` }),
      ).toHaveCount(0);

      // 停止云电脑 → 归档（已归档半价）
      await gqlRequest(page, STOP_HOST, { id: hostId, force: true }, token);
      let storageStatus = '';
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const statusRes = await (await gqlRequest(page, STORAGE_STATUS, { id: storageId }, token)).json();
        storageStatus = statusRes.data?.cloudStorage?.status ?? '';
        if (storageStatus === 'ARCHIVED' || storageStatus === 'ARCHIVING') break;
        await page.waitForTimeout(500);
      }
      expect(['ARCHIVING', 'ARCHIVED']).toContain(storageStatus);

      if (storageStatus === 'ARCHIVED') {
        const archived = await (await gqlRequest(page, STORAGE_STATUS, { id: storageId }, token)).json();
        expect(archived.data.cloudStorage.hourlyCredits).toBe(2.5);
        await expect(page.getByTestId('cloud-storage-section').getByText('已归档')).toBeVisible({
          timeout: 15000,
        });
      }

      // 销毁 → 进入「已销毁」折叠区（默认折叠，展开后可见）
      const destroyed = await (await gqlRequest(page, DESTROY_STORAGE, { id: storageId }, token)).json();
      expect(destroyed.errors).toBeUndefined();
      expect(destroyed.data.destroyCloudStorage.status).toBe('DESTROYED');

      await page.reload();
      const sectionAfter = page.getByTestId('cloud-storage-section');
      await expect(sectionAfter.getByText(storageName)).toHaveCount(0);
      const fold = sectionAfter.getByRole('button', { name: '已销毁' });
      await expect(fold).toHaveAttribute('aria-expanded', 'false');
      await fold.click();
      await expect(
        sectionAfter.getByTestId(`destroyed-cloud-storage-${storageId}`),
      ).toBeVisible();
    } finally {
      if (hostId) await gqlRequest(page, DELETE_HOST, { id: hostId }, token);
      if (storageId) await gqlRequest(page, DESTROY_STORAGE, { id: storageId }, token);
    }
  });
});
