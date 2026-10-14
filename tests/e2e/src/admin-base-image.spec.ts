import { test, expect, type Page } from '@playwright/test';
import { ADMIN_WEB_URL, adminGqlRequest, adminLoginApi, adminLoginViaUI } from './helpers.js';

const IMAGE_PREFIX = 'e2e-image-';
const DOCKERFILE = 'FROM node:22-alpine\nWORKDIR /app\nRUN echo hello\n';

async function cleanupImages(page: Page, token: string) {
  const res = await adminGqlRequest(page, `query { baseImages { id name } }`, undefined, token);
  const body = await res.json();
  const ids: string[] = (body.data?.baseImages ?? [])
    .filter((b: { name: string }) => b.name.startsWith(IMAGE_PREFIX))
    .map((b: { id: string }) => b.id);
  for (const id of ids) {
    await adminGqlRequest(page, `mutation($id: ID!) { deleteBaseImage(id: $id) }`, { id }, token);
  }
}

test.describe('Admin Base Image E2E', () => {
  test('should show the base image page and empty state', async ({ page }) => {
    const token = await adminLoginApi(page);
    await cleanupImages(page, token);

    await adminLoginViaUI(page);
    await page.getByRole('link', { name: /基础镜像/ }).click();
    await expect(page).toHaveURL(/\/base-images/);
    await expect(page.getByRole('heading', { name: '基础镜像' })).toBeVisible();
    await expect(page.getByText(/暂无基础镜像/)).toBeVisible();
  });

  test('should create a base image via the UI and delete it with confirmation (T-W4/T-E5)', async ({ page }) => {
    const token = await adminLoginApi(page);
    await cleanupImages(page, token);

    const name = `${IMAGE_PREFIX}${Date.now()}`;
    await adminLoginViaUI(page);
    await page.getByRole('link', { name: /基础镜像/ }).click();

    await page.getByRole('button', { name: '新建基础镜像' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('input').first().fill(name);
    await dialog.locator('textarea').first().fill(DOCKERFILE);
    await dialog.getByRole('button', { name: '保存' }).click();

    await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();

    // 删除二次确认
    await page.getByRole('button', { name: `删除 ${name}` }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await expect(page.getByRole('cell', { name, exact: true })).not.toBeVisible();
  });

  test('should reject a duplicate base image name (T-E5)', async ({ page }) => {
    const token = await adminLoginApi(page);
    await cleanupImages(page, token);

    const name = `${IMAGE_PREFIX}dup-${Date.now()}`;
    const first = await adminGqlRequest(page, `
      mutation($input: BaseImageInput!) { createBaseImage(input: $input) { id } }
    `, { input: { name, description: null, dockerfile: DOCKERFILE } }, token);
    expect((await first.json()).errors).toBeUndefined();

    const second = await adminGqlRequest(page, `
      mutation($input: BaseImageInput!) { createBaseImage(input: $input) { id } }
    `, { input: { name, description: null, dockerfile: DOCKERFILE } }, token);
    const secondBody = await second.json();
    expect(secondBody.errors).toBeDefined();
    expect(secondBody.errors[0].message).toBe('Base image name already exists');

    await cleanupImages(page, token);
  });
});
