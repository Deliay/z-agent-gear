import { test, expect, type Page } from '@playwright/test';
import { io as SocketIOClient, type Socket } from 'socket.io-client';
import { registerUser, createControllerKey, loginViaUI, createWorkspace, createSession, gqlRequest } from './helpers';

const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';
const sidebarSel = 'nav[aria-label="Sidebar"]';

// ---------------------------------------------------------------------------
// Fake controller：应答 acp:check 与 worktree 列举
// ---------------------------------------------------------------------------

interface FakeController {
  controllerId: string;
  socket: Socket;
  disconnect: () => void;
}

function registerFakeController(rawKey: string, hostname: string): Promise<FakeController> {
  return new Promise((resolve, reject) => {
    const client = SocketIOClient(CONTROLLER_API_URL, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    const timer = setTimeout(() => {
      client.disconnect();
      reject(new Error('Timeout registering controller'));
    }, 10000);

    client.on('acp:check', (data: { requestId: string }) => {
      client.emit('acp:check:result', {
        requestId: data.requestId,
        servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
      });
    });
    client.on('git:worktree:list', (data: { requestId: string }) => {
      client.emit('git:worktree:list:result', {
        requestId: data.requestId,
        success: true,
        worktrees: [],
      });
    });
    client.on('acp:start', (data: { requestId: string; sessionId: string }) => {
      client.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
        externalSessionId: `ext_${Date.now()}`,
      });
    });

    client.once('registered', (data: { controllerId: string }) => {
      clearTimeout(timer);
      resolve({ controllerId: data.controllerId, socket: client, disconnect: () => client.disconnect() });
    });
    client.once('error', (data: { code: string; message: string }) => {
      clearTimeout(timer);
      client.disconnect();
      reject(new Error(`Register failed: ${data.message}`));
    });
    client.emit('register', { key: rawKey, hostname, version: '2.0.0' });
  });
}

const HUMAN_NODES = [
  { nodeKey: 'input', type: 'HUMAN', name: '需求输入', stage: '需求', dependsOn: [], requiresWorktree: false },
];

async function createInstance(
  page: Page,
  token: string,
  controllerId: string,
  workspaceId: string,
  name: string,
): Promise<string> {
  const tplRes = await gqlRequest(page, `
    mutation CreateTemplate($input: WorkflowTemplateInput!) {
      createWorkflowTemplate(input: $input) { id }
    }
  `, { input: { name: `${name}-tpl`, description: 'home e2e', nodes: HUMAN_NODES } }, token);
  const tplBody = await tplRes.json();
  expect(tplBody.errors).toBeUndefined();

  const cfgRes = await gqlRequest(page, `
    mutation ConfigureWorkflow($templateId: ID!, $input: ConfigureWorkflowInput!) {
      configureWorkflow(templateId: $templateId, input: $input) { id }
    }
  `, { templateId: tplBody.data.createWorkflowTemplate.id, input: { name: `${name}-cfg`, controllerId, nodes: HUMAN_NODES } }, token);
  const cfgBody = await cfgRes.json();
  expect(cfgBody.errors).toBeUndefined();

  const instRes = await gqlRequest(page, `
    mutation Instantiate($input: InstantiateWorkflowInput!) {
      instantiateWorkflow(input: $input) { id }
    }
  `, {
    input: {
      source: 'CONFIGURED',
      configuredWorkflowId: cfgBody.data.configureWorkflow.id,
      controllerId,
      workspaceId,
      name,
      nodes: HUMAN_NODES,
    },
  }, token);
  const instBody = await instRes.json();
  expect(instBody.errors).toBeUndefined();
  return instBody.data.instantiateWorkflow.id;
}

async function setupUserWithController(page: Page, tag: string): Promise<{
  token: string;
  username: string;
  controllerId: string;
  workspaceId: string;
  disconnect: () => void;
}> {
  const { token, username } = await registerUser(page);
  const { rawKey } = await createControllerKey(page, token);
  const controller = await registerFakeController(rawKey, `home-${tag}-host`);
  const workspace = await createWorkspace(page, controller.controllerId, `/tmp/home-${tag}-ws`, token);
  return {
    token,
    username,
    controllerId: controller.controllerId,
    workspaceId: workspace.id,
    disconnect: controller.disconnect,
  };
}

