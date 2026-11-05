import { test, expect, type Page } from '@playwright/test';
import { registerUser, loginViaUI, gqlRequest } from './helpers.js';

/**
 * 设置页「自定义 MCP」区块 E2E（E2E-CMCP，MCP+Valut Phase 5 / 计划测试矩阵）。
 *
 * 走真实后端（agent-api GraphQL）：
 * - 新增：无验证 / Bearer 两路径（填写 token 自建 → Valut service 条目；选择 manual 条目 → 仅引用）；
 * - 删除联动提示：自建 token 提示同时删除 Valut 条目、引用仅普通提示（API 断言级联/保留）；
 * - manual 引用编辑的「前往 Valut 编辑」穿透链接跳转并自动展开条目编辑对话框（D11）；
 * - 「MCP 代理」入口三处已移除（F8）且 MCP 管理区块零回归。
 * 契约：`contracts/custom-mcp.graphql` / `contracts/valut.graphql`；
 * UI：`apps/agent-web/src/components/settings/CustomMcpSection.tsx`。
 */

const CREATE_VALUT = `
  mutation CreateValutEntry($input: CreateValutEntryInput!) {
    createValutEntry(input: $input) { id namespace key editable deletable }
  }
`;

const DELETE_VALUT = `
  mutation DeleteValutEntry($id: ID!) { deleteValutEntry(id: $id) }
`;

