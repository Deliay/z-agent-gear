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

/** 解析 GraphQL 请求体：operationName + variables（归档参数在 variables 里，不在 query 紧邻括号内）。 */
function parseGraphqlBody(post: string): { operation: string; variables: Record<string, unknown> } {
  try {
    const body = JSON.parse(post) as { operationName?: string; variables?: Record<string, unknown> };
    return { operation: body.operationName ?? '', variables: body.variables ?? {} };
  } catch {
    return { operation: '', variables: {} };
  }
}

function isArchiveRequest(post: string): boolean {
  const { operation, variables } = parseGraphqlBody(post);
  if (operation === 'GetArchivedSessions') return true;
  // 工作流归档查询：GET_WORKFLOW_INSTANCES($archived) 且变量 archived=true
  return operation === 'GetWorkflowInstances' && variables.archived === true;
}

/** 单 route handler 同时统计 HomeOverview 与归档清单请求（后注册 handler 会覆盖前一个）。 */
async function trackHomeAndArchiveRequests(
  page: Page,
): Promise<{ home: () => number; archive: () => number }> {
  let homeCount = 0;
  let archiveCount = 0;
  await page.route('**/graphql', async (route) => {
    const post = route.request().postData() ?? '';
    if (parseGraphqlBody(post).operation === 'HomeOverview') homeCount += 1;
    if (isArchiveRequest(post)) archiveCount += 1;
    await route.continue();
  });
  return { home: () => homeCount, archive: () => archiveCount };
}

/** 统计归档清单按需查询（GetArchivedSessions / GetWorkflowInstances(archived:true)）请求数 */
async function trackArchiveRequests(page: Page): Promise<() => number> {
  let count = 0;
  await page.route('**/graphql', async (route) => {
    if (isArchiveRequest(route.request().postData() ?? '')) count += 1;
    await route.continue();
  });
  return () => count;
}