/** 拦截 /graphql，统计 operationName 为 HomeOverview 的请求数 */
async function trackHomeOverviewRequests(page: Page): Promise<() => number> {
  let count = 0;
  await page.route('**/graphql', async (route) => {
    const post = route.request().postData() ?? '';
    if (post.includes('HomeOverview')) count += 1;
    await route.continue();
  });
  return () => count;
}

test.describe('首页展示优化 E2E', () => {
  test('T-E1 打开首页首屏仅发起一次 HomeOverview 请求', async ({ page }) => {
    test.setTimeout(60000);
    const { token, username, controllerId, workspaceId, disconnect } = await setupUserWithController(page, 'e1');
    await createInstance(page, token, controllerId, workspaceId, '首屏实例');

    const getCount = await trackHomeOverviewRequests(page);
    await loginViaUI(page, username);

    const sidebar = page.locator(sidebarSel);
    await expect(sidebar.getByText('首屏实例')).toBeVisible({ timeout: 15000 });

    expect(getCount()).toBe(1);
    disconnect();
  });

  test('T-E2 轮询周期每轮仅新增一次请求', async ({ page }) => {
    test.setTimeout(60000);
    const { username, disconnect } = await setupUserWithController(page, 'e2');

    const getCount = await trackHomeOverviewRequests(page);
    await loginViaUI(page, username);
    await page.locator(sidebarSel).waitFor({ timeout: 15000 });

    const baseline = getCount();
    // 15s 轮询周期：等待恰好新增一次
    await expect.poll(() => getCount() - baseline, { timeout: 25000, intervals: [500] }).toBe(1);
    disconnect();
  });

  test('T-E3 工作流集中列表：不展开工作区即可见 + 归属标注 + 点击直达详情', async ({ page }) => {
    test.setTimeout(60000);
    const { token, username, controllerId, workspaceId, disconnect } = await setupUserWithController(page, 'e3');
    const instanceId = await createInstance(page, token, controllerId, workspaceId, '集中展示实例');

    await loginViaUI(page, username);
    const sidebar = page.locator(sidebarSel);

    // 工作流集中列表：无需展开工作区即可见实例
    const item = sidebar.getByText('集中展示实例');
    await expect(item).toBeVisible({ timeout: 15000 });

    // 条目标注所属工作区与所属控制器（工作区名以 "home-e3-ws" 结尾，状态分隔符 "·" 区分于工作区默认条目）
    await expect(sidebar.getByText(/home-e3-ws · home-e3-host · /)).toBeVisible();

    // 点击直达详情
    await item.click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${instanceId}`), { timeout: 15000 });
    disconnect();
  });

  test('T-E4 按控制器浏览其下工作区/会话/工作流', async ({ page }) => {
    test.setTimeout(60000);
    const { token, username, controllerId, workspaceId, disconnect } = await setupUserWithController(page, 'e4');
    await createInstance(page, token, controllerId, workspaceId, '控制器实例');
    await createSession(page, controllerId, token, workspaceId);

    await loginViaUI(page, username);
    const sidebar = page.locator(sidebarSel);

    // 控制器分组默认展开，其下工作区列表可见
    await expect(sidebar.getByRole('button', { name: /home-e4-host/ })).toBeVisible({ timeout: 15000 });
    await expect(sidebar.getByText(/home-e4-ws（默认）/)).toBeVisible();
    // 其下工作流列表可见
    await expect(sidebar.getByText('控制器实例')).toBeVisible();
    // 其下会话列表可见（会话可能同时出现在「会话」与工作区根目录回退分组中）
    await expect(sidebar.locator('a[href^="/sessions/"]').first()).toBeVisible();
    disconnect();
  });

  test('T-E5 某信息流为空时对应区块展示空状态', async ({ page }) => {
    test.setTimeout(60000);
    const { username, disconnect } = await setupUserWithController(page, 'e5');

    await loginViaUI(page, username);
    const sidebar = page.locator(sidebarSel);

    // 无工作流实例 → 空态；其余信息流正常渲染
    await expect(sidebar.getByText('无工作流实例')).toBeVisible({ timeout: 15000 });
    await expect(sidebar.getByText('无会话')).toBeVisible();
    disconnect();
  });
});