const CREATE_CUSTOM_MCP = `
  mutation CreateCustomMcpServer($input: CreateCustomMcpServerInput!) {
    createCustomMcpServer(input: $input) { id name endpoint authType bearerEntryId bearerEntryManaged }
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
  await expect(page.locator('#custom-mcp-section')).toBeVisible({ timeout: 20000 });
  return { token, username };
}

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** 在区块内走「新增」对话框创建一个自定义 MCP。 */
async function createViaUi(
  page: Page,
  options: {
    name: string;
    endpoint: string;
    auth?: 'none' | 'bearer';
    bearerMode?: 'fill' | 'select';
    token?: string;
    selectLabel?: string;
    /** 「选择 token」下拉中不得出现的文案（如 service 条目 key = MCP 名）。 */
    forbiddenOption?: string;
  },
): Promise<void> {
  const section = page.locator('#custom-mcp-section');
  await section.getByRole('button', { name: '新增自定义 MCP' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '新增自定义 MCP' })).toBeVisible();
  await dialog.getByLabel('名称', { exact: true }).fill(options.name);
  await dialog.getByLabel('endpoint', { exact: true }).fill(options.endpoint);

  if (options.auth === 'bearer') {
    await dialog.getByRole('radio', { name: 'Bearer Token' }).check();
    if (options.bearerMode === 'select') {
      await dialog.getByRole('radio', { name: '选择 token' }).check();
      const select = dialog.getByLabel('密钥条目（仅自定义密钥）', { exact: true });
      await expect(select).toBeVisible();
      if (options.forbiddenOption) {
        await expect(select.locator('option', { hasText: options.forbiddenOption })).toHaveCount(0);
      }
      if (options.selectLabel) {
        await expect(select.locator('option', { hasText: options.selectLabel })).toHaveCount(1);
        await select.selectOption({ label: options.selectLabel });
      }
    } else {
      await dialog.getByLabel('Bearer token', { exact: true }).fill(options.token ?? '');
    }
  }

  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(page.getByText('自定义 MCP 已创建')).toBeVisible({ timeout: 15000 });
}

test.describe('Settings Custom MCP E2E', () => {
  test('E2E-CMCP1: 区块结构与新增（无验证）→ 列表展示名称 / endpoint / 验证方式', async ({ page }) => {
    const { token } = await openSettings(page);
    const section = page.locator('#custom-mcp-section');

    await expect(section.getByRole('heading', { name: '自定义 MCP', exact: true })).toBeVisible();
    await expect(section.getByText('工作区', { exact: true })).toBeVisible();
    await expect(section.getByText('经平台代理转发，真实地址与凭据不出服务端')).toBeVisible();
    const nav = page.locator('nav[aria-label="Settings navigation"]');
    await expect(nav.getByText('自定义 MCP', { exact: true })).toBeVisible();

    const suffix = uniqueSuffix();
    const name = `e2e-none-${suffix}`;
    const endpoint = `http://127.0.0.1:9/mcp-${suffix}`;
    await createViaUi(page, { name, endpoint });

    const item = section.locator('li').filter({ hasText: name });
    await expect(item).toBeVisible();
    await expect(item.getByText(endpoint)).toBeVisible();
    await expect(item.getByText('无验证')).toBeVisible();
    // 无验证条目 bearerEntryId=null → 无 Valut 联动
    const list = await gqlJson(page, `
      query CustomMcpServers { customMcpServers { id name authType bearerEntryId bearerEntryManaged } }
    `, undefined, token);
    expect(list.errors, JSON.stringify(list.errors)).toBeUndefined();
    const row = (list.data?.customMcpServers ?? []).find((entry: { name: string }) => entry.name === name);
    expect(row, '创建的自定义 MCP 应在服务端列表中').toBeTruthy();
    expect(row.authType).toBe('none');
    expect(row.bearerEntryId).toBeNull();
    expect(row.bearerEntryManaged).toBeNull();
  });

  test('E2E-CMCP2: 新增 Bearer 两路径（填写 token 自建 / 选择 manual 条目），token 与值全程不可见', async ({ page }) => {
    const { token, username } = await registerUser(page);

    // 先经 API 造一个 manual 条目供「选择 token」
    const suffix = uniqueSuffix();
    const manualKey = `e2e-pick-${suffix}`;
    const manualSecret = `E2E_PICK_SECRET_${suffix}`;
    const entry = await gqlJson(page, CREATE_VALUT, { input: { key: manualKey, value: manualSecret } }, token);
    expect(entry.errors, JSON.stringify(entry.errors)).toBeUndefined();
    const entryId = entry.data.createValutEntry.id as string;

    await loginViaUI(page, username);
    await page.goto('/settings');
    const section = page.locator('#custom-mcp-section');
    await expect(section).toBeVisible({ timeout: 20000 });

    // 路径 A：填写 token（自建，写入 Valut service 条目）
    const fillName = `e2e-fill-${suffix}`;
    const bearerToken = `E2E_BEARER_TOKEN_${suffix}`;
    await createViaUi(page, {
      name: fillName,
      endpoint: `http://127.0.0.1:9/mcp-fill-${suffix}`,
      auth: 'bearer',
      bearerMode: 'fill',
      token: bearerToken,
    });
    const fillItem = section.locator('li').filter({ hasText: fillName });
    await expect(fillItem).toBeVisible();
    await expect(fillItem.getByText('Bearer Token')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(bearerToken);

    // 路径 B：选择 token（引用 manual 条目；仅 manual 可选，service 条目 key=MCP 名不出现）
    const selectName = `e2e-select-${suffix}`;
    await createViaUi(page, {
      name: selectName,
      endpoint: `http://127.0.0.1:9/mcp-select-${suffix}`,
      auth: 'bearer',
      bearerMode: 'select',
      selectLabel: manualKey,
      forbiddenOption: fillName,
    });
    const selectItem = section.locator('li').filter({ hasText: selectName });
    await expect(selectItem).toBeVisible();
    await expect(selectItem.getByText('Bearer Token')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(manualSecret);
    await expect(page.locator('body')).not.toContainText(bearerToken);

    // 服务端联动：路径 A managed=true；路径 B 引用 manual（managed=false）
    const list = await gqlJson(page, `
      query CustomMcpServers { customMcpServers { id name authType bearerEntryId bearerEntryManaged } }
    `, undefined, token);
    expect(list.errors, JSON.stringify(list.errors)).toBeUndefined();
    const fillRow = list.data.customMcpServers.find((row: { name: string }) => row.name === fillName);
    expect(fillRow.bearerEntryManaged).toBe(true);
    expect(fillRow.bearerEntryId).toBeTruthy();
    const selectRow = list.data.customMcpServers.find((row: { name: string }) => row.name === selectName);
    expect(selectRow.bearerEntryManaged).toBe(false);
    expect(selectRow.bearerEntryId).toBe(entryId);

    // Valut 侧：service 条目不回显值；manual 条目仅 key 可见
    const valut = await gqlJson(page, VALUT_ENTRIES, undefined, token);
    expect(valut.errors, JSON.stringify(valut.errors)).toBeUndefined();
    const serialized = JSON.stringify(valut);
    expect(serialized).not.toContain(bearerToken);
    expect(serialized).not.toContain(manualSecret);
    expect(serialized).toContain(manualKey);

    // 清理
    for (const name of [fillName, selectName]) {
      const row = list.data.customMcpServers.find((entry: { name: string }) => entry.name === name);
      if (row) await gqlJson(page, DELETE_CUSTOM_MCP, { id: row.id }, token);
    }
    await gqlJson(page, DELETE_VALUT, { id: entryId }, token);
  });

  test('E2E-CMCP3: 删除二次确认 —— 自建 token 提示联动删除 Valut 条目，引用仅普通提示', async ({ page }) => {
    const { token, username } = await registerUser(page);

    const suffix = uniqueSuffix();
    const manualKey = `e2e-del-${suffix}`;
    const manualSecret = `E2E_DEL_SECRET_${suffix}`;
    const entry = await gqlJson(page, CREATE_VALUT, { input: { key: manualKey, value: manualSecret } }, token);
    expect(entry.errors, JSON.stringify(entry.errors)).toBeUndefined();
    const entryId = entry.data.createValutEntry.id as string;

    const managedName = `e2e-del-managed-${suffix}`;
    const managedToken = `E2E_DEL_TOKEN_${suffix}`;
    const managed = await gqlJson(
      page,
      CREATE_CUSTOM_MCP,
      { input: { name: managedName, endpoint: 'http://127.0.0.1:9/mcp-del', auth: { type: 'bearer', newToken: managedToken } } },
      token,
    );
    expect(managed.errors, JSON.stringify(managed.errors)).toBeUndefined();
    const managedId = managed.data.createCustomMcpServer.id as string;

    const refName = `e2e-del-ref-${suffix}`;
    const refMcp = await gqlJson(
      page,
      CREATE_CUSTOM_MCP,
      { input: { name: refName, endpoint: 'http://127.0.0.1:9/mcp-del2', auth: { type: 'bearer', existingEntryId: entryId } } },
      token,
    );
    expect(refMcp.errors, JSON.stringify(refMcp.errors)).toBeUndefined();
    const refId = refMcp.data.createCustomMcpServer.id as string;

    await loginViaUI(page, username);
    await page.goto('/settings');
    const section = page.locator('#custom-mcp-section');
    await expect(section).toBeVisible({ timeout: 20000 });

    // 自建 token：联动删除提示
    await section.getByRole('button', { name: `删除 ${managedName}` }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: '删除自定义 MCP' })).toBeVisible();
    await expect(
      dialog.getByText(`删除后不可恢复，且会同时删除关联的 Valut 自建 token 条目，确定删除「${managedName}」吗？`),
    ).toBeVisible();
    await expect(page.locator('body')).not.toContainText(managedToken);
    await dialog.getByRole('button', { name: '删除' }).click();
    await expect(page.getByText('自定义 MCP 已删除')).toBeVisible({ timeout: 15000 });
    await expect(section.locator('li').filter({ hasText: managedName })).toHaveCount(0);

    // 引用：普通提示（无联动文案）
    await section.getByRole('button', { name: `删除 ${refName}` }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: '删除自定义 MCP' })).toBeVisible();
    await expect(dialog.getByText(`删除后不可恢复，确定删除「${refName}」吗？`)).toBeVisible();
    await expect(dialog.getByText('同时删除关联的 Valut')).toHaveCount(0);
    await dialog.getByRole('button', { name: '删除' }).click();
    await expect(page.getByText('自定义 MCP 已删除')).toBeVisible({ timeout: 15000 });

    // API 断言：自建条目级联删除、manual 条目保留（ref 已解绑）
    const valut = await gqlJson(page, VALUT_ENTRIES, undefined, token);
    expect(valut.errors, JSON.stringify(valut.errors)).toBeUndefined();
    const serialized = JSON.stringify(valut);
    expect(serialized).not.toContain(managedName); // service 条目随 MCP 级联删除
    expect(serialized).not.toContain(managedToken);
    const manualGroup = valut.data.valutEntries.find((group: any) => group.namespace.name === 'manual');
    const kept = (manualGroup?.entries ?? []).find((row: { key: string }) => row.key === manualKey);
    expect(kept, '引用删除后 manual 条目应保留').toBeTruthy();
    expect(kept.refs).toEqual([]);

    // 清理
    const del = await gqlJson(page, DELETE_VALUT, { id: entryId }, token);
    expect(del.data?.deleteValutEntry).toBe(true);
  });

  test('E2E-CMCP4: manual 引用编辑展示「前往 Valut 编辑」穿透链接，跳转后自动展开条目编辑对话框', async ({ page }) => {
    const { token, username } = await registerUser(page);

    const suffix = uniqueSuffix();
    const manualKey = `e2e-punch-${suffix}`;
    const manualSecret = `E2E_PUNCH_SECRET_${suffix}`;
    const entry = await gqlJson(page, CREATE_VALUT, { input: { key: manualKey, value: manualSecret } }, token);
    expect(entry.errors, JSON.stringify(entry.errors)).toBeUndefined();
    const entryId = entry.data.createValutEntry.id as string;

    const refName = `e2e-punch-mcp-${suffix}`;
    const refMcp = await gqlJson(
      page,
      CREATE_CUSTOM_MCP,
      { input: { name: refName, endpoint: 'http://127.0.0.1:9/mcp-punch', auth: { type: 'bearer', existingEntryId: entryId } } },
      token,
    );
    expect(refMcp.errors, JSON.stringify(refMcp.errors)).toBeUndefined();
    const refId = refMcp.data.createCustomMcpServer.id as string;

    try {
      await loginViaUI(page, username);
      await page.goto('/settings');
      const section = page.locator('#custom-mcp-section');
      await expect(section).toBeVisible({ timeout: 20000 });

      await section.getByRole('button', { name: `编辑 ${refName}` }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: '编辑自定义 MCP' })).toBeVisible();
      // bearerEntryManaged=false → 落「选择 token」态，旧值不回显
      await expect(dialog.getByRole('radio', { name: '选择 token' })).toBeChecked();
      await expect(dialog.getByLabel('密钥条目（仅自定义密钥）', { exact: true })).toHaveValue(entryId);
      await expect(page.locator('body')).not.toContainText(manualSecret);

      const punchLink = dialog.getByRole('button', { name: '前往 Valut 编辑' });
      await expect(punchLink).toBeVisible();
      await punchLink.click();

      // D11：/settings?section=valut&entry=<id> → 自动展开该条目编辑对话框
      await expect(page).toHaveURL(/section=valut/);
      await expect(page).toHaveURL(new RegExp(`entry=${entryId}`));
      await expect(page.getByRole('heading', { name: '编辑条目' })).toBeVisible({ timeout: 20000 });
      await expect(page.locator('#valut-entry-key')).toHaveValue(manualKey);
      await expect(page.locator('#valut-entry-key')).toHaveAttribute('readonly', '');
      await expect(page.locator('#valut-entry-value')).toHaveValue('');
      await expect(page.locator('body')).not.toContainText(manualSecret);
    } finally {
      const delMcp = await gqlJson(page, DELETE_CUSTOM_MCP, { id: refId }, token);
      expect(delMcp.data?.deleteCustomMcpServer).toBe(true);
      const delEntry = await gqlJson(page, DELETE_VALUT, { id: entryId }, token);
      expect(delEntry.data?.deleteValutEntry).toBe(true);
    }
  });

  test('E2E-CMCP5: 「MCP 代理」入口三处已移除，MCP 管理区块零回归', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.goto('/settings');
    await expect(page.locator('#mcp-section')).toBeVisible({ timeout: 20000 });

    // 移除断言（F8：标题 / 导航组 / Proxy Key 区块与相关文案）
    await expect(page.getByRole('heading', { name: 'MCP 代理' })).toHaveCount(0);
    await expect(page.getByText('MCP 代理')).toHaveCount(0);
    await expect(page.getByText('MCP Proxy Keys')).toHaveCount(0);
    await expect(page.getByText('Generate Key')).toHaveCount(0);
    await expect(page.getByText(/No MCP proxy keys yet/)).toHaveCount(0);
    await expect(page.getByText(/使用 MCP 代理密钥注册/)).toHaveCount(0);

    // MCP 管理零回归
    await expect(page.locator('#mcp-section').getByRole('heading', { name: 'MCP 管理' })).toBeVisible();
    await expect(page.getByText('MCP 目录', { exact: true })).toBeVisible();
    await expect(page.getByText('agent-workflow-admin-tools')).toBeVisible({ timeout: 15000 });

    // 导航组与两项新入口
    const nav = page.locator('nav[aria-label="Settings navigation"]');
    await expect(nav.getByText('MCP', { exact: true })).toBeVisible();
    await expect(nav.getByText('MCP 管理', { exact: true })).toBeVisible();
    await expect(nav.getByText('Valut', { exact: true })).toBeVisible();
    await expect(nav.getByText('自定义 MCP', { exact: true })).toBeVisible();
  });
});
