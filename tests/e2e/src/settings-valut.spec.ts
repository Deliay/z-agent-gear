import { test, expect, type Page } from '@playwright/test';
import { registerUser, loginViaUI, gqlRequest } from './helpers.js';

/**
 * 设置页 Valut 区块 E2E（E2E-VAL，MCP+Valut Phase 5 / 计划测试矩阵）。
 *
 * 走真实后端（agent-api GraphQL + 迁移 023 播种的 manual namespace）：
 * - 新增 / 编辑 / 删除全链路，**值全程不可见**（契约无 value 出参、编辑不回显旧值）；
 * - refs 展开（自定义 MCP 引用 manual 条目后可见 refLabel 与 feature）。
 * 契约：`contracts/valut.graphql`；UI：`apps/agent-web/src/components/settings/ValutSection.tsx`。
 */

const CREATE_VALUT = `
  mutation CreateValutEntry($input: CreateValutEntryInput!) {
    createValutEntry(input: $input) { id namespace key editable deletable refs { feature refId refLabel } }
  }
`;

const DELETE_VALUT = `
  mutation DeleteValutEntry($id: ID!) { deleteValutEntry(id: $id) }
`;

const CREATE_CUSTOM_MCP = `
  mutation CreateCustomMcpServer($input: CreateCustomMcpServerInput!) {
    createCustomMcpServer(input: $input) { id name bearerEntryId bearerEntryManaged }
  }
`;

const DELETE_CUSTOM_MCP = `
  mutation DeleteCustomMcpServer($id: ID!) { deleteCustomMcpServer(id: $id) }
`;

const VALUT_ENTRIES = `
  query ValutEntries {
    valutEntries {
      namespace { name displayName managed }
      entries { id namespace key editable deletable refs { feature refId refLabel } }
    }
  }
`;

async function gqlJson(
  page: Page,
  query: string,
  variables?: Record<string, unknown>,
  token?: string,
): Promise<any> {
  const res = await gqlRequest(page, query, variables, token);
  return res.json();
}

async function openSettings(page: Page): Promise<{ token: string; username: string }> {
  const { token, username } = await registerUser(page);
  await loginViaUI(page, username);
  await page.goto('/settings');
  await expect(page.locator('#valut-section')).toBeVisible({ timeout: 20000 });
  return { token, username };
}

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

