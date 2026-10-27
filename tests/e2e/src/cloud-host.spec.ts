import { test, expect } from '@playwright/test';
import { createWorkspace, loginViaUI, registerUser } from './helpers';

// 云电脑 E2E：K8S_ENABLED=false 下只能覆盖 STARTING → 停止 → 已销毁 → 删除。
// 在线/默认会话/只读消息由 tests/api 回调用例与真实集群手工验收覆盖。
const HARNESS_ENABLED = process.env.HARNESS_ENABLED === 'true';
const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';

function gqlRequest(page: import('@playwright/test').Page, query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return page.request.post(API_URL, { headers, data: { query, variables } });
}

const sidebar = () => 'nav[aria-label="Sidebar"]';

// 创建期不再预置默认工作区：需要读取 hasDefaultWorkspace/defaultSessionId 判定就绪后的行为
const HOST_FLAGS = `
  query {
    myCloudHosts { id name controllerId status defaultSessionId hasDefaultWorkspace }
  }
`;
const WORKSPACE_LIST = `query { workspaces { id controllerId path } }`;

async function hostWithFlags(
  page: import('@playwright/test').Page,
  token: string,
  name: string,
): Promise<{
  id: string;
  controllerId: string;
  status: string;
  defaultSessionId: string | null;
  hasDefaultWorkspace: boolean;
} | undefined> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await gqlRequest(page, HOST_FLAGS, undefined, token);
    const body = await response.json();
    if (body.errors) throw new Error(body.errors[0].message);
    const host = (body.data?.myCloudHosts ?? []).find((item: { name: string }) => item.name === name);
    if (host) return host;
    await page.waitForTimeout(1000);
  }
  return undefined;
}

