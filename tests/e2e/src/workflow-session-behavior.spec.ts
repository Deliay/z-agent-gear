import { test, expect, type Page } from '@playwright/test';
import { io as SocketIOClient, type Socket } from 'socket.io-client';
import {
  createControllerKey,
  gqlRequest,
  loginViaUI,
  registerUser,
} from './helpers.js';

/**
 * 工作流打回/返工会话行为 —— E2E-SB1 / E2E-SB2。
 *
 * - E2E-SB1：模板编辑器「会话行为」区（仅 AI 渲染、默认值、条件展示压缩勾选、保存回显）；
 * - E2E-SB2：配置「打回后=原始会话」的 AI 评审节点，在「打回 → 上游返工完成 → 再次流转」时
 *   恢复原始会话（fake controller 断言 acp:resume 而非 acp:start），并收到继续提示词。
 */

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273';

type SessionFields = {
  reworkSessionBehavior?: string | null;
  reworkCompactOriginalContext?: boolean | null;
  resumeSessionBehavior?: string | null;
  resumeCompactOriginalContext?: boolean | null;
};

interface StartEvent {
  requestId: string;
  sessionId: string;
  serverType: string;
  mcpEndpoint?: { token: string; serverNames: string[] };
}

interface ResumeEvent {
  requestId: string;
  sessionId: string;
}

interface WorkflowController {
  controllerId: string;
  socket: Socket;
  starts: StartEvent[];
  resumes: ResumeEvent[];
  stops: string[];
  disconnect: () => void;
}

function registerWorkflowController(rawKey: string, hostname: string): Promise<WorkflowController> {
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

    const starts: StartEvent[] = [];
    const resumes: ResumeEvent[] = [];
    const stops: string[] = [];

    client.on('acp:check', (data: { requestId: string }) => {
      client.emit('acp:check:result', {
        requestId: data.requestId,
        servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
      });
    });
    client.on('git:check', (data: { requestId: string }) => {
      client.emit('git:check:result', { requestId: data.requestId, isGitRepo: false });
    });
    client.on('git:worktree:list', (data: { requestId: string }) => {
      client.emit('git:worktree:list:result', { requestId: data.requestId, success: true, worktrees: [] });
    });
    client.on('acp:start', (data: StartEvent) => {
      starts.push(data);
      client.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
        externalSessionId: `ext_${data.sessionId}`,
      });
    });
    client.on('acp:resume', (data: ResumeEvent) => {
      resumes.push(data);
      client.emit('acp:resume:result', { requestId: data.requestId, sessionId: data.sessionId, success: true });
    });
    client.on('acp:stop', (data: { sessionId: string }) => {
      stops.push(data.sessionId);
      client.emit('acp:stopped', { sessionId: data.sessionId, reason: 'user_close' });
    });

    client.once('registered', (data: { controllerId: string }) => {
      clearTimeout(timer);
      resolve({
        controllerId: data.controllerId,
        socket: client,
        starts,
        resumes,
        stops,
        disconnect: () => client.disconnect(),
      });
    });
    client.once('error', (data: { code: string; message: string }) => {
      clearTimeout(timer);
      client.disconnect();
      reject(new Error(`Register failed: ${data.message}`));
    });
    client.emit('register', { key: rawKey, hostname, version: '2.0.0' });
  });
}

async function waitFor<T>(fn: () => T | Promise<T> | undefined | null | false, timeoutMs = 15000, label = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value as T;
    if (Date.now() - start > timeoutMs) throw new Error(`Timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

function relayMcpCall(
  controller: WorkflowController,
  sessionId: string,
  serverName: string,
  token: string,
  body: unknown,
  timeoutMs = 15000,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const requestId = `e2e_sb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    let timer: ReturnType<typeof setTimeout>;
    const onResponse = (data: { requestId: string; status: number; body: unknown }) => {
      if (data.requestId !== requestId) return;
      clearTimeout(timer);
      controller.socket.off('mcp:response', onResponse);
      resolve({ status: data.status, body: (data.body ?? {}) as Record<string, unknown> });
    };
    timer = setTimeout(() => {
      controller.socket.off('mcp:response', onResponse);
      reject(new Error(`Timeout waiting for mcp:response (${serverName}/${sessionId})`));
    }, timeoutMs);
    controller.socket.on('mcp:response', onResponse);
    controller.socket.emit('mcp:request', { requestId, sessionId, serverName, token, body });
  });
}