test.describe('Settings Valut E2E', () => {
  test('E2E-VAL1: 新增 / 编辑 / 删除全链路，值全程不可见（编辑不回显旧值）', async ({ page }) => {
    const { token } = await openSettings(page);
    const section = page.locator('#valut-section');

    // 区块结构：标题 + 「工作区」badge + 只读提示 + 新增入口
    await expect(section.getByRole('heading', { name: 'Valut', exact: true })).toBeVisible();
    await expect(section.getByText('工作区', { exact: true })).toBeVisible();
    await expect(section.getByText('密钥值仅创建/编辑时填写，界面不展示')).toBeVisible();
    await expect(section.getByRole('button', { name: '新增条目' })).toBeVisible();
    const nav = page.locator('nav[aria-label="Settings navigation"]');
    await expect(nav.getByText('Valut', { exact: true })).toBeVisible();

    const suffix = uniqueSuffix();
    const key = `e2e-valut-${suffix}`;
    const secret = `E2E_VALUT_SECRET_${suffix}`;
    const rotated = `E2E_VALUT_ROTATED_${suffix}`;

    // 新增
    await section.getByRole('button', { name: '新增条目' }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: '新增条目' })).toBeVisible();
    await dialog.getByLabel('名称', { exact: true }).fill(key);
    await dialog.getByLabel('值', { exact: true }).fill(secret);
    await dialog.getByRole('button', { name: '创建' }).click();
    await expect(page.getByText('密钥条目已创建')).toBeVisible({ timeout: 15000 });

    // 列表出现条目，页面任何文本不含明文值
    const row = section.locator('li').filter({ hasText: key });
    await expect(row).toBeVisible();
    await expect(page.locator('body')).not.toContainText(secret);

    // 编辑：key 只读、value 空待重填（旧值不可见）
    await section.getByRole('button', { name: `编辑 ${key}` }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: '编辑条目' })).toBeVisible();
    await expect(dialog.getByLabel('名称', { exact: true })).toHaveValue(key);
    await expect(dialog.getByLabel('名称', { exact: true })).toHaveAttribute('readonly', '');
    await expect(dialog.getByLabel('值', { exact: true })).toHaveValue('');
    await expect(dialog.getByLabel('值', { exact: true })).toHaveAttribute(
      'placeholder',
      '输入新值（旧值不可见）',
    );
    await expect(page.locator('body')).not.toContainText(secret);

    await dialog.getByLabel('值', { exact: true }).fill(rotated);
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(page.getByText('密钥值已更新')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('body')).not.toContainText(secret);
    await expect(page.locator('body')).not.toContainText(rotated);

    // 删除（二次确认带条目名）
    await section.getByRole('button', { name: `删除 ${key}` }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: '删除密钥条目' })).toBeVisible();
    await expect(dialog.getByText(`删除后不可恢复，确定删除密钥「${key}」吗？`)).toBeVisible();
    await dialog.getByRole('button', { name: '删除' }).click();
    await expect(page.getByText('密钥条目已删除')).toBeVisible({ timeout: 15000 });
    await expect(section.locator('li').filter({ hasText: key })).toHaveCount(0);

    // 服务端确认已删除（列表不再包含该 key）
    const after = await gqlJson(page, VALUT_ENTRIES, undefined, token);
    expect(after.errors, JSON.stringify(after.errors)).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain(key);
  });

  test('E2E-VAL2: refs 展开（自定义 MCP 引用 manual 条目 → 引用 1 展示 refLabel 与 feature），值不可见', async ({ page }) => {
    const { token, username } = await registerUser(page);

    const suffix = uniqueSuffix();
    const key = `e2e-ref-${suffix}`;
    const secret = `E2E_REF_SECRET_${suffix}`;
    const mcpName = `e2e-ref-mcp-${suffix}`;

    const entry = await gqlJson(
      page,
      CREATE_VALUT,
      { input: { key, value: secret } },
      token,
    );
    expect(entry.errors, JSON.stringify(entry.errors)).toBeUndefined();
    const entryId = entry.data.createValutEntry.id as string;

    const mcp = await gqlJson(
      page,
      CREATE_CUSTOM_MCP,
      {
        input: {
          name: mcpName,
          endpoint: 'http://127.0.0.1:9/mcp',
          auth: { type: 'bearer', existingEntryId: entryId },
        },
      },
      token,
    );
    expect(mcp.errors, JSON.stringify(mcp.errors)).toBeUndefined();
    const mcpId = mcp.data.createCustomMcpServer.id as string;
    expect(mcp.data.createCustomMcpServer.bearerEntryManaged).toBe(false);

    try {
      await loginViaUI(page, username);
      await page.goto('/settings');
      const section = page.locator('#valut-section');
      await expect(section).toBeVisible({ timeout: 20000 });

      const row = section.locator('li').filter({ hasText: key });
      await expect(row).toBeVisible();
      // 行内按钮带 aria-label（可访问名 = 「查看 <key> 的引用」），正文为「引用 N」
      const refsButton = row.getByRole('button', { name: `查看 ${key} 的引用` });
      await expect(refsButton).toBeVisible();
      await expect(refsButton).toContainText('引用 1');
      await refsButton.click();

      // refs 展开：refLabel（MCP 名）+ feature
      await expect(row.getByText(mcpName)).toBeVisible();
      await expect(row.getByText('mcp-bearer-tokens', { exact: true })).toBeVisible();
      // 明文值全程不可见
      await expect(page.locator('body')).not.toContainText(secret);
    } finally {
      // 清理：删 MCP（仅解绑 ref）→ 删条目
      const delMcp = await gqlJson(page, DELETE_CUSTOM_MCP, { id: mcpId }, token);
      expect(delMcp.data?.deleteCustomMcpServer).toBe(true);
      const delEntry = await gqlJson(page, DELETE_VALUT, { id: entryId }, token);
      expect(delEntry.data?.deleteValutEntry).toBe(true);
    }
  });

  test('E2E-VAL3: 重名创建被服务端拒绝并映射中文提示（白名单错误透传）', async ({ page }) => {
    const { token, username } = await registerUser(page);

    const suffix = uniqueSuffix();
    const key = `e2e-dup-${suffix}`;
    const created = await gqlJson(page, CREATE_VALUT, { input: { key, value: `E2E_DUP_${suffix}` } }, token);
    expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
    const entryId = created.data.createValutEntry.id as string;

    try {
      await loginViaUI(page, username);
      await page.goto('/settings');
      const section = page.locator('#valut-section');
      await expect(section).toBeVisible({ timeout: 20000 });

      await section.getByRole('button', { name: '新增条目' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('名称', { exact: true }).fill(key);
      await dialog.getByLabel('值', { exact: true }).fill(`E2E_DUP2_${suffix}`);
      await dialog.getByRole('button', { name: '创建' }).click();

      // 服务端白名单 `valut key already exists` → 中文映射，对话框保持打开
      await expect(dialog.getByText('该密钥名称已存在')).toBeVisible({ timeout: 15000 });
      await expect(page.getByRole('dialog').getByRole('heading', { name: '新增条目' })).toBeVisible();
      // 列表不出现第二个同名条目（创建被拒）
      await expect(section.locator('li').filter({ hasText: key })).toHaveCount(1);
    } finally {
      const del = await gqlJson(page, DELETE_VALUT, { id: entryId }, token);
      expect(del.data?.deleteValutEntry).toBe(true);
    }
  });
});