test.describe('Cloud Host E2E', () => {
  test.skip(!HARNESS_ENABLED, 'HARNESS_ENABLED=false：云电脑入口关闭');

  test('E2E-39/41: 收费详情展示且余额不足不前置禁用创建', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);
    await expect(page.locator(sidebar())).toBeVisible();

    await page.getByRole('button', { name: '新建云电脑' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('收费详情')).toBeVisible();
    await expect(dialog.getByText(/创建花费：/)).toBeVisible();
    await expect(dialog.getByText(/运行消费：/)).toBeVisible();
    await expect(dialog.getByText('余额不足持续 10 分钟云电脑将被强制销毁')).toBeVisible();

    await dialog.locator('#cloud-host-name').fill(`e2e-quote-${Date.now().toString(36)}`);
    await dialog.getByRole('checkbox', { name: 'OpenCode' }).check();
    await expect(dialog.getByRole('button', { name: '创建云电脑' })).toBeEnabled();
  });

  test('T-AW2..T-AW9: create → starting → stop → stopped → delete', async ({ page }) => {
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);
    await expect(page.locator(sidebar())).toBeVisible();

    const hostName = `e2e-cloud-${Date.now().toString(36)}`;

    try {
      await page.getByRole('button', { name: '新建云电脑' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: '新建云电脑' })).toBeVisible();

      // 名称必填 + harness 必选；本期无存储/会话导入参数
      const createButton = dialog.getByRole('button', { name: '创建云电脑' });
      await expect(createButton).toBeDisabled();
      await expect(dialog.getByText('存储会话')).toHaveCount(0);
      await expect(dialog.getByText('恢复的会话')).toHaveCount(0);

      await dialog.locator('#cloud-host-name').fill('   ');
      await expect(createButton).toBeDisabled();
      await expect(dialog.getByText('请输入云电脑名称')).toBeVisible();

      await dialog.locator('#cloud-host-name').fill(hostName);
      // T-E-HL7 / T-E-DS1：Kimi Code / DeepSeek Harness 与 OpenCode 均可选、可多选（多选提示「不自动创建会话」）
      const kimi = dialog.getByRole('checkbox', { name: 'Kimi Code' });
      await expect(kimi).toBeVisible({ timeout: 15000 });
      await expect(dialog.getByRole('checkbox', { name: 'OpenCode' })).toBeVisible();
      const deepseek = dialog.getByRole('checkbox', { name: 'DeepSeek Harness' });
      await expect(deepseek).toBeVisible({ timeout: 15000 });
      await dialog.getByRole('checkbox', { name: 'OpenCode' }).check();
      await kimi.check();
      await deepseek.check();
      await expect(dialog.getByText('不自动创建会话')).toBeVisible();
      await kimi.uncheck();
      await deepseek.uncheck();

      await expect(
        dialog.getByText('就绪后不会自动创建会话，需先创建或绑定工作区'),
      ).toBeVisible();

      // 预装工作负载来自 cloudHostWorkloadCatalog（迁移 001/002/007 seed）
      await expect(dialog.getByText('预装工作负载（可选）')).toBeVisible();
      for (const name of ['Aspire', 'Docker', '.NET']) {
        await expect(dialog.getByRole('checkbox', { name, exact: true })).toBeVisible({
          timeout: 15000,
        });
      }
      await expect(dialog.getByText('依赖：Docker、.NET')).toBeVisible();
      await dialog.getByRole('checkbox', { name: 'Docker', exact: true }).check();
      await expect(dialog.getByText('勾选运行环境负载会延长首次就绪时间')).toBeVisible();

      await expect(createButton).toBeEnabled();
      await createButton.click();

      await expect(page.locator(sidebar()).getByText(hostName, { exact: true })).toBeVisible({
        timeout: 15000,
      });
      const controllerRow = page.locator(sidebar()).locator('li', { hasText: hostName });
      await expect(controllerRow.getByTestId('cloud-host-icon')).toBeVisible();
      await expect(controllerRow.getByTestId('cloud-host-status')).toHaveText('启动中');

      await controllerRow.getByTitle('控制器配置').click();
      await expect(page).toHaveURL(/\/settings\?controllerId=/);
      await expect(page.getByTestId('cloud-host-panel')).toBeVisible();
      await expect(page.getByTestId('cloud-host-panel')).toContainText('启动中');
      // 工作区 + Harness 工具两栏与普通主机一致
      await expect(page.getByTestId('config-tab-workspace')).toBeVisible();
      await expect(page.getByTestId('config-tab-harness')).toBeVisible();

      // 无活动会话：直接停止（不弹告警）
      await page.getByRole('button', { name: '停止云电脑' }).click();
      await expect(page.getByTestId('cloud-host-panel')).toContainText('已销毁', { timeout: 15000 });
      await expect(page.getByText('停止云主机会导致所有会话永久丢失，是否继续')).toHaveCount(0);
      await expect(page.getByRole('button', { name: '停止云电脑' })).toHaveCount(0);

      // 终态才允许删除
      await page.getByRole('button', { name: '删除云电脑' }).click();
      await expect(page.getByRole('heading', { name: '删除云电脑' })).toBeVisible();
      await page.getByRole('button', { name: '确认删除' }).click();
      await expect(page.getByTestId('cloud-host-panel')).toHaveCount(0, { timeout: 15000 });
      await expect(page.locator(sidebar()).getByText(hostName, { exact: true })).toHaveCount(0, {
        timeout: 15000,
      });
    } finally {
      // 兜底清理放在 finally：任一断言失败也不会遗留云电脑（先停后删）
      const hosts = await gqlRequest(
        page,
        `query { myCloudHosts { id name } }`,
        undefined,
        token,
      ).then((res) => res.json());
      const leftover = hosts.data?.myCloudHosts?.find(
        (host: { name: string }) => host.name === hostName,
      );
      if (leftover) {
        // R2-23：stop/delete 任一步失败都继续尝试后续步骤，避免残留主机
        try {
          await gqlRequest(
            page,
            `mutation($id: ID!) { stopCloudHost(id: $id, force: true) { id } }`,
            { id: leftover.id },
            token,
          );
        } catch {
          /* 已停止或控制面不可用：继续尝试删除 */
        }
        try {
          await gqlRequest(page, `mutation($id: ID!) { deleteCloudHost(id: $id) }`, { id: leftover.id }, token);
        } catch {
          /* 删除失败无法进一步回收：保留日志由运维巡检处理 */
        }
      }
    }
  });

  test('T-AW3/T-AW5: surfaces server validation errors', async ({ page }) => {
    const { username } = await registerUser(page);
    await loginViaUI(page, username);

    await page.getByRole('button', { name: '新建云电脑' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#cloud-host-name').fill('x'.repeat(65));
    await dialog.getByRole('checkbox', { name: 'OpenCode' }).check();
    await expect(dialog.getByText('名称不能超过 64 个字符')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '创建云电脑' })).toBeDisabled();
  });

  test('E2E-1: 普通创建不预置默认工作区、不自动建会话并展示无工作区提示', async ({ page }) => {
    // 缺参显式跳过，而不是在用例内部静默绕过核心断言
    test.skip(!process.env.INTERNAL_API_TOKEN, 'E2E-1 需要 INTERNAL_API_TOKEN 驱动 ready 回调');
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);
    await expect(page.locator(sidebar())).toBeVisible();

    const hostName = `e2e-nows-${Date.now().toString(36)}`;
    let hostId = '';

    try {
      await page.getByRole('button', { name: '新建云电脑' }).click();
      const dialog = page.getByRole('dialog');
      // 「创建默认工作区」勾选项已舍弃：创建期一律不预置 /home/worker/workspace
      await expect(dialog.getByRole('checkbox', { name: /创建默认工作区/ })).toHaveCount(0);

      await dialog.locator('#cloud-host-name').fill(hostName);
      await dialog.getByRole('checkbox', { name: 'OpenCode' }).check();
      // 单 Harness 选中后才展示「不自动建会话」提示（与 UI 条件一致）
      await expect(
        dialog.getByText('就绪后不会自动创建会话，需先创建或绑定工作区'),
      ).toBeVisible();
      await dialog.getByRole('button', { name: '创建云电脑' }).click();

      const controllerRow = page.locator(sidebar()).locator('li', { hasText: hostName });
      await expect(controllerRow).toBeVisible({ timeout: 15000 });

      const host = await hostWithFlags(page, token, hostName);
      expect(host, 'created cloud host should be listed').toBeTruthy();
      hostId = host!.id;
      expect(host!.hasDefaultWorkspace).toBe(false);
      expect(host!.defaultSessionId).toBeNull();

      const wsRes = await gqlRequest(page, WORKSPACE_LIST, undefined, token);
      const workspaces = ((await wsRes.json()).data?.workspaces ?? []).filter(
        (workspace: { controllerId: string }) => workspace.controllerId === host!.controllerId,
      );
      expect(workspaces).toEqual([]);

      // 驱动真实 ready 回调（K8s 关闭的本地链路），核心断言不得静默跳过
      const ready = await page.request.post(`${API_BASE}/internal/cloud-hosts/${hostId}/ready`, {
        headers: { Authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}` },
      });
      expect(ready.ok(), 'ready callback should succeed').toBe(true);

      // 重新拉取首页数据，避免依赖侧栏轮询时机
      await page.reload();
      await expect(page.locator(sidebar())).toBeVisible();
      await expect(controllerRow.getByTestId('cloud-host-no-workspace-hint')).toHaveText(
        '未创建默认工作区，请先创建或绑定工作区',
        { timeout: 15000 },
      );
      await expect(controllerRow.getByTestId('cloud-host-default-session-hint')).toHaveCount(0);
      const running = await hostWithFlags(page, token, hostName);
      expect(running?.status).toBe('RUNNING');
      expect(running?.defaultSessionId).toBeNull();

      // 无默认工作区时预填 ~/workspace（服务端展开为 /home/worker/workspace）
      await controllerRow.getByLabel('Github 项目设置').click();
      const githubDialog = page.getByRole('dialog');
      await expect(githubDialog.getByLabel('前缀地址')).toHaveValue('~/workspace');
      await expect(githubDialog.getByLabel('前缀地址')).toHaveAttribute(
        'placeholder',
        '例如：~/workspace',
      );
      await githubDialog.getByRole('button', { name: '取消' }).click();

      // E2E-2：入口迁移——工作负载页签无入口，Github 页签可发起设置
      await page.goto(`/settings?controllerId=${host!.controllerId}`);
      await page.getByRole('button', { name: '工作负载' }).click();
      await expect(page.getByRole('button', { name: 'Github 项目设置' })).toHaveCount(0);
      await page.getByTestId('config-tab-github').click();
      await expect(page.getByRole('button', { name: 'Github 项目设置' })).toBeVisible();
      await page.goto('/');
      await expect(page.locator(sidebar())).toBeVisible();

      // 添加工作区后，无工作区提示随「控制器已有工作区」条件消失，并可发起新建会话。
      // 说明：真实 GitHub 绑定与完整开工链路（在线 worker/controller）需外部账号与真实集群，
      // 本地 K8S_ENABLED=false 仅覆盖到「工作区添加 + 新建会话入口可用」，其余由真实集群手工验收。
      await createWorkspace(page, host!.controllerId, '/home/worker/workspace', token);
      const afterWorkspace = await gqlRequest(page, WORKSPACE_LIST, undefined, token);
      expect(
        ((await afterWorkspace.json()).data?.workspaces ?? []).some(
          (workspace: { controllerId: string; path: string }) =>
            workspace.controllerId === host!.controllerId && workspace.path === '/home/worker/workspace',
        ),
      ).toBe(true);
      await page.reload();
      await expect(page.locator(sidebar())).toBeVisible();
      await expect(controllerRow.getByTestId('cloud-host-no-workspace-hint')).toHaveCount(0);
      await controllerRow.getByLabel('新建会话').click();
      await expect(page.getByRole('heading', { name: '新建会话' })).toBeVisible();
      await page.keyboard.press('Escape');
    } finally {
      if (hostId) await cleanupHost(page, token, hostName);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 10：新建云电脑 Github 项目前端编排（四阶段进度、失败重试、旧入口零回归）
// 真实 clone/工作负载需要运行中的 worker；此处用 Mongo fixture 推进云电脑状态与
// operation 终态，覆盖前端编排与进度框交互。待验收环境执行。
// ---------------------------------------------------------------------------
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGODB_URI;
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN;
const API_BASE = API_URL.replace(/\/graphql\/?$/, '');

async function phase10Db(): Promise<mongoose.mongo.Db | null> {
  if (!MONGO_URI) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(MONGO_URI);
  return mongoose.connection.db ?? null;
}

async function getMe(page: import('@playwright/test').Page, token: string): Promise<string> {
  const res = await gqlRequest(page, `query { me { id } }`, undefined, token);
  const body = await res.json();
  return body.data.me.id as string;
}

async function myHost(
  page: import('@playwright/test').Page,
  token: string,
  name: string,
): Promise<{ id: string; controllerId: string; status: string } | null> {
  const res = await gqlRequest(page, `query { myCloudHosts { id name controllerId status } }`, undefined, token);
  const body = await res.json();
  return (body.data?.myCloudHosts ?? []).find((item: { name: string }) => item.name === name) ?? null;
}

async function waitForHost(
  page: import('@playwright/test').Page,
  token: string,
  name: string,
  timeoutMs = 20000,
): Promise<{ id: string; controllerId: string; status: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const host = await myHost(page, token, name);
    if (host) return host;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`cloud host not found: ${name}`);
}

async function seedGithub(page: import('@playwright/test').Page, userId: string): Promise<void> {
  const db = (await phase10Db())!;
  const accountId = new mongoose.Types.ObjectId();
  await db.collection('githubaccounts').insertOne({
    _id: accountId,
    userId,
    // GraphQL Int 为 32 位；Date.now() 会溢出导致 githubAccounts 查询整体报错
    githubUserId: 20261024,
    githubLogin: 'phase10-owner',
    accessToken: 'encrypted-token',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.collection('githubinstallations').insertOne({
    _id: new mongoose.Types.ObjectId(),
    accountId,
    // installationId 全局唯一且为 32 位 Int：取 10 位随机数避免唯一索引冲突
    installationId: 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000),
    accountLogin: 'phase10-owner',
    accountType: 'User',
    repos: [
      {
        repoId: 10,
        repoName: 'repo',
        fullName: 'phase10-owner/repo',
        private: false,
        permissions: { read: true, write: true },
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function setHostRunning(hostId: string): Promise<void> {
  const db = (await phase10Db())!;
  await db.collection('cloudhosts').updateOne(
    { _id: new mongoose.Types.ObjectId(hostId) },
    { $set: { status: 'RUNNING', readyAt: new Date(), updatedAt: new Date() } },
  );
}

async function operationFor(controllerId: string): Promise<any | null> {
  const db = (await phase10Db())!;
  return db.collection('cloud_host_setup_operations').findOne(
    { controllerId: new mongoose.Types.ObjectId(controllerId) },
    { sort: { createdAt: -1 } },
  );
}

async function waitForOperation(controllerId: string, timeoutMs = 20000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const operation = await operationFor(controllerId);
    if (operation) return operation;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('setup operation not created');
}

async function seedProjectSession(
  userId: string,
  controllerId: string,
  controllerName: string,
): Promise<string> {
  const db = (await phase10Db())!;
  const sessionId = new mongoose.Types.ObjectId();
  await db.collection('sessions').insertOne({
    _id: sessionId,
    userId: new mongoose.Types.ObjectId(userId),
    controllerId: new mongoose.Types.ObjectId(controllerId),
    controllerName,
    acpServerType: 'opencode',
    status: 'idling',
    title: 'phase10/repo',
    cwd: '/home/worker/workspace/phase10-owner/repo',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return sessionId.toString();
}

async function markOperationSucceeded(operationId: string, sessionId: string): Promise<void> {
  const db = (await phase10Db())!;
  await db.collection('cloud_host_setup_operations').updateOne(
    { _id: new mongoose.Types.ObjectId(operationId) },
    {
      $set: {
        status: 'SUCCEEDED',
        sessionId: new mongoose.Types.ObjectId(sessionId),
        error: null,
        updatedAt: new Date(),
        steps: [
          { key: 'workload', status: 'SUCCEEDED', detail: 'Github 工作负载已就绪' },
          { key: 'gitSetup', status: 'SUCCEEDED', detail: null },
          { key: 'session', status: 'SUCCEEDED', detail: null },
        ],
      },
    },
  );
  await db.collection('cloudhosts').updateOne(
    { controllerId: new mongoose.Types.ObjectId((await operationById(operationId)).controllerId) },
    { $set: { defaultSessionId: new mongoose.Types.ObjectId(sessionId) } },
  );
}

async function operationById(operationId: string): Promise<any> {
  const db = (await phase10Db())!;
  return db.collection('cloud_host_setup_operations').findOne({
    _id: new mongoose.Types.ObjectId(operationId),
  });
}

async function markOperationFailed(operationId: string): Promise<void> {
  const db = (await phase10Db())!;
  await db.collection('cloud_host_setup_operations').updateOne(
    { _id: new mongoose.Types.ObjectId(operationId) },
    {
      $set: {
        status: 'FAILED',
        error: 'git clone failed',
        updatedAt: new Date(),
        steps: [
          { key: 'workload', status: 'SUCCEEDED', detail: 'Github 工作负载已就绪' },
          { key: 'gitSetup', status: 'FAILED', detail: 'git clone failed' },
          { key: 'session', status: 'PENDING', detail: null },
        ],
      },
    },
  );
}

async function cleanupHost(
  page: import('@playwright/test').Page,
  token: string,
  name: string,
): Promise<void> {
  const host = await myHost(page, token, name);
  if (!host) return;
  try {
    await gqlRequest(page, `mutation($id: ID!) { stopCloudHost(id: $id, force: true) { id } }`, { id: host.id }, token);
  } catch {
    /* 已停止/控制面不可用：继续删除 */
  }
  try {
    await gqlRequest(page, `mutation($id: ID!) { deleteCloudHost(id: $id) }`, { id: host.id }, token);
  } catch {
    /* 无法回收的实例由运维巡检处理 */
  }
}

test.describe('Cloud Host Github project provisioning E2E (Phase 10)', () => {
  test.skip(!HARNESS_ENABLED, 'HARNESS_ENABLED=false：云电脑入口关闭');

  test('P10-CH1: 未选项目 → 不弹四阶段进度框，就绪后不预置工作区/不自动建会话（phase2 零回归）', async ({ page }) => {
    test.skip(!MONGO_URI || !INTERNAL_TOKEN, '需要 MONGODB_URI + INTERNAL_API_TOKEN');
    test.setTimeout(90_000);
    const { token, username } = await registerUser(page);
    const userId = await getMe(page, token);
    await loginViaUI(page, username);
    const name = `e2e-p10-legacy-${Date.now().toString(36)}`;

    try {
      await page.getByRole('button', { name: '新建云电脑' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('#cloud-host-name').fill(name);
      await dialog.getByRole('checkbox', { name: 'OpenCode' }).check();
      await expect(
        dialog.getByText('就绪后不会自动创建会话，需先创建或绑定工作区'),
      ).toBeVisible();
      await expect(dialog.getByRole('checkbox', { name: '配置 Github 项目' })).not.toBeChecked();
      await dialog.getByRole('button', { name: '创建云电脑' }).click();

      // 旧入口不进入前端编排：不出现「设置进度」四阶段对话框
      await expect(page.locator(sidebar()).getByText(name, { exact: true })).toBeVisible({ timeout: 15000 });
      await expect(page.getByRole('heading', { name: '设置进度' })).toHaveCount(0);

      const host = await waitForHost(page, token, name);
      const ready = await page.request.post(`${API_BASE}/internal/cloud-hosts/${host.id}/ready`, {
        headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
      });
      expect(ready.status()).toBe(200);

      // phase2：workspaceId 为 null → 不创建默认工作区、也不自动创建默认会话
      const db = (await phase10Db())!;
      const deadline = Date.now() + 15000;
      let hostDoc: any = null;
      while (Date.now() < deadline) {
        hostDoc = await db.collection('cloudhosts').findOne({
          _id: new mongoose.Types.ObjectId(host.id),
        });
        if (hostDoc?.status === 'RUNNING') break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(hostDoc?.status).toBe('RUNNING');
      expect(hostDoc?.workspaceId ?? null).toBeNull();
      expect(hostDoc?.defaultSessionId ?? null).toBeNull();
      const sessions = await db.collection('sessions').countDocuments({
        controllerId: new mongoose.Types.ObjectId(host.controllerId),
      });
      expect(sessions).toBe(0);

      await page.reload();
      const controllerRow = page.locator(sidebar()).locator('li', { hasText: name });
      await expect(controllerRow).toBeVisible({ timeout: 15000 });
      await expect(controllerRow.getByTestId('cloud-host-no-workspace-hint')).toHaveText(
        '未创建默认工作区，请先创建或绑定工作区',
      );
      await expect(controllerRow.getByTestId('cloud-host-default-session-hint')).toHaveCount(0);
    } finally {
      await cleanupHost(page, token, name);
    }
  });

  test('P10-CH2: 选项目 → 四阶段进度，成功后进入项目会话且无空默认会话', async ({ page }) => {
    test.skip(!MONGO_URI, '需要 MONGODB_URI');
    test.setTimeout(120_000);
    const { token, username } = await registerUser(page);
    const userId = await getMe(page, token);
    await seedGithub(page, userId);
    // 自检：seed 后 GraphQL 必须能读到账号与仓库（集合名/userId 类型问题在此暴露）
    const accountsCheck = await gqlRequest(
      page,
      `query { githubAccounts { githubLogin installations { repos { fullName } } } }`,
      undefined,
      token,
    );
    const accountsBody = await accountsCheck.json();
    expect(accountsBody.errors).toBeUndefined();
    expect(accountsBody.data.githubAccounts).toHaveLength(1);
    expect(accountsBody.data.githubAccounts[0].installations[0].repos[0].fullName).toBe(
      'phase10-owner/repo',
    );
    await loginViaUI(page, username);
    const name = `e2e-p10-project-${Date.now().toString(36)}`;

    try {
      await page.getByRole('button', { name: '新建云电脑' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('#cloud-host-name').fill(name);
      await dialog.getByRole('checkbox', { name: 'OpenCode' }).check();
      await dialog.getByRole('checkbox', { name: '配置 Github 项目' }).check();

      await expect(dialog.getByLabel('Github 账号')).toHaveValue(/.+/);
      await dialog.getByLabel('仓库').selectOption({ label: 'phase10-owner/repo' });
      await expect(dialog.getByLabel('前缀地址')).toHaveValue('~/workspace');
      await dialog.getByRole('button', { name: '创建云电脑' }).click();

      // 四阶段进度框：启动云电脑为前置阶段
      await expect(page.getByRole('heading', { name: '设置进度' })).toBeVisible({ timeout: 15000 });
      const steps = page.getByTestId('github-setup-steps');
      for (const label of ['启动云电脑', '工作负载设置', 'Git 项目设置', '会话创建']) {
        await expect(steps.getByText(label, { exact: true })).toBeVisible();
      }
      await expect(steps.getByText('进行中')).toBeVisible();

      const host = await waitForHost(page, token, name);
      await setHostRunning(host.id);

      // 前端轮询 cloudHost(id) 发现 RUNNING 后自动发起 setup
      const operation = await waitForOperation(host.controllerId);
      await expect(steps.getByText('成功').first()).toBeVisible({ timeout: 15000 });

      const db = (await phase10Db())!;
      const controller = await db.collection('controllers').findOne({
        _id: new mongoose.Types.ObjectId(host.controllerId),
      });
      const sessionId = await seedProjectSession(userId, host.controllerId, String(controller?.name ?? ''));
      await markOperationSucceeded(operation._id.toString(), sessionId);

      await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}`), { timeout: 20000 });
      const hostAfter = await gqlRequest(
        page,
        `query($id: ID!) { cloudHost(id: $id) { id defaultSessionId } }`,
        { id: host.id },
        token,
      ).then((res) => res.json());
      expect(hostAfter.data.cloudHost.defaultSessionId).toBe(sessionId);

      // 未额外创建空的默认会话：该 controller 下只有项目会话
      expect(
        await db.collection('sessions').countDocuments({
          controllerId: new mongoose.Types.ObjectId(host.controllerId),
        }),
      ).toBe(1);
    } finally {
      await cleanupHost(page, token, name);
    }
  });

  test('P10-CH3: 项目准备失败 → 进度框展示失败步骤并可重试', async ({ page }) => {
    test.skip(!MONGO_URI, '需要 MONGODB_URI');
    test.setTimeout(120_000);
    const { token, username } = await registerUser(page);
    const userId = await getMe(page, token);
    await seedGithub(page, userId);
    await loginViaUI(page, username);
    const name = `e2e-p10-fail-${Date.now().toString(36)}`;

    try {
      await page.getByRole('button', { name: '新建云电脑' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('#cloud-host-name').fill(name);
      await dialog.getByRole('checkbox', { name: 'OpenCode' }).check();
      await dialog.getByRole('checkbox', { name: '配置 Github 项目' }).check();
      await dialog.getByLabel('仓库').selectOption({ label: 'phase10-owner/repo' });
      await dialog.getByRole('button', { name: '创建云电脑' }).click();
      await expect(page.getByRole('heading', { name: '设置进度' })).toBeVisible({ timeout: 15000 });

      const host = await waitForHost(page, token, name);
      await setHostRunning(host.id);
      const operation = await waitForOperation(host.controllerId);

      await markOperationFailed(operation._id.toString());
      const steps = page.getByTestId('github-setup-steps');
      await expect(steps.getByText('Git 项目设置', { exact: true })).toBeVisible();
      await expect(steps.getByText('失败').first()).toBeVisible({ timeout: 15000 });
      await expect(page.getByText('git clone failed').first()).toBeVisible();
      const retry = page.getByRole('button', { name: '重试', exact: true });
      await expect(retry).toBeVisible();
      const db = (await phase10Db())!;
      const opId = new mongoose.Types.ObjectId(operation._id);
      const before = await db.collection('cloud_host_setup_operations').findOne({ _id: opId });
      await retry.click();
      // C-23：环境无真实 worker 时重试可能立刻再次失败，不能只等 UI「进行中」；
      // 改为断言操作文档确实被重新推进（updatedAt 前移），证明重试链路生效。
      const deadline = Date.now() + 15000;
      let after = before;
      while (Date.now() < deadline) {
        after = await db.collection('cloud_host_setup_operations').findOne({ _id: opId });
        if (
          after?.updatedAt &&
          before?.updatedAt &&
          new Date(after.updatedAt).getTime() > new Date(before.updatedAt).getTime()
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      expect(new Date(after!.updatedAt).getTime()).toBeGreaterThan(
        new Date(before!.updatedAt).getTime(),
      );
    } finally {
      await cleanupHost(page, token, name);
    }
  });
});