test.describe('首页展示优化 E2E', () => {
  test('T-E1 打开首页首屏仅发起一次 HomeOverview 请求', async ({ page }) => {
    test.setTimeout(60000);
    const { token, username, controllerId, workspaceId, disconnect } = await setupUserWithController(page, 'e1');
    await createInstance(page, token, controllerId, workspaceId, '首屏实例');

    const tracker = await trackHomeAndArchiveRequests(page);
    await loginViaUI(page, username);

    const rail = page.locator('[data-testid="activity-rail"]');
    await rail.getByTestId('rail-item-workflows').click();
    const sidebar = page.locator(sidebarSel);
    await expect(sidebar.getByText('首屏实例')).toBeVisible({ timeout: 15000 });

    expect(tracker.home()).toBe(1);
    // E2E-HP1：首屏不拉取归档清单
    expect(tracker.archive()).toBe(0);
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

  test('E2E-HP2 展开「已归档」才发归档请求、无数量、空态可展开', async ({ page }) => {
    test.setTimeout(60000);
    const { username, disconnect } = await setupUserWithController(page, 'hp2');
    const getArchiveCount = await trackArchiveRequests(page);
    await loginViaUI(page, username);
    const sidebar = page.locator(sidebarSel);
    await sidebar.waitFor({ timeout: 15000 });

    // 常驻「已归档」且无数量；首屏未发归档查询
    const sessionsDomain = sidebar.locator('[data-testid="context-panel-domain-sessions"]');
    const archivedGroup = sessionsDomain.getByRole('button', { name: '已归档', exact: true });
    await expect(archivedGroup).toBeVisible();
    await expect(sidebar.getByText(/已归档（\d+）/)).toHaveCount(0);
    expect(getArchiveCount()).toBe(0);

    await archivedGroup.click();
    await expect(sessionsDomain.getByText('暂无归档')).toBeVisible({ timeout: 15000 });
    expect(getArchiveCount()).toBeGreaterThanOrEqual(1);
    disconnect();
  });

  test('E2E-WSF1 离线控制器的工作区不在侧边栏/实例化弹窗展示', async ({ page }) => {
    test.setTimeout(70000);
    const { token, username, controllerId, disconnect } = await setupUserWithController(page, 'wsf1');
    const wsPath = `/tmp/home-wsf1-ws-${Date.now()}`;
    await createWorkspace(page, controllerId, wsPath, token);
    const wsName = wsPath.split('/').filter(Boolean).pop()!;

    disconnect();
    // 等控制器离线：workspaces 过滤后不再返回该项目工作区
    await expect
      .poll(
        async () => {
          const res = await gqlRequest(
            page,
            `query Q { workspaces { id name controllerId } }`,
            undefined,
            token,
          );
          const body = await res.json();
          return (body.data?.workspaces ?? []).filter(
            (w: { controllerId: string }) => w.controllerId === controllerId,
          ).length;
        },
        { timeout: 30000, intervals: [1000] },
      )
      .toBe(0);

    await loginViaUI(page, username);
    const rail = page.locator('[data-testid="activity-rail"]');
    const sidebar = page.locator(sidebarSel);
    await sidebar.waitFor({ timeout: 15000 });
    await expect(sidebar.getByText(wsName)).toHaveCount(0);

    await rail.getByTestId('rail-item-workflows').click();
    const instantiateButton = sidebar.getByLabel('实例化工作流');
    await expect(instantiateButton).toBeVisible({ timeout: 15000 });
    await instantiateButton.click();
    const firstController = page.getByRole('menuitem').first();
    await expect(firstController).toBeVisible({ timeout: 10000 });
    await firstController.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await expect(dialog.getByText(wsName)).toHaveCount(0);
  });

  test('E2E-HP3 workspaceContext 与模板/配置随 15s 轮询刷新（无需刷新页面）', async ({ page }) => {
    test.skip(!process.env.INTERNAL_API_TOKEN, '需要 INTERNAL_API_TOKEN 创建团队并加入成员');
    test.setTimeout(90000);
    const { token, username, controllerId, workspaceId, disconnect } = await setupUserWithController(page, 'hp3');
    await loginViaUI(page, username);
    await page.locator(sidebarSel).waitFor({ timeout: 15000 });

    // 监听后续 HomeOverview 响应，验证轮询载荷包含新建的模板/已配置工作流
    const polled = { templates: new Set<string>(), configured: new Set<string>() };
    page.on('response', async (response) => {
      if (!response.url().includes('/graphql')) return;
      const request = response.request();
      try {
        const requestBody = JSON.parse(request.postData() ?? '{}') as { operationName?: string };
        if (requestBody.operationName !== 'HomeOverview') return;
        const body = await response.json();
        for (const template of body.data?.homeOverview?.workflowTemplates ?? []) {
          if (template?.name) polled.templates.add(template.name);
        }
        for (const configured of body.data?.homeOverview?.configuredWorkflows ?? []) {
          if (configured?.name) polled.configured.add(configured.name);
        }
      } catch {
        // 忽略非 JSON/已取消响应
      }
    });

    const apiBase = (process.env.API_URL || 'http://localhost:10001/graphql').replace(/\/graphql\/?$/, '');
    const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}` };
    const teamName = `hp3-team-${Date.now().toString(36)}`.slice(0, 60);
    const teamRes = await page.request.post(`${apiBase}/internal/tenants`, {
      headers: auth,
      data: { name: teamName },
    });
    expect(teamRes.ok()).toBeTruthy();
    const team = await teamRes.json();
    const addRes = await page.request.post(`${apiBase}/internal/tenants/${team.tenant.id}/members`, {
      headers: auth,
      data: { username, role: 'developer' },
    });
    expect(addRes.ok()).toBeTruthy();

    // workspaceContext：团队全局工作区 option 在下一轮轮询后出现（以 id 精确断言，不用名称）
    await expect
      .poll(
        async () =>
          page
            .getByLabel('切换工作区')
            .locator(`option[value="${team.globalWorkspace.id}"]`)
            .count(),
        { timeout: 30000, intervals: [1000] },
      )
      .toBeGreaterThanOrEqual(1);

    // workflowTemplates / configuredWorkflows：登录后造数，断言后续 HomeOverview 轮询载荷包含
    const stamp = Date.now().toString(36);
    const templateName = `hp3-tpl-${stamp}`;
    const configuredName = `hp3-cfg-${stamp}`;
    const tplRes = await gqlRequest(page, `
      mutation CreateTemplate($input: WorkflowTemplateInput!) {
        createWorkflowTemplate(input: $input) { id }
      }
    `, { input: { name: templateName, nodes: HUMAN_NODES } }, token);
    const tplBody = await tplRes.json();
    expect(tplBody.errors).toBeUndefined();
    const cfgRes = await gqlRequest(page, `
      mutation ConfigureWorkflow($templateId: ID!, $input: ConfigureWorkflowInput!) {
        configureWorkflow(templateId: $templateId, input: $input) { id }
      }
    `, {
      templateId: tplBody.data.createWorkflowTemplate.id,
      input: { name: configuredName, controllerId, nodes: HUMAN_NODES },
    }, token);
    const cfgBody = await cfgRes.json();
    expect(cfgBody.errors).toBeUndefined();

    await expect
      .poll(() => polled.templates.has(templateName), { timeout: 30000, intervals: [1000] })
      .toBe(true);
    await expect
      .poll(() => polled.configured.has(configuredName), { timeout: 30000, intervals: [1000] })
      .toBe(true);
    disconnect();
  });

  test('T-E3 工作流集中列表：不展开工作区即可见 + 归属标注 + 点击直达详情', async ({ page }) => {
    test.setTimeout(60000);
    const { token, username, controllerId, workspaceId, disconnect } = await setupUserWithController(page, 'e3');
    const instanceId = await createInstance(page, token, controllerId, workspaceId, '集中展示实例');

    await loginViaUI(page, username);
    const rail = page.locator('[data-testid="activity-rail"]');
    await rail.getByTestId('rail-item-workflows').click();
    const sidebar = page.locator(sidebarSel);

    // 工作流集中列表：无需展开工作区即可见实例
    const item = sidebar.getByText('集中展示实例');
    await expect(item).toBeVisible({ timeout: 15000 });

    // 聚合条目标注所属工作区（UI 四期：条目名 + 状态 + 工作区名，不再拼接控制器名）
    await expect(sidebar.getByText(/home-e3-ws/)).toBeVisible();

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
    const rail = page.locator('[data-testid="activity-rail"]');
    const sidebar = page.locator(sidebarSel);

    // 切换至「主机」领域，定位控制器节点
    await rail.getByTestId('rail-item-hosts').click();
    await expect(sidebar.getByRole('button', { name: /home-e4-host/ }).first()).toBeVisible({
      timeout: 15000,
    });
    // 切换至「工作流」领域可见工作流实例
    await rail.getByTestId('rail-item-workflows').click();
    await expect(sidebar.getByText('控制器实例')).toBeVisible();
    // 切换至「会话」领域可见会话条目
    await rail.getByTestId('rail-item-sessions').click();
    await expect(sidebar.locator('a[href^="/sessions/"]').first()).toBeVisible();
    disconnect();
  });

  test('T-E5 某信息流为空时对应区块展示空状态', async ({ page }) => {
    test.setTimeout(60000);
    const { username, disconnect } = await setupUserWithController(page, 'e5');

    await loginViaUI(page, username);
    const sidebar = page.locator(sidebarSel);

    // 空态收敛：不渲染占位文案，聚合列表仅保留常驻折叠的「已归档」入口（无活跃条目）
    await expect(sidebar.getByText('无工作流实例')).toHaveCount(0);
    await expect(sidebar.getByText('无会话')).toHaveCount(0);
    await expect(page.locator('[data-testid="sidebar-workflow-list"] a[href^="/workflows/"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="sidebar-session-list"] a[href^="/sessions/"]')).toHaveCount(0);
    disconnect();
  });
});