async function callWorkflowTool(
  controller: WorkflowController,
  sessionId: string,
  mcpToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; data: Record<string, unknown> }> {
  const res = await relayMcpCall(controller, sessionId, 'agent-workflow-tools', mcpToken, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  expect(res.status).toBe(200);
  expect(res.body.error).toBeUndefined();
  const result = (res.body as { result: { isError?: boolean; content: { text: string }[] } }).result;
  return { isError: Boolean(result.isError), data: JSON.parse(result.content[0].text) };
}

async function refreshCapabilities(page: Page, token: string, controllerId: string): Promise<void> {
  const res = await gqlRequest(
    page,
    `mutation Refresh($controllerId: ID!) { refreshAcpCapabilities(controllerId: $controllerId) { type available } }`,
    { controllerId },
    token,
  );
  const body = await res.json();
  expect(body.errors).toBeUndefined();
}

async function apiGql(page: Page, token: string, query: string, variables?: Record<string, unknown>) {
  const res = await gqlRequest(page, query, variables, token);
  const body = await res.json();
  if (body.errors) throw new Error(`GraphQL failed: ${JSON.stringify(body.errors)}`);
  return body.data;
}

test.describe('工作流节点会话行为', () => {
  test('E2E-SB1: 模板编辑器「会话行为」区仅 AI 渲染、条件展示压缩勾选、保存回显', async ({ page }) => {
    test.setTimeout(90000);
    const { token, username } = await registerUser(page);
    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    const section = page.locator('#workflow-section');
    await expect(section).toBeVisible({ timeout: 5000 });

    const templateName = `E2E会话行为${Date.now().toString(36)}`;
    await section.getByRole('button', { name: '创建工作流模板' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('定义工作流的节点、依赖关系、提示词与产物', { exact: false })).toBeVisible();
    await dialog.getByLabel('模板名称').fill(templateName);

    // 节点 1：人类（默认）
    await dialog.getByRole('button', { name: '展开节点 1' }).click();
    await dialog.getByLabel('节点 1 标识').fill('input');
    await dialog.getByLabel('节点 1 名称').fill('需求输入');
    await dialog.getByLabel('节点 1 阶段').fill('需求');
    await expect(dialog.getByRole('radiogroup', { name: '需求输入 返工时会话行为' })).toHaveCount(0);

    // 节点 2：AI
    await dialog.getByRole('button', { name: '添加节点' }).click();
    await dialog.getByRole('button', { name: '展开节点 2' }).click();
    await dialog.getByRole('button', { name: 'AI', exact: true }).last().click();
    await dialog.getByLabel('节点 2 标识').fill('exec');
    await dialog.getByLabel('节点 2 名称').fill('AI执行');
    await dialog.getByLabel('节点 2 阶段').fill('开发');
    await dialog.getByLabel('节点 2 提示词').fill('执行开发任务');
    await dialog.getByLabel('节点 2 产物标题').fill('开发产物');
    await dialog.getByText('需求输入（input）').click();

    // 默认值：返工时=原始会话（显示压缩勾选）、打回后=新会话（不显示压缩勾选）
    const reworkGroup = dialog.getByRole('radiogroup', { name: 'AI执行 返工时会话行为' });
    await expect(reworkGroup).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'AI执行 返工时 原始会话' })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'AI执行 返工时压缩原始上下文' })).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'AI执行 打回后 新会话' })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'AI执行 打回后压缩原始上下文' })).toHaveCount(0);

    // 打回后切到「原始会话」→ 出现压缩勾选；返工时切到「新会话」→ 勾选隐藏且重置
    await dialog.getByRole('radio', { name: 'AI执行 打回后 原始会话' }).check();
    await expect(dialog.getByRole('checkbox', { name: 'AI执行 打回后压缩原始上下文' })).toBeVisible();
    await dialog.getByRole('checkbox', { name: 'AI执行 打回后压缩原始上下文' }).check();
    await dialog.getByRole('radio', { name: 'AI执行 返工时 新会话' }).check();
    await expect(dialog.getByRole('checkbox', { name: 'AI执行 返工时压缩原始上下文' })).toHaveCount(0);

    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 10000 });

    // 重开回显一致：返工时=新会话、打回后=原始会话（含压缩勾选）
    const createdCard = section.locator('[data-slot="card"]').filter({ hasText: templateName });
    await expect(createdCard).toBeVisible({ timeout: 10000 });
    await createdCard.getByRole('button', { name: '查看' }).click();
    const viewDialog = page.getByRole('dialog');
    await expect(viewDialog.getByText('查看工作流模板')).toBeVisible();
    // 只读查看：会话行为区仍渲染（折叠不影响该区），值回显一致
    await expect(viewDialog.getByRole('radio', { name: 'AI执行 返工时 新会话' })).toBeChecked();
    await expect(viewDialog.getByRole('radio', { name: 'AI执行 打回后 原始会话' })).toBeChecked();
    await expect(viewDialog.getByRole('checkbox', { name: 'AI执行 打回后压缩原始上下文' })).toBeChecked();
    await expect(viewDialog.getByRole('checkbox', { name: 'AI执行 返工时压缩原始上下文' })).toHaveCount(0);
    // 只读查看：会话行为控件禁用
    await expect(viewDialog.getByRole('radio', { name: 'AI执行 返工时 新会话' })).toBeDisabled();
  });

  test('E2E-SB2: 打回后=原始会话 → 上游返工完成后复用原会话（不新建）并收到继续提示词', async ({ page }) => {
    test.setTimeout(120000);
    const { token } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const controller = await registerWorkflowController(rawKey, `wf-sb2-host-${Date.now().toString(36)}`);
    await refreshCapabilities(page, token, controller.controllerId);

    const sessionFields = (fields: SessionFields) => ({
      reworkSessionBehavior: 'ORIGINAL_SESSION',
      reworkCompactOriginalContext: false,
      resumeSessionBehavior: 'ORIGINAL_SESSION',
      resumeCompactOriginalContext: false,
      ...fields,
    });

    const nodes = (reviewFields: SessionFields) => [
      { nodeKey: 'input', type: 'HUMAN', name: '需求输入', stage: '阶段一', dependsOn: [], requiresWorktree: false },
      {
        nodeKey: 'exec',
        type: 'AI',
        name: 'AI执行',
        stage: '阶段一',
        prompts: ['执行开发任务'],
        artifactTitles: ['执行结果'],
        dependsOn: ['input'],
        requiresWorktree: false,
        ...sessionFields({}),
      },
      {
        nodeKey: 'review',
        type: 'AI',
        name: 'AI评审',
        stage: '阶段二',
        prompts: ['评审执行结果'],
        artifactTitles: ['评审结论'],
        dependsOn: ['exec'],
        requiresWorktree: false,
        ...sessionFields(reviewFields),
      },
    ];

    const template = await apiGql(
      page,
      token,
      `mutation CreateTpl($input: WorkflowTemplateInput!) { createWorkflowTemplate(input: $input) { id } }`,
      { input: { name: `E2E-SB2-${Date.now().toString(36)}`, nodes: nodes({}) } },
    );

    const configuredNodes = nodes({ resumeSessionBehavior: 'ORIGINAL_SESSION' }).map((node) => ({
      ...node,
      agentConfig: node.type === 'AI' ? { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: false } : null,
    }));
    const configured = await apiGql(
      page,
      token,
      `mutation Configure($templateId: ID!, $input: ConfigureWorkflowInput!) {
        configureWorkflow(templateId: $templateId, input: $input) { id }
      }`,
      { templateId: template.createWorkflowTemplate.id, input: { name: `E2E-SB2-配置-${Date.now().toString(36)}`, controllerId: controller.controllerId, nodes: configuredNodes } },
    );

    const workspace = await apiGql(
      page,
      token,
      `mutation CreateWorkspace($input: CreateWorkspaceInput!) { createWorkspace(input: $input) { id } }`,
      { input: { controllerId: controller.controllerId, path: `/tmp/e2e-sb2-${Date.now()}` } },
    );

    const instance = await apiGql(
      page,
      token,
      `mutation Instantiate($input: InstantiateWorkflowInput!) {
        instantiateWorkflow(input: $input) { id nodes { id nodeKey status sessionId } }
      }`,
      {
        input: {
          source: 'CONFIGURED',
          configuredWorkflowId: configured.configureWorkflow.id,
          controllerId: controller.controllerId,
          workspaceId: workspace.createWorkspace.id,
          name: `E2E-SB2-实例-${Date.now().toString(36)}`,
          nodes: configuredNodes,
        },
      },
    );
    const instanceId = instance.instantiateWorkflow.id as string;
    const inputNodeId = instance.instantiateWorkflow.nodes.find((n: Record<string, unknown>) => n.nodeKey === 'input').id;
    const instanceQuery = `query Inst($id: ID!) {
      workflowInstance(id: $id) { nodes { id nodeKey status sessionId } }
    }`;

    // 1) 完成需求输入 → exec 启动
    let startCount = 0;
    const completeInput = await apiGql(
      page,
      token,
      `mutation Complete($instanceId: ID!, $nodeId: ID!, $input: String) {
        completeHumanNode(instanceId: $instanceId, nodeId: $nodeId, input: $input) { id }
      }`,
      { instanceId, nodeId: inputNodeId, input: '实现一个计算器' },
    );
    expect(completeInput.completeHumanNode.id).toBeTruthy();

    const execStart = await waitFor(() => (controller.starts.length > startCount ? controller.starts[startCount] : undefined), 20000, 'exec acp:start');
    startCount += 1;
    const execSessionId = execStart.sessionId;
    const execToken = execStart.mcpEndpoint!.token;

    // 2) exec 完成 → review 启动
    const execDone = await callWorkflowTool(controller, execSessionId, execToken, 'completeCurrentNode', {
      artifacts: [{ title: '执行结果', value: '计算器已实现' }],
    });
    expect(execDone.isError).toBe(false);
    const reviewStart = await waitFor(() => (controller.starts.length > startCount ? controller.starts[startCount] : undefined), 20000, 'review acp:start');
    startCount += 1;
    const reviewSessionId = reviewStart.sessionId;
    const reviewToken = reviewStart.mcpEndpoint!.token;

    // 3) review 打回 exec → exec 进入 REWORK（原始会话 resume）
    const rejected = await callWorkflowTool(controller, reviewSessionId, reviewToken, 'rejectCurrentNode', {
      reason: '缺少边界校验',
    });
    expect(rejected.isError).toBe(false);
    await waitFor(() => controller.resumes.some((r) => r.sessionId === execSessionId), 20000, 'exec rework resume');

    // 4) exec 完成返工 → review 再次流转（打回后=原始会话 → acp:resume 而非 acp:start）
    const reworked = await callWorkflowTool(controller, execSessionId, execToken, 'completeCurrentRework', {});
    expect(reworked.isError).toBe(false);

    await waitFor(async () => {
      const inst = await apiGql(page, token, instanceQuery, { id: instanceId });
      const review = inst.workflowInstance.nodes.find((n: Record<string, unknown>) => n.nodeKey === 'review');
      return review.status === 'RUNNING' ? true : undefined;
    }, 30000, 'review RUNNING after rework');

    // 打回后=原始会话：不新建会话（starts 不增加），复用 review 原会话并收到继续提示词
    const messages = await waitFor(async () => {
      const data = await apiGql(
        page,
        token,
        `query Messages($sessionId: ID!) {
          sessionMessages(sessionId: $sessionId, limit: 50) { content }
        }`,
        { sessionId: reviewSessionId },
      );
      const list = (data.sessionMessages as { content: unknown }[]).map((m) =>
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      );
      return list.some((m) => m.includes('重新获取上游产物')) ? list : undefined;
    }, 20000, 'resume continue prompt in original session');
    expect(messages.some((m) => m.includes('completeCurrentNode'))).toBe(true);
    expect(controller.starts.length).toBe(startCount);
    const finalInst = await apiGql(page, token, instanceQuery, { id: instanceId });
    const reviewNode = finalInst.workflowInstance.nodes.find((n: Record<string, unknown>) => n.nodeKey === 'review');
    expect(reviewNode.sessionId).toBe(reviewSessionId);

    controller.disconnect();
  });
});
