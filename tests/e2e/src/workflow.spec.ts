import { test, expect, type Page } from '@playwright/test';
import { io as SocketIOClient, type Socket } from 'socket.io-client';
import { registerUser, createControllerKey, loginViaUI, createWorkspace, gqlRequest } from './helpers';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';
const MCP_BASE_URL = `${API_URL.replace(/\/graphql\/?$/, '')}/mcp`;

const sidebar = () => 'nav[aria-label="Sidebar"]';

// ---------------------------------------------------------------------------
// Fake controller（带工作流事件捕获 + 自动应答）
// ---------------------------------------------------------------------------

interface McpEndpoint { url: string; token: string; serverNames: string[] }
interface StartEvent { requestId: string; sessionId: string; serverType: string; mcpEndpoint?: McpEndpoint }
interface ResumeEvent { requestId: string; sessionId: string; mcpEndpoint?: McpEndpoint }
interface ControllerMessage { sessionId: string; content: string }

interface WorkflowController {
  controllerId: string;
  socket: Socket;
  starts: StartEvent[];
  resumes: ResumeEvent[];
  stops: string[];
  messages: ControllerMessage[];
  disconnect: () => void;
}

function registerWorkflowController(
  rawKey: string,
  hostname: string,
  opts: { startDelayMs?: number } = {},
): Promise<WorkflowController> {
  return new Promise((resolve, reject) => {
    const client = SocketIOClient(CONTROLLER_API_URL, {
      transports: ['websocket'], reconnection: false, forceNew: true,
    });
    const timer = setTimeout(() => { client.disconnect(); reject(new Error('Timeout registering controller')); }, 10000);

    const starts: StartEvent[] = [];
    const resumes: ResumeEvent[] = [];
    const stops: string[] = [];
    const messages: ControllerMessage[] = [];

    client.on('acp:check', (data: { requestId: string }) => {
      client.emit('acp:check:result', {
        requestId: data.requestId,
        servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
      });
    });

    // 工作区均非 git 仓库（本 spec 模板均不要求 worktree）
    client.on('git:check', (data: { requestId: string }) => {
      client.emit('git:check:result', { requestId: data.requestId, isGitRepo: false });
    });

    client.on('acp:start', (data: StartEvent) => {
      starts.push(data);
      const respond = () =>
        client.emit('acp:start:result', {
          requestId: data.requestId,
          sessionId: data.sessionId,
          success: true,
          externalSessionId: `ext_${data.sessionId}`,
        });
      // startDelayMs：模拟 harness 慢启动（验收#3 回归场景）
      if (opts.startDelayMs) {
        setTimeout(respond, opts.startDelayMs);
      } else {
        respond();
      }
    });

    // 空实例探测：返回固定 Mode/模型选项（验收#1 场景）
    client.on('acp:probe-options', (data: { requestId: string; serverType: string }) => {
      client.emit('acp:probe-options:result', {
        requestId: data.requestId,
        serverType: data.serverType,
        success: true,
        modes: [
          { id: 'code', name: 'Code' },
          { id: 'ask', name: 'Ask' },
        ],
        availableModels: [{ id: 'gpt-5', name: 'GPT-5', provider: 'openai' }],
        currentModeId: 'code',
        currentModelId: 'gpt-5',
      });
    });

    client.on('acp:resume', (data: ResumeEvent) => {
      resumes.push(data);
      client.emit('acp:resume:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
      });
    });

    client.on('acp:stop', (data: { sessionId: string }) => {
      stops.push(data.sessionId);
    });

    client.on('acp:message', (data: { sessionId: string; message: { type: string; content: string } }) => {
      messages.push({ sessionId: data.sessionId, content: String(data.message?.content ?? '') });
    });

    client.once('registered', (data: { controllerId: string }) => {
      clearTimeout(timer);
      resolve({
        controllerId: data.controllerId,
        socket: client,
        starts,
        resumes,
        stops,
        messages,
        disconnect: () => client.disconnect(),
      });
    });
    client.once('error', (data: { code: string; message: string }) => {
      clearTimeout(timer);
      client.disconnect();
      reject(new Error(`Register failed: ${data.message}`));
    });
    client.emit('register', { key: rawKey, hostname, version: '1.0.0' });
  });
}

/** 轮询等待条件满足（用于 socket 事件捕获与 API 状态） */
async function waitFor<T>(fn: () => T | Promise<T> | undefined | null | false, timeoutMs = 15000, label = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value as T;
    if (Date.now() - start > timeoutMs) throw new Error(`Timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ---------------------------------------------------------------------------
// GraphQL / MCP helpers
// ---------------------------------------------------------------------------

async function refreshCapabilities(page: Page, token: string, controllerId: string): Promise<void> {
  const res = await gqlRequest(page, `
    mutation RefreshAcpCapabilities($controllerId: ID!) {
      refreshAcpCapabilities(controllerId: $controllerId) { type available }
    }
  `, { controllerId }, token);
  const body = await res.json();
  expect(body.errors).toBeUndefined();
}

/** 三节点模板：需求输入(HUMAN) → AI执行(AI) → AI验收(AI) */
function threeNodeTemplateInput(name: string) {
  return {
    name,
    description: 'E2E 三节点工作流模板',
    nodes: [
      { nodeKey: 'input', type: 'HUMAN', name: '需求输入', stage: '需求', dependsOn: [], requiresWorktree: false },
      {
        nodeKey: 'exec', type: 'AI', name: 'AI执行', stage: '开发',
        prompts: ['阅读上游产物并完成执行'], artifactTitles: ['开发产物'],
        dependsOn: ['input'], requiresWorktree: false,
      },
      {
        nodeKey: 'verify', type: 'AI', name: 'AI验收', stage: '验收',
        prompts: ['验收开发产物'], artifactTitles: ['验收报告'],
        dependsOn: ['exec'], requiresWorktree: false,
      },
    ],
  };
}

async function createThreeNodeTemplate(page: Page, token: string, name: string): Promise<string> {
  const res = await gqlRequest(page, `
    mutation CreateWorkflowTemplate($input: WorkflowTemplateInput!) {
      createWorkflowTemplate(input: $input) { id }
    }
  `, { input: threeNodeTemplateInput(name) }, token);
  const body = await res.json();
  if (body.errors) throw new Error(`createWorkflowTemplate failed: ${JSON.stringify(body.errors)}`);
  return body.data.createWorkflowTemplate.id;
}

async function configureFromTemplate(page: Page, token: string, templateId: string, controllerId: string, name: string): Promise<string> {
  const res = await gqlRequest(page, `
    mutation ConfigureWorkflow($templateId: ID!, $input: ConfigureWorkflowInput!) {
      configureWorkflow(templateId: $templateId, input: $input) { id }
    }
  `, {
    templateId,
    input: {
      name,
      controllerId,
      nodes: [
        { nodeKey: 'input' },
        { nodeKey: 'exec', agentConfig: { acpServerType: 'opencode', initNewWorktree: false } },
        { nodeKey: 'verify', agentConfig: { acpServerType: 'opencode', initNewWorktree: false } },
      ],
    },
  }, token);
  const body = await res.json();
  if (body.errors) throw new Error(`configureWorkflow failed: ${JSON.stringify(body.errors)}`);
  return body.data.configureWorkflow.id;
}

interface InstanceNode {
  id: string;
  nodeKey: string;
  name: string;
  type: string;
  status: string;
  stage: string;
  sessionId: string | null;
  reworkCount: number;
}

async function instantiate(page: Page, token: string, configuredId: string, workspaceId: string, name: string) {
  const res = await gqlRequest(page, `
    mutation InstantiateWorkflow($configuredWorkflowId: ID!, $workspaceId: ID!, $name: String!) {
      instantiateWorkflow(configuredWorkflowId: $configuredWorkflowId, workspaceId: $workspaceId, name: $name) {
        id nodes { id nodeKey name type status stage sessionId reworkCount }
      }
    }
  `, { configuredWorkflowId: configuredId, workspaceId, name }, token);
  const body = await res.json();
  if (body.errors) throw new Error(`instantiateWorkflow failed: ${JSON.stringify(body.errors)}`);
  return body.data.instantiateWorkflow as { id: string; nodes: InstanceNode[] };
}

async function getInstance(page: Page, token: string, instanceId: string) {
  const res = await gqlRequest(page, `
    query WorkflowInstance($id: ID!) {
      workflowInstance(id: $id) {
        id name currentNodeNames
        nodes { id nodeKey name type status stage sessionId reworkCount prompts artifactTitles requiresWorktree rejectInfo { reason } failInfo { reason source } }
        blackboard { key value }
        blackboardTrash { key value }
      }
    }
  `, { id: instanceId }, token);
  const body = await res.json();
  expect(body.errors).toBeUndefined();
  return body.data.workflowInstance as {
    id: string;
    name: string;
    currentNodeNames: string[];
    nodes: (InstanceNode & {
      prompts?: string[] | null;
      artifactTitles?: string[] | null;
      requiresWorktree?: boolean;
      rejectInfo: { reason: string } | null;
      failInfo: { reason: string; source: string } | null;
    })[];
    blackboard: { key: string; value: string }[];
    blackboardTrash: { key: string; value: string }[];
  };
}

async function completeHumanNode(page: Page, token: string, instanceId: string, nodeId: string, input: string): Promise<void> {
  const res = await gqlRequest(page, `
    mutation CompleteHumanNode($instanceId: ID!, $nodeId: ID!, $input: String) {
      completeHumanNode(instanceId: $instanceId, nodeId: $nodeId, input: $input) { id status }
    }
  `, { instanceId, nodeId, input }, token);
  const body = await res.json();
  if (body.errors) throw new Error(`completeHumanNode failed: ${JSON.stringify(body.errors)}`);
}

async function rejectNode(page: Page, token: string, instanceId: string, nodeId: string, reason: string): Promise<void> {
  const res = await gqlRequest(page, `
    mutation RejectNode($instanceId: ID!, $nodeId: ID!, $reason: String!) {
      rejectNode(instanceId: $instanceId, nodeId: $nodeId, reason: $reason) { id status }
    }
  `, { instanceId, nodeId, reason }, token);
  const body = await res.json();
  if (body.errors) throw new Error(`rejectNode failed: ${JSON.stringify(body.errors)}`);
}

async function closeSession(page: Page, token: string, sessionId: string): Promise<void> {
  const res = await gqlRequest(page, `
    mutation CloseSession($id: ID!) { closeSession(id: $id) }
  `, { id: sessionId }, token);
  const body = await res.json();
  if (body.errors) throw new Error(`closeSession failed: ${JSON.stringify(body.errors)}`);
}

async function getSessionStatus(page: Page, token: string, sessionId: string): Promise<string> {
  const res = await gqlRequest(page, `
    query Session($id: ID!) { session(id: $id) { id status } }
  `, { id: sessionId }, token);
  const body = await res.json();
  expect(body.errors).toBeUndefined();
  return body.data.session.status;
}

async function getSessionMessagesText(page: Page, token: string, sessionId: string): Promise<string[]> {
  const res = await gqlRequest(page, `
    query SessionMessages($sessionId: ID!) { sessionMessages(sessionId: $sessionId, limit: 100) { id direction type content } }
  `, { sessionId }, token);
  const body = await res.json();
  expect(body.errors).toBeUndefined();
  return (body.data.sessionMessages as { content: unknown }[]).map((m) =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  );
}

async function getSessions(page: Page, token: string, includeWorkflowSessions: boolean) {
  const res = await gqlRequest(page, `
    query Sessions($includeWorkflowSessions: Boolean) {
      sessions(includeWorkflowSessions: $includeWorkflowSessions) { id status workflowInstanceId workflowNodeId }
    }
  `, { includeWorkflowSessions }, token);
  const body = await res.json();
  expect(body.errors).toBeUndefined();
  return body.data.sessions as { id: string; status: string; workflowInstanceId: string | null; workflowNodeId: string | null }[];
}

/** 调用平台工作流 MCP 工具（模拟 Agent 行为），返回 { isError, data } */
async function callWorkflowTool(
  page: Page,
  sessionId: string,
  mcpToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; data: Record<string, unknown> }> {
  const res = await page.request.post(`${MCP_BASE_URL}/${sessionId}/agent-workflow-tools`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mcpToken}` },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.error).toBeUndefined();
  return { isError: Boolean(body.result.isError), data: JSON.parse(body.result.content[0].text) };
}

/** 调用平台管理工作流 MCP 工具集（agent-workflow-admin-tools，模拟 AI 编排） */
async function callAdminTool(
  page: Page,
  sessionId: string,
  mcpToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; data: Record<string, unknown> }> {
  const res = await page.request.post(`${MCP_BASE_URL}/${sessionId}/agent-workflow-admin-tools`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mcpToken}` },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.error).toBeUndefined();
  return { isError: Boolean(body.result.isError), data: JSON.parse(body.result.content[0].text) };
}

// ---------------------------------------------------------------------------
// 公共 setup：用户 + fake controller + 工作区 + 模板 + 已配置工作流
// ---------------------------------------------------------------------------

interface WorkflowEnv {
  token: string;
  username: string;
  rawKey: string;
  hostname: string;
  controller: WorkflowController;
  workspaceId: string;
  workspacePath: string;
  configuredId: string;
}

async function setupWorkflowEnv(page: Page, tag: string): Promise<WorkflowEnv> {
  const { token, username } = await registerUser(page);
  const { rawKey } = await createControllerKey(page, token);
  const hostname = `wf-${tag}-host-${Date.now().toString(36)}`;
  const controller = await registerWorkflowController(rawKey, hostname);
  await refreshCapabilities(page, token, controller.controllerId);
  const workspacePath = `/tmp/e2e-wf-${tag}-${Date.now().toString(36)}`;
  const ws = await createWorkspace(page, controller.controllerId, workspacePath, token);
  const templateId = await createThreeNodeTemplate(page, token, `wf-${tag}-模板-${Date.now().toString(36)}`);
  const configuredId = await configureFromTemplate(page, token, templateId, controller.controllerId, `wf-${tag}-配置-${Date.now().toString(36)}`);
  return { token, username, rawKey, hostname, controller, workspaceId: ws.id, workspacePath, configuredId };
}

/** 实例化并完成首节点，推进到 AI执行 RUNNING，返回实例与 exec 会话信息 */
async function advanceToExecRunning(page: Page, env: WorkflowEnv, instanceName: string) {
  const inst = await instantiate(page, env.token, env.configuredId, env.workspaceId, instanceName);
  const inputNode = inst.nodes.find((n) => n.nodeKey === 'input')!;
  const execNode = inst.nodes.find((n) => n.nodeKey === 'exec')!;
  expect(inputNode.status).toBe('READY');
  expect(execNode.status).toBe('INITIALIZING');

  await completeHumanNode(page, env.token, inst.id, inputNode.id, '做一个计算器');
  const execStart = await waitFor(
    () => env.controller.starts.find((s) => s.sessionId),
    15000,
    'exec acp:start',
  );
  expect(execStart.mcpEndpoint?.token).toBeTruthy();
  return { instanceId: inst.id, inputNode, execNode, execStart };
}

/** 节点卡片定位（实例视图节点树） */
function nodeCard(page: Page, nodeName: string) {
  return page.locator('div.rounded-lg.border.p-3').filter({ hasText: nodeName });
}

test.describe('Workflow E2E', () => {

  // -------------------------------------------------------------------------
  // E2E-1 配置默认模板 → 实例化 → 人类节点输入需求 → AI 节点拉起
  // -------------------------------------------------------------------------
  test('E2E-1: instantiate via sidebar, complete human node via UI, AI node session started and hidden from sidebar', async ({ page }) => {
    test.setTimeout(60000);
    const env = await setupWorkflowEnv(page, 'e1');
    const instanceName = `wf-e1-实例-${Date.now().toString(36)}`;

    await loginViaUI(page, env.username);
    const nav = page.locator(sidebar());

    // 侧边栏展开 controller → workspace → 工作流分组 → 实例化入口
    await nav.getByRole('button', { name: new RegExp(`wf-e1-host`) }).click();
    const wsName = env.workspacePath.split('/').pop()!;
    await nav.getByRole('button', { name: new RegExp(wsName) }).click();
    await nav.getByRole('button', { name: '实例化工作流' }).click();

    // 实例化对话框：选择已配置工作流并命名实例
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('实例化工作流')).toBeVisible();
    await dialog.getByRole('button', { name: /wf-e1-配置/ }).click();
    await dialog.getByLabel('实例名称').fill(instanceName);
    await dialog.getByRole('button', { name: '下一步', exact: true }).click();
    await expect(dialog.getByText('实例化前配置')).toBeVisible();
    await dialog.getByRole('button', { name: '确认实例化', exact: true }).click();

    // 跳转到实例视图：首节点 READY（待开始），AI 节点 INITIALIZING（等待中）
    await page.waitForURL(/\/workflows\/[a-f0-9]+/, { timeout: 10000 });
    const instanceId = page.url().match(/\/workflows\/([a-f0-9]+)/)![1];
    await expect(page.getByRole('heading', { name: instanceName })).toBeVisible({ timeout: 10000 });
    await expect(nodeCard(page, '需求输入').getByText('待开始', { exact: true })).toBeVisible();
    // AI 节点 INITIALIZING（等待中）默认折叠，但状态 badge 仍可见
    await expect(nodeCard(page, 'AI执行').getByText('等待中', { exact: true })).toBeVisible();

    // 人类节点 UI 输入需求并完成 → 下游 AI 节点拉起会话
    const inputCard = nodeCard(page, '需求输入');
    await inputCard.getByLabel('需求输入 完成输入').fill('做一个计算器');
    await inputCard.getByRole('button', { name: '完成', exact: true }).click();

    const execStart = await waitFor(
      () => env.controller.starts.find((s) => s.mcpEndpoint?.serverNames.includes('agent-workflow-tools')),
      15000,
      'exec acp:start',
    );
    expect(execStart.serverType).toBe('opencode');
    const execSessionId = execStart.sessionId;

    // 实例状态推进（UI）：已完成节点默认折叠，状态 badge 仍可见
    await expect(page.getByRole('main').getByText('执行中：AI执行')).toBeVisible({ timeout: 15000 });
    await expect(nodeCard(page, '需求输入').getByText('已完成', { exact: true })).toBeVisible();
    await expect(nodeCard(page, 'AI执行').getByText('执行中', { exact: true })).toBeVisible();

    // 会话打标（API 校验）：默认排除工作流会话；includeWorkflowSessions=true 可见且带打标
    const defaultSessions = await getSessions(page, env.token, false);
    expect(defaultSessions.map((s) => s.id)).not.toContain(execSessionId);
    const allSessions = await getSessions(page, env.token, true);
    const wfSession = allSessions.find((s) => s.id === execSessionId);
    expect(wfSession).toBeDefined();
    expect(wfSession!.workflowInstanceId).toBe(instanceId);
    const inst = await getInstance(page, env.token, instanceId);
    expect(wfSession!.workflowNodeId).toBe(inst.nodes.find((n) => n.nodeKey === 'exec')!.id);

    // 侧边栏会话列表不可见工作流会话，但工作流实例入口可见
    await expect(nav.locator(`a[href="/sessions/${execSessionId}"]`)).toHaveCount(0);
    await expect(nav.locator(`a[href="/workflows/${instanceId}"]`)).toBeVisible({ timeout: 15000 });

    env.controller.disconnect();
  });

  // -------------------------------------------------------------------------
  // E2E-2 AI 节点完成接力
  // -------------------------------------------------------------------------
  test('E2E-2: completeCurrentNode relays to downstream session and ends upstream session', async ({ page }) => {
    test.setTimeout(60000);
    const env = await setupWorkflowEnv(page, 'e2');
    const { instanceId, execStart } = await advanceToExecRunning(page, env, `wf-e2-实例-${Date.now().toString(36)}`);

    // fake controller 模拟 Agent：用节点 token 调 completeCurrentNode
    const result = await callWorkflowTool(page, execStart.sessionId, execStart.mcpEndpoint!.token, 'completeCurrentNode', {
      artifacts: [{ title: '开发产物', value: '计算器代码 v1' }],
    });
    expect(result.isError).toBe(false);

    // 下游 AI验收 会话收到 acp:start
    const verifyStart = await waitFor(
      () => env.controller.starts.find((s) => s.sessionId !== execStart.sessionId),
      15000,
      'verify acp:start',
    );
    expect(verifyStart.mcpEndpoint?.serverNames).toContain('agent-workflow-tools');

    // 上游会话结束（acp:stop + 状态 ended）
    await waitFor(() => env.controller.stops.includes(execStart.sessionId) || undefined, 15000, 'exec acp:stop');
    await waitFor(
      async () => (await getSessionStatus(page, env.token, execStart.sessionId)) === 'ended',
      15000,
      'exec session ended',
    );

    // 下游会话提示词含上游产物（会话首条 input 消息）
    const verifyMessages = await getSessionMessagesText(page, env.token, verifyStart.sessionId);
    const prompt = verifyMessages.find((m) => m.includes('你身处一个工作流系统'));
    expect(prompt).toBeDefined();
    expect(prompt!).toContain('计算器代码 v1');
    expect(prompt!).toContain('验收开发产物');

    // 实例状态：exec DONE，verify RUNNING
    const inst = await getInstance(page, env.token, instanceId);
    expect(inst.nodes.find((n) => n.nodeKey === 'exec')!.status).toBe('DONE');
    expect(inst.nodes.find((n) => n.nodeKey === 'verify')!.status).toBe('RUNNING');
    expect(inst.currentNodeNames).toContain('AI验收');

    env.controller.disconnect();
  });

  // -------------------------------------------------------------------------
  // E2E-3 打回 → 返工 → 复工
  // -------------------------------------------------------------------------
  test('E2E-3: reject triggers rework with reason, completeCurrentRework resumes downstream', async ({ page }) => {
    test.setTimeout(90000);
    const env = await setupWorkflowEnv(page, 'e3');
    const { instanceId, execStart } = await advanceToExecRunning(page, env, `wf-e3-实例-${Date.now().toString(36)}`);

    // exec 完成 → verify RUNNING
    await callWorkflowTool(page, execStart.sessionId, execStart.mcpEndpoint!.token, 'completeCurrentNode', {
      artifacts: [{ title: '开发产物', value: '计算器代码 v1' }],
    });
    const verifyStart = await waitFor(
      () => env.controller.starts.find((s) => s.sessionId !== execStart.sessionId),
      15000,
      'verify acp:start',
    );
    await waitFor(() => env.controller.stops.includes(execStart.sessionId) || undefined, 15000, 'exec acp:stop');

    await loginViaUI(page, env.username);
    await page.goto(`/workflows/${instanceId}`);
    await expect(page.getByRole('main').getByText('执行中：AI验收')).toBeVisible({ timeout: 15000 });

    // 人类打回 verify 节点
    let inst = await getInstance(page, env.token, instanceId);
    const verifyNodeId = inst.nodes.find((n) => n.nodeKey === 'verify')!.id;
    await rejectNode(page, env.token, instanceId, verifyNodeId, '结果不符合需求');

    // UI：verify 已打回 + 打回理由，exec 返工中
    await expect(nodeCard(page, 'AI验收').getByText('已打回', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(nodeCard(page, 'AI验收').getByText('打回理由：结果不符合需求')).toBeVisible();
    await expect(nodeCard(page, 'AI执行').getByText('返工中', { exact: true })).toBeVisible();

    // 原 exec 会话被 resume（acp:resume），并收到打回原因消息（会话消息记录）
    const execResume = await waitFor(
      () => env.controller.resumes.find((r) => r.sessionId === execStart.sessionId),
      15000,
      'exec acp:resume',
    );
    expect(execResume.mcpEndpoint?.token).toBeTruthy();
    const execMessages = await waitFor(
      async () => {
        const msgs = await getSessionMessagesText(page, env.token, execStart.sessionId);
        return msgs.find((m) => m.includes('打回原因：结果不符合需求'));
      },
      15000,
      'rework reason message',
    );
    expect(execMessages).toContain('completeCurrentRework');

    // 返工完成（resume 后的新 token）→ 下游 REJECT→RUNNING
    const reworkResult = await callWorkflowTool(page, execStart.sessionId, execResume.mcpEndpoint!.token, 'completeCurrentRework', {
      artifacts: [{ title: '开发产物', value: '计算器代码 v2' }],
    });
    expect(reworkResult.isError).toBe(false);

    // verify 会话（未结束）收到复工通知消息
    await waitFor(
      () => env.controller.messages.find((m) => m.sessionId === verifyStart.sessionId && m.content.includes('上游节点已完成返工')),
      15000,
      'verify resume message',
    );

    // 实例状态与黑板：exec DONE / verify RUNNING；旧产物入垃圾桶，新产物上黑板
    inst = await getInstance(page, env.token, instanceId);
    const execNode = inst.nodes.find((n) => n.nodeKey === 'exec')!;
    expect(execNode.status).toBe('DONE');
    expect(execNode.reworkCount).toBe(1);
    expect(inst.nodes.find((n) => n.nodeKey === 'verify')!.status).toBe('RUNNING');
    const artifactKey = `${execNode.id}-AI执行-产物-开发产物`;
    expect(inst.blackboard.find((e) => e.key === artifactKey)?.value).toBe('计算器代码 v2');
    expect(inst.blackboardTrash.find((e) => e.key === artifactKey)?.value).toBe('计算器代码 v1');

    // UI：verify 回到执行中；exec 已完成（默认折叠），返工次数仍可见
    await expect(nodeCard(page, 'AI验收').getByText('执行中', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(nodeCard(page, 'AI执行').getByText('返工 1 次')).toBeVisible();

    env.controller.disconnect();
  });

  // -------------------------------------------------------------------------
  // E2E-4 会话兜底
  // -------------------------------------------------------------------------
  test('E2E-4: session ended without node transition gets resumed with fallback prompt (once per node)', async ({ page }) => {
    test.setTimeout(60000);
    const env = await setupWorkflowEnv(page, 'e4');
    const { instanceId, execStart } = await advanceToExecRunning(page, env, `wf-e4-实例-${Date.now().toString(36)}`);
    const execSessionId = execStart.sessionId;

    // 会话直接结束（节点未转移）→ acp:stop 成功
    await closeSession(page, env.token, execSessionId);
    await waitFor(() => env.controller.stops.includes(execSessionId) || undefined, 15000, 'exec acp:stop');

    // 兜底：会话被 resume（acp:resume）且收到兜底提示词（仅 1 次）
    await waitFor(
      () => env.controller.resumes.find((r) => r.sessionId === execSessionId),
      15000,
      'fallback acp:resume',
    );
    const fallbackMsg = await waitFor(
      async () => {
        const msgs = await getSessionMessagesText(page, env.token, execSessionId);
        return msgs.find((m) => m.includes('你身处一个自动化工作流系统'));
      },
      15000,
      'fallback prompt message',
    );
    expect(fallbackMsg).toContain('completeCurrentNode');

    // 节点仍 RUNNING（未转移），会话恢复可用
    const inst = await getInstance(page, env.token, instanceId);
    expect(inst.nodes.find((n) => n.nodeKey === 'exec')!.status).toBe('RUNNING');
    await waitFor(
      async () => (await getSessionStatus(page, env.token, execSessionId)) === 'idling',
      15000,
      'exec session idling after fallback resume',
    );

    // 再次结束会话：每节点仅兜底 1 次，不再 resume；节点升级为 FAILED（阻断流程）
    await closeSession(page, env.token, execSessionId);
    await waitFor(() => env.controller.stops.filter((s) => s === execSessionId).length >= 2 || undefined, 15000, 'second acp:stop');
    await page.waitForTimeout(3000);
    expect(env.controller.resumes.filter((r) => r.sessionId === execSessionId)).toHaveLength(1);
    const msgsAfter = await getSessionMessagesText(page, env.token, execSessionId);
    expect(msgsAfter.filter((m) => m.includes('你身处一个自动化工作流系统'))).toHaveLength(1);

    // 节点 FAILED（SESSION_STUCK），流程阻断
    const failedNode = await waitFor(
      async () => {
        const i = await getInstance(page, env.token, instanceId);
        const n = i.nodes.find((n) => n.nodeKey === 'exec')!;
        return n.status === 'FAILED' ? n : undefined;
      },
      15000,
      'exec node FAILED after second stop',
    );
    expect(failedNode.failInfo?.source).toBe('SESSION_STUCK');

    // UI 强提醒：节点「失败」badge + 顶部阻断 banner
    await loginViaUI(page, env.username);
    await page.goto(`/workflows/${instanceId}`);
    await expect(nodeCard(page, 'AI执行').getByText('失败', { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('alert')).toContainText('需要人工介入');
    await expect(page.getByRole('alert')).toContainText('AI执行');

    // 人类打开会话点「继续」恢复会话（会话关闭后旧 MCP token 已失效，需重新签发），
    // 再在对话中给出指示，AI 调 resumeFailedNode 将节点恢复为 RUNNING
    const resumeRes = await gqlRequest(page, `
      mutation ResumeSession($id: ID!) { resumeSession(id: $id) { success error } }
    `, { id: execSessionId }, env.token);
    expect((await resumeRes.json()).data.resumeSession.success).toBe(true);
    await waitFor(
      () => env.controller.resumes.filter((r) => r.sessionId === execSessionId).length >= 2 || undefined,
      15000,
      'manual acp:resume',
    );
    const manualResume = env.controller.resumes.filter((r) => r.sessionId === execSessionId).at(-1)!;
    const mcpToken = manualResume.mcpEndpoint?.token ?? execStart.mcpEndpoint!.token;
    const resumeResult = await callWorkflowTool(page, execSessionId, mcpToken, 'resumeFailedNode', {});
    expect(resumeResult.isError).toBe(false);
    expect(resumeResult.data).toMatchObject({ status: 'RUNNING' });
    const instResumed = await getInstance(page, env.token, instanceId);
    expect(instResumed.nodes.find((n) => n.nodeKey === 'exec')!.status).toBe('RUNNING');
    expect(instResumed.nodes.find((n) => n.nodeKey === 'exec')!.failInfo).toBeNull();

    env.controller.disconnect();
  });

  // -------------------------------------------------------------------------
  // E2E-5 实例视图 UI
  // -------------------------------------------------------------------------
  test('E2E-5: instance view shows stage-grouped node tree, status badges, blackboard and session side panel', async ({ page }) => {
    test.setTimeout(60000);
    const env = await setupWorkflowEnv(page, 'e5');
    const instanceName = `wf-e5-实例-${Date.now().toString(36)}`;
    const { instanceId, inputNode, execStart } = await advanceToExecRunning(page, env, instanceName);

    await loginViaUI(page, env.username);
    await page.goto(`/workflows/${instanceId}`);

    // 标题与当前执行节点 badge
    await expect(page.getByRole('heading', { name: instanceName })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('main').getByText('执行中：AI执行')).toBeVisible();

    // 节点树按阶段分组
    await expect(page.getByRole('heading', { name: '需求', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '开发', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '验收', exact: true })).toBeVisible();

    // 状态 badge：已完成/等待中默认折叠（展开后断言），执行中默认展开
    const inputCardE5s = nodeCard(page, '需求输入');
    await inputCardE5s.getByRole('button', { name: '需求输入 展开' }).click();
    await expect(inputCardE5s.getByText('已完成', { exact: true })).toBeVisible();
    await expect(nodeCard(page, 'AI执行').getByText('执行中', { exact: true })).toBeVisible();
    const verifyCardE5 = nodeCard(page, 'AI验收');
    await verifyCardE5.getByRole('button', { name: 'AI验收 展开' }).click();
    await expect(verifyCardE5.getByText('等待中', { exact: true })).toBeVisible();
    await expect(nodeCard(page, '需求输入').getByText('人类', { exact: true })).toBeVisible();
    await expect(nodeCard(page, 'AI执行').getByText('AI', { exact: true })).toBeVisible();

    // 黑板面板：默认折叠显示数量，展开后首节点产物可见
    const blackboardToggle = page.getByRole('button', { name: /^工作流黑板（\d+）$/ });
    await expect(blackboardToggle).toBeVisible();
    await blackboardToggle.click();
    const blackboardSection = blackboardToggle.locator('..');
    await expect(blackboardSection.getByText(`${inputNode.id}-需求输入-产物-输入`)).toBeVisible();
    await expect(blackboardSection.getByText('做一个计算器')).toBeVisible();

    // 节点产物聚合：产物同时展示在对应节点卡片内
    const inputCardE5 = nodeCard(page, '需求输入');
    await expect(inputCardE5.getByText('产物（1）')).toBeVisible();
    await expect(inputCardE5.getByText('做一个计算器')).toBeVisible();
    await expect(nodeCard(page, 'AI执行').getByText(/^产物（/)).toBeHidden();

    // 点击会话入口打开侧面板（SessionView 可见，展示节点提示词）
    await nodeCard(page, 'AI执行').getByRole('button', { name: '会话' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('节点会话')).toBeVisible();
    await expect(dialog.getByText(/你身处一个工作流系统/)).toBeVisible({ timeout: 15000 });
    expect(execStart.sessionId).toBeTruthy();

    // 会话面板足够宽（≥ max-w-4xl）且内容不横向溢出 client area
    // （clientWidth 不受入场 zoom 动画影响，boundingBox 会在动画中途量到缩放后的尺寸）
    const { width, overflowX } = await dialog.evaluate((el) => ({
      width: el.clientWidth,
      overflowX: el.scrollWidth - el.clientWidth,
    }));
    expect(width).toBeGreaterThanOrEqual(896);
    expect(overflowX).toBeLessThanOrEqual(1);

    env.controller.disconnect();
  });

  // -------------------------------------------------------------------------
  // E2E-6 设置页模板/配置管理 UI
  // -------------------------------------------------------------------------
  test('E2E-6: settings workflow section manages templates and configured workflows', async ({ page }) => {
    test.setTimeout(90000);
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const hostname = `wf-e6-host-${Date.now().toString(36)}`;
    const controller = await registerWorkflowController(rawKey, hostname);
    await refreshCapabilities(page, token, controller.controllerId);

    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    const section = page.locator('#workflow-section');
    await expect(section).toBeVisible({ timeout: 5000 });

    // 工作流 section 可见：操作按钮 + 内置模板
    await expect(section.getByRole('button', { name: '创建工作流模板' })).toBeVisible();
    await expect(section.getByRole('button', { name: '配置工作流' }).first()).toBeVisible();
    const builtinCard = section.locator('[data-slot="card"]').filter({ hasText: '开发工作流' }).filter({ hasText: '内置' });
    await expect(builtinCard).toBeVisible();

    // 创建模板（TemplateEditorDialog）
    const templateName = `E2E模板${Date.now().toString(36)}`;
    await section.getByRole('button', { name: '创建工作流模板' }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByText('定义工作流的节点、依赖关系、提示词与产物', { exact: false })).toBeVisible();
    await dialog.getByLabel('模板名称').fill(templateName);
    await dialog.getByLabel('节点 1 标识').fill('input');
    await dialog.getByLabel('节点 1 名称').fill('需求输入');
    await dialog.getByLabel('节点 1 阶段').fill('需求');
    await dialog.getByRole('button', { name: '添加节点' }).click();
    await dialog.getByLabel('节点 2 标识').fill('exec');
    await dialog.getByLabel('节点 2 名称').fill('AI执行');
    await dialog.getByLabel('节点 2 阶段').fill('开发');
    await dialog.getByLabel('节点 2 提示词').fill('执行开发任务');
    await dialog.getByLabel('节点 2 产物标题').fill('开发产物');
    await dialog.getByText('需求输入（input）').click();
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 10000 });
    const createdCard = section.locator('[data-slot="card"]').filter({ hasText: templateName });
    await expect(createdCard).toBeVisible({ timeout: 10000 });
    await expect(createdCard.getByText('v1')).toBeVisible();

    // 内置模板只读：查看对话框无保存按钮、名称输入禁用
    await builtinCard.getByRole('button', { name: '查看' }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByText('查看工作流模板')).toBeVisible();
    await expect(dialog.getByLabel('模板名称')).toBeDisabled();
    await expect(dialog.getByRole('button', { name: '保存' })).toHaveCount(0);
    await dialog.getByRole('button', { name: '关闭' }).click();
    await expect(dialog).not.toBeVisible();

    // 从内置模板「配置工作流」：复制来源文案可见
    await builtinCard.getByRole('button', { name: '配置工作流' }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/本配置复制自模板《开发工作流》/)).toBeVisible();

    // 切换为两节点模板（减少 AI 节点配置），选择 Controller 与 Harness 工具后保存
    await dialog.locator('[data-slot="select-trigger"][aria-label="工作流模板"]').click();
    await page.getByRole('option', { name: new RegExp(templateName) }).click();
    await dialog.getByLabel('工作流名称').fill(`E2E配置${Date.now().toString(36)}`);
    await dialog.locator('[data-slot="select-trigger"][aria-label="Controller"]').click();
    await page.getByRole('option', { name: hostname }).click();
    await dialog.locator('[data-slot="select-trigger"][aria-label="AI执行 Harness 工具"]').click();
    await page.getByRole('option', { name: 'opencode', exact: true }).click();
    const configuredName = await dialog.getByLabel('工作流名称').inputValue();
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 10000 });

    // 已配置工作流卡片出现，复制关系文案可见
    const configuredCard = section.locator('[data-slot="card"]').filter({ hasText: configuredName });
    await expect(configuredCard).toBeVisible({ timeout: 10000 });
    await expect(configuredCard.getByText(/复制自模板 v1/)).toBeVisible();

    controller.disconnect();
  });

  // -------------------------------------------------------------------------
  // E2E-7 RUNNING 人类节点 UI 完成 + 输入草稿保留（验收#2/#4 回归）
  // -------------------------------------------------------------------------
  test('E2E-7: RUNNING human node completes via UI; draft survives polling refresh and reload', async ({ page }) => {
    test.setTimeout(120000);
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const controller = await registerWorkflowController(rawKey, `wf-e7-host-${Date.now().toString(36)}`);
    await refreshCapabilities(page, token, controller.controllerId);
    const ws = await createWorkspace(page, controller.controllerId, `/tmp/e2e-wf-e7-${Date.now().toString(36)}`, token);

    // 三节点模板：需求输入(HUMAN) → AI执行(AI) → 评审(HUMAN)
    const tplRes = await gqlRequest(page, `
      mutation CreateWorkflowTemplate($input: WorkflowTemplateInput!) {
        createWorkflowTemplate(input: $input) { id }
      }
    `, {
      input: {
        name: `wf-e7-模板-${Date.now().toString(36)}`,
        description: 'E2E 验收#4 模板',
        nodes: [
          { nodeKey: 'input', type: 'HUMAN', name: '需求输入', stage: '需求', dependsOn: [], requiresWorktree: false },
          {
            nodeKey: 'exec', type: 'AI', name: 'AI执行', stage: '开发',
            prompts: ['阅读上游产物并完成执行'], artifactTitles: ['开发产物'],
            dependsOn: ['input'], requiresWorktree: false,
          },
          { nodeKey: 'review', type: 'HUMAN', name: '评审', stage: '验收', dependsOn: ['exec'], requiresWorktree: false },
        ],
      },
    }, token);
    const templateId = (await tplRes.json()).data.createWorkflowTemplate.id;

    const cfgRes = await gqlRequest(page, `
      mutation ConfigureWorkflow($templateId: ID!, $input: ConfigureWorkflowInput!) {
        configureWorkflow(templateId: $templateId, input: $input) { id }
      }
    `, {
      templateId,
      input: {
        name: `wf-e7-配置-${Date.now().toString(36)}`,
        controllerId: controller.controllerId,
        nodes: [
          { nodeKey: 'input' },
          { nodeKey: 'exec', agentConfig: { acpServerType: 'opencode', initNewWorktree: false } },
          { nodeKey: 'review' },
        ],
      },
    }, token);
    const configuredId = (await cfgRes.json()).data.configureWorkflow.id;

    // 实例化并完成首节点 → exec RUNNING
    const inst = await instantiate(page, token, configuredId, ws.id, `wf-e7-实例-${Date.now().toString(36)}`);
    const inputNode = inst.nodes.find((n) => n.nodeKey === 'input')!;
    const reviewNode = inst.nodes.find((n) => n.nodeKey === 'review')!;
    await completeHumanNode(page, token, inst.id, inputNode.id, '做一个计算器');
    const execStart = await waitFor(() => controller.starts[0], 15000, 'exec acp:start');

    // exec 完成 → 下游评审人类节点被引擎自动激活为 RUNNING
    await callWorkflowTool(page, execStart.sessionId, execStart.mcpEndpoint!.token, 'completeCurrentNode', {
      artifacts: [{ title: '开发产物', value: '计算器代码 v1' }],
    });
    await waitFor(
      async () => (await getInstance(page, token, inst.id)).nodes.find((n) => n.nodeKey === 'review')!.status === 'RUNNING' || undefined,
      15000,
      'review node RUNNING',
    );

    await loginViaUI(page, username);
    await page.goto(`/workflows/${inst.id}`);
    const reviewCard = nodeCard(page, '评审');
    await expect(reviewCard.getByText('执行中', { exact: true })).toBeVisible({ timeout: 15000 });

    // 验收#2：输入内容跨 5s 轮询周期保留，且轮询不得打断输入（焦点保持）
    const textarea = reviewCard.getByLabel('评审 完成输入');
    await textarea.fill('同意方案，但请补充埋点');
    await page.waitForTimeout(6000);
    await expect(textarea).toHaveValue('同意方案，但请补充埋点');
    await expect(textarea).toBeFocused();

    // 页面刷新后从 localStorage 恢复
    await page.reload();
    await expect(nodeCard(page, '评审').getByLabel('评审 完成输入')).toHaveValue('同意方案，但请补充埋点', { timeout: 15000 });

    // 验收#4：RUNNING 状态点「完成」应成功（不再报「不允许执行「启动」」）
    await nodeCard(page, '评审').getByRole('button', { name: '完成', exact: true }).click();
    await expect(nodeCard(page, '评审').getByRole('button', { name: '评审 展开' })).toBeVisible({ timeout: 15000 });
    await nodeCard(page, '评审').getByRole('button', { name: '评审 展开' }).click();
    await expect(nodeCard(page, '评审').getByText('已完成', { exact: true })).toBeVisible();

    // 草稿已清除，产物写入黑板
    const draft = await page.evaluate(
      (key) => localStorage.getItem(key),
      `workflow-node-draft:${inst.id}:${reviewNode.id}`,
    );
    expect(draft).toBeNull();
    const instAfter = await getInstance(page, token, inst.id);
    expect(instAfter.blackboard.find((e) => e.key === `${reviewNode.id}-评审-产物-输入`)?.value).toBe('同意方案，但请补充埋点');

    controller.disconnect();
  });

  // -------------------------------------------------------------------------
  // E2E-8 harness 慢启动时首条提示词排队补发（验收#3 回归）
  // -------------------------------------------------------------------------
  test('E2E-8: first prompt is queued and flushed when harness start is slow', async ({ page }) => {
    test.setTimeout(60000);
    const { token } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    // 延迟 2s 回 acp:start:result，模拟真实 harness 慢启动
    const controller = await registerWorkflowController(rawKey, `wf-e8-host-${Date.now().toString(36)}`, { startDelayMs: 2000 });
    await refreshCapabilities(page, token, controller.controllerId);
    const ws = await createWorkspace(page, controller.controllerId, `/tmp/e2e-wf-e8-${Date.now().toString(36)}`, token);
    const templateId = await createThreeNodeTemplate(page, token, `wf-e8-模板-${Date.now().toString(36)}`);
    const configuredId = await configureFromTemplate(page, token, templateId, controller.controllerId, `wf-e8-配置-${Date.now().toString(36)}`);

    const inst = await instantiate(page, token, configuredId, ws.id, `wf-e8-实例-${Date.now().toString(36)}`);
    const inputNode = inst.nodes.find((n) => n.nodeKey === 'input')!;
    await completeHumanNode(page, token, inst.id, inputNode.id, '做一个计算器');

    const execStart = await waitFor(() => controller.starts[0], 15000, 'exec acp:start');

    // start:result 延迟期间 orchestrator 的首条提示词被排队；会话激活后必须补发到 controller socket
    // （修复前：消息被静默丢弃，controller.messages 永远收不到，harness 不开始工作）
    const prompt = await waitFor(
      () => controller.messages.find(
        (m) => m.sessionId === execStart.sessionId && m.content.includes('你身处一个工作流系统'),
      ),
      15000,
      'queued prompt delivered to controller after slow start',
    );
    expect(prompt.content).toContain('做一个计算器');

    controller.disconnect();
  });

  // -------------------------------------------------------------------------
  // E2E-9 配置工作流对话框 Mode/模型动态下拉（验收#1 回归）
  // -------------------------------------------------------------------------
  test('E2E-9: configure dialog shows probed mode/model dropdowns after harness selection', async ({ page }) => {
    test.setTimeout(90000);
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const hostname = `wf-e9-host-${Date.now().toString(36)}`;
    const controller = await registerWorkflowController(rawKey, hostname);
    await refreshCapabilities(page, token, controller.controllerId);

    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    const section = page.locator('#workflow-section');
    await expect(section).toBeVisible({ timeout: 5000 });

    await section.getByRole('button', { name: '配置工作流' }).first().click();
    const dialog = page.getByRole('dialog');

    // 选择内置模板（含 AI 节点）与 Controller
    await dialog.locator('[data-slot="select-trigger"][aria-label="工作流模板"]').click();
    await page.getByRole('option', { name: /开发工作流/ }).first().click();
    await dialog.locator('[data-slot="select-trigger"][aria-label="Controller"]').click();
    await page.getByRole('option', { name: hostname }).click();

    // 选择首个 AI 节点的 Harness 工具 → 触发空实例探测
    await dialog.locator('[data-slot="select-trigger"][aria-label*="Harness 工具"]').first().click();
    await page.getByRole('option', { name: 'opencode', exact: true }).click();

    // 探测完成后 Mode 变为下拉，包含 Code/Ask 选项
    const modeTrigger = dialog.locator('[data-slot="select-trigger"][aria-label*="Mode"]').first();
    await expect(modeTrigger).toBeVisible({ timeout: 40000 });
    await modeTrigger.click();
    await page.getByRole('option', { name: 'Code' }).click();

    // 模型下拉包含 GPT-5
    const modelTrigger = dialog.locator('[data-slot="select-trigger"][aria-label*="模型"]').first();
    await expect(modelTrigger).toBeVisible();
    await modelTrigger.click();
    await expect(page.getByRole('option', { name: 'GPT-5' })).toBeVisible();

    controller.disconnect();
  });

  // -------------------------------------------------------------------------
  // E2E-10 断连会话恢复（验收第四轮）
  // -------------------------------------------------------------------------
  test('E2E-10: disconnected workflow node session resumes via confirm dialog and auto-sends workflow continue prompt', async ({ page }) => {
    test.setTimeout(90000);
    const env = await setupWorkflowEnv(page, 'e10');
    const { instanceId, execStart } = await advanceToExecRunning(page, env, `wf-e10-实例-${Date.now().toString(36)}`);
    const execSessionId = execStart.sessionId;

    // Controller 断连 → 会话变为 disconnected（兜底提示词在此状态下无法送达，需人工「继续」）
    env.controller.disconnect();
    await waitFor(
      async () => (await getSessionStatus(page, env.token, execSessionId)) === 'disconnected' || undefined,
      15000,
      'exec session disconnected',
    );

    // UI：打开节点会话，断连时头部按钮为「继续」而非「关闭」
    await loginViaUI(page, env.username);
    await page.goto(`/workflows/${instanceId}`);
    await expect(page.getByRole('heading', { name: /wf-e10-实例/ })).toBeVisible({ timeout: 10000 });
    await nodeCard(page, 'AI执行').getByRole('button', { name: '会话' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('节点会话')).toBeVisible();
    await expect(dialog.getByText('已断连')).toBeVisible({ timeout: 10000 });
    await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeHidden();
    const continueButton = dialog.getByRole('button', { name: '继续', exact: true });
    await expect(continueButton).toBeVisible();

    // Controller 重连（同一 rawKey）→ GET_CONTROLLERS 轮询解锁「继续」按钮
    const controller2 = await registerWorkflowController(env.rawKey, env.hostname);
    await expect(continueButton).toBeEnabled({ timeout: 20000 });

    // 点击「继续」→ 确认框：检测到 AI 断连，提示是否让 AI 继续
    await continueButton.click();
    await expect(page.getByText('检测到 AI 断连')).toBeVisible();
    await expect(page.getByText(/工作流 MCP 工具继续之前的工作/)).toBeVisible();
    await page.getByRole('button', { name: '让 AI 继续' }).click();

    // 确认后：resume 流程（新 controller 自动应答 acp:resume）
    await waitFor(
      () => controller2.resumes.find((r) => r.sessionId === execSessionId),
      15000,
      'acp:resume after reconnect',
    );

    // 会话 ready（idling）后自动发送工作流继续提示词，显式要求调用 MCP 工具
    const promptMsg = await waitFor(
      async () => {
        const msgs = await getSessionMessagesText(page, env.token, execSessionId);
        return msgs.find((m) => m.includes('resumeFailedNode'));
      },
      20000,
      'workflow continue prompt message',
    );
    expect(promptMsg).toContain('getNodeInfo');
    expect(promptMsg).toContain('completeCurrentNode');

    // 节点仍 RUNNING，AI 可继续之前的工作（工作流工具可用）
    const inst = await getInstance(page, env.token, instanceId);
    expect(inst.nodes.find((n) => n.nodeKey === 'exec')!.status).toBe('RUNNING');
    const resumeEvent = controller2.resumes.find((r) => r.sessionId === execSessionId)!;
    const done = await callWorkflowTool(
      page,
      execSessionId,
      resumeEvent.mcpEndpoint?.token ?? execStart.mcpEndpoint!.token,
      'completeCurrentNode',
      { artifacts: [{ title: '开发产物', value: '计算器代码' }] },
    );
    expect(done.isError).toBe(false);
    expect(done.data).toMatchObject({ status: 'DONE' });

    controller2.disconnect();
  });

  // -------------------------------------------------------------------------
  // E2E-11 实例页删除实例（软删除：停流程 + 删节点会话 + 侧边栏移除）
  // -------------------------------------------------------------------------
  test('E2E-11: delete workflow instance from instance page stops the workflow and removes it from sidebar', async ({ page }) => {
    test.setTimeout(60000);
    const env = await setupWorkflowEnv(page, 'e11');
    const instanceName = `wf-e11-实例-${Date.now().toString(36)}`;
    const { instanceId, execStart } = await advanceToExecRunning(page, env, instanceName);

    await loginViaUI(page, env.username);
    await page.goto(`/workflows/${instanceId}`);
    await expect(page.getByRole('heading', { name: instanceName })).toBeVisible({ timeout: 10000 });

    // 删除实例：确认框说明停流程 + 删全部节点会话
    await page.getByRole('button', { name: /删除实例/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/停止流程运转/)).toBeVisible();
    await expect(dialog.getByText(/删除全部节点会话/)).toBeVisible();
    await dialog.getByRole('button', { name: '确认删除' }).click();

    // 跳回会话列表；实例页不可再访问
    await page.waitForURL(/\/sessions/, { timeout: 10000 });
    await page.goto(`/workflows/${instanceId}`);
    await expect(page.getByText('工作流实例不存在')).toBeVisible({ timeout: 10000 });

    // 侧边栏工作流分组不再显示该实例
    const nav = page.locator(sidebar());
    await expect(nav.locator(`a[href="/workflows/${instanceId}"]`)).toHaveCount(0);

    // 节点会话已被删除（API 校验，含工作流会话）
    const allSessions = await getSessions(page, env.token, true);
    expect(allSessions.find((s) => s.id === execStart.sessionId)).toBeUndefined();

    env.controller.disconnect();
  });

  // -------------------------------------------------------------------------
  // E2E-12 移动端窄屏：节点按状态默认折叠/展开，页面无横向溢出
  // -------------------------------------------------------------------------
  test('E2E-12: mobile viewport - nodes collapse by status and page has no horizontal overflow', async ({ page }) => {
    test.setTimeout(60000);
    const env = await setupWorkflowEnv(page, 'e12');
    const instanceName = `wf-e12-实例-${Date.now().toString(36)}`;
    const { instanceId } = await advanceToExecRunning(page, env, instanceName);

    await page.setViewportSize({ width: 375, height: 720 });
    await loginViaUI(page, env.username);
    await page.goto(`/workflows/${instanceId}`);
    await expect(page.getByRole('heading', { name: instanceName })).toBeVisible({ timeout: 10000 });

    // 默认折叠：已完成（需求输入）/等待中（AI验收）——状态 badge 仍展示，内容区（产物）隐藏
    const inputCard = nodeCard(page, '需求输入');
    await expect(inputCard.getByText('人类', { exact: true })).toBeVisible();
    await expect(inputCard.getByText('已完成', { exact: true })).toBeVisible();
    await expect(inputCard.getByText('产物（1）')).toBeHidden();
    await expect(nodeCard(page, 'AI验收').getByText('等待中', { exact: true })).toBeVisible();
    // 默认展开：执行中（AI执行）
    await expect(nodeCard(page, 'AI执行').getByText('执行中', { exact: true })).toBeVisible();

    // 展开已完成节点 → 产物可见；再折叠 → 产物隐藏但状态 badge 仍在
    await inputCard.getByRole('button', { name: '需求输入 展开' }).click();
    await expect(inputCard.getByText('产物（1）')).toBeVisible();
    await inputCard.getByRole('button', { name: '需求输入 折叠' }).click();
    await expect(inputCard.getByText('产物（1）')).toBeHidden();
    await expect(inputCard.getByText('已完成', { exact: true })).toBeVisible();

    // 窄屏无横向溢出
    const overflowX = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflowX).toBeLessThanOrEqual(1);

    // 极端内容：exec 完成并写入超长不可断产物（无空格长串 + 超长标题），全部展开后仍无横向溢出
    const execStartE12 = await waitFor(
      () => env.controller.starts.find((s) => s.mcpEndpoint?.token),
      15000,
      'exec acp:start',
    );
    await callWorkflowTool(page, execStartE12.sessionId, execStartE12.mcpEndpoint!.token, 'completeCurrentNode', {
      artifacts: [{ title: `超长产物标题${'z'.repeat(60)}`, value: `报告 ${'x'.repeat(180)} https://example.com/${'y'.repeat(120)} 结尾` }],
    });
    for (const name of ['需求输入', 'AI执行']) {
      const btn = nodeCard(page, name).getByRole('button', { name: `${name} 展开` });
      if (await btn.count()) await btn.click();
    }
    await page.getByRole('button', { name: /^工作流黑板（\d+）$/ }).click();
    await expect(page.getByText(`超长产物标题${'z'.repeat(60)}`).first()).toBeVisible({ timeout: 15000 });
    const overflowX2 = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflowX2).toBeLessThanOrEqual(1);

    env.controller.disconnect();
  });

  // -------------------------------------------------------------------------
  // E2E-13 AI 打回人类节点后，人类节点可重新提交（REWORK 完成返工）
  // -------------------------------------------------------------------------
  test('E2E-13: human node rejected by AI can resubmit via node actions (REWORK rework completion)', async ({ page }) => {
    test.setTimeout(60000);
    const env = await setupWorkflowEnv(page, 'e13');
    const instanceName = `wf-e13-实例-${Date.now().toString(36)}`;
    const { instanceId, inputNode, execStart } = await advanceToExecRunning(page, env, instanceName);

    await loginViaUI(page, env.username);
    await page.goto(`/workflows/${instanceId}`);
    await expect(page.getByRole('heading', { name: instanceName })).toBeVisible({ timeout: 10000 });

    // AI（exec）打回人类提交：exec 已打回，input 进入返工
    const rej = await callWorkflowTool(
      page,
      execStart.sessionId,
      execStart.mcpEndpoint!.token,
      'rejectCurrentNode',
      { reason: '需求描述不清楚，请补充' },
    );
    expect(rej.isError).toBe(false);

    // UI：input 节点返工中（默认展开），可重新输入并提交
    const inputCard = nodeCard(page, '需求输入');
    await expect(inputCard.getByText('返工中', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(nodeCard(page, 'AI执行').getByText('已打回', { exact: true })).toBeVisible();
    await inputCard.getByLabel('需求输入 完成输入').fill('做一个支持加减乘除的计算器');
    await inputCard.getByRole('button', { name: '完成', exact: true }).click();

    // input 完成返工（DONE 默认折叠，返工次数仍可见），exec 复工执行中
    await expect(nodeCard(page, 'AI执行').getByText('执行中', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(inputCard.getByText('返工 1 次')).toBeVisible();

    // API 校验：新产物上黑板，旧产物入垃圾桶
    const inst = await getInstance(page, env.token, instanceId);
    const artifactKey = `${inputNode.id}-需求输入-产物-输入`;
    expect(inst.blackboard.find((e) => e.key === artifactKey)?.value).toBe('做一个支持加减乘除的计算器');
    expect(inst.blackboardTrash.find((e) => e.key === artifactKey)?.value).toBe('做一个计算器');

    env.controller.disconnect();
  });

  // -------------------------------------------------------------------------
  // 二期 E2E-14 设置页已配置工作流图编辑（保存成功、来源模板不变）
  // -------------------------------------------------------------------------
  test('P2-E2E-14: settings page edits configured workflow graph and saves', async ({ page }) => {
    test.setTimeout(90000);
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const hostname = `wf-p2e14-host-${Date.now().toString(36)}`;
    const controller = await registerWorkflowController(rawKey, hostname);
    await refreshCapabilities(page, token, controller.controllerId);
    const templateId = await createThreeNodeTemplate(page, token, `wf-p2e14-模板-${Date.now().toString(36)}`);
    const configuredName = `wf-p2e14-配置-${Date.now().toString(36)}`;
    const configuredId = await configureFromTemplate(page, token, templateId, controller.controllerId, configuredName);

    await loginViaUI(page, username);
    await page.click('a[href="/settings"]');
    const section = page.locator('#workflow-section');
    await expect(section).toBeVisible({ timeout: 5000 });

    // 已配置工作流卡片 → 编辑（打开完整节点图编辑器）
    const configuredCard = section.locator('[data-slot="card"]').filter({ hasText: configuredName });
    await configuredCard.getByRole('button', { name: '编辑' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('编辑已配置工作流')).toBeVisible();

    // 修改 exec 节点提示词（节点 2，AI 节点提示词为每行一条）
    await dialog.getByLabel('节点 2 提示词').fill('阅读上游产物并完成执行\n追加二期编辑提示词');
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 10000 });

    // 保存成功：重新查询已配置工作流节点
    const q = await gqlRequest(page, `
      query GetConfigured($controllerId: ID) {
        configuredWorkflows(controllerId: $controllerId) { id nodes { nodeKey prompts } }
      }
    `, { controllerId: controller.controllerId }, token);
    const body = await q.json();
    const cfg = body.data.configuredWorkflows.find((c: Record<string, any>) => c.id === configuredId);
    const exec = cfg.nodes.find((n: Record<string, any>) => n.nodeKey === 'exec');
    expect(exec.prompts).toEqual(['阅读上游产物并完成执行', '追加二期编辑提示词']);

    controller.disconnect();
  });

  // -------------------------------------------------------------------------
  // 二期 E2E-15 从模板实例化（实例化前配置界面补齐 Agent 配置）
  // -------------------------------------------------------------------------
  test('P2-E2E-15: instantiate from template via sidebar with pre-instantiation config UI', async ({ page }) => {
    test.setTimeout(60000);
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const hostname = `wf-p2e15-host-${Date.now().toString(36)}`;
    const controller = await registerWorkflowController(rawKey, hostname);
    await refreshCapabilities(page, token, controller.controllerId);
    const workspacePath = `/tmp/e2e-p2e15-${Date.now().toString(36)}`;
    const ws = await createWorkspace(page, controller.controllerId, workspacePath, token);
    const templateName = `wf-p2e15-模板-${Date.now().toString(36)}`;
    const templateId = await createThreeNodeTemplate(page, token, templateName);

    await loginViaUI(page, username);
    const nav = page.locator(sidebar());
    await nav.getByRole('button', { name: new RegExp(hostname) }).click();
    const wsName = workspacePath.split('/').pop()!;
    await nav.getByRole('button', { name: new RegExp(wsName) }).click();
    await nav.getByRole('button', { name: '实例化工作流' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('实例化工作流')).toBeVisible();

    // 步骤 1：来源选择「模板」
    await dialog.getByRole('button', { name: /^模板$/ }).click();
    await dialog.getByRole('button', { name: new RegExp(templateName) }).click();
    await dialog.getByLabel('实例名称').fill(`wf-p2e15-实例-${Date.now().toString(36)}`);
    await dialog.getByRole('button', { name: '下一步', exact: true }).click();

    // 步骤 2：实例化前配置界面 —— 模板 AI 节点缺 Agent 配置，需补齐 Harness 工具
    await expect(dialog.getByText('实例化前配置')).toBeVisible();
    await expect(dialog.getByText(/来源：模板/)).toBeVisible();
    await dialog.locator('[data-slot="select-trigger"][aria-label="AI执行 Harness 工具"]').click();
    await page.getByRole('option', { name: 'opencode', exact: true }).click();
    await dialog.getByRole('button', { name: '确认实例化', exact: true }).click();

    // 跳转到实例视图
    await page.waitForURL(/\/workflows\/[a-f0-9]+/, { timeout: 10000 });
    const instanceId = page.url().match(/\/workflows\/([a-f0-9]+)/)![1];
    await expect(page.getByRole('heading', { name: /wf-p2e15-实例/ })).toBeVisible({ timeout: 10000 });

    // 实例节点快照 = 配置界面提交内容（提示词完整、agentConfig 为 opencode）
    const inst = await getInstance(page, token, instanceId);
    const execNode = inst.nodes.find((n) => n.nodeKey === 'exec')!;
    expect(execNode.status).toBe('INITIALIZING');
    await expect(nodeCard(page, 'AI执行').getByText('等待中', { exact: true })).toBeVisible();

    controller.disconnect();
  });

  // -------------------------------------------------------------------------
  // 二期 E2E-16 从空白实例化（配置界面从零搭建节点图）
  // -------------------------------------------------------------------------
  test('P2-E2E-16: instantiate from blank, build node graph in config UI', async ({ page }) => {
    test.setTimeout(60000);
    const { token, username } = await registerUser(page);
    const { rawKey } = await createControllerKey(page, token);
    const hostname = `wf-p2e16-host-${Date.now().toString(36)}`;
    const controller = await registerWorkflowController(rawKey, hostname);
    await refreshCapabilities(page, token, controller.controllerId);
    const workspacePath = `/tmp/e2e-p2e16-${Date.now().toString(36)}`;
    const ws = await createWorkspace(page, controller.controllerId, workspacePath, token);

    await loginViaUI(page, username);
    const nav = page.locator(sidebar());
    await nav.getByRole('button', { name: new RegExp(hostname) }).click();
    const wsName = workspacePath.split('/').pop()!;
    await nav.getByRole('button', { name: new RegExp(wsName) }).click();
    await nav.getByRole('button', { name: '实例化工作流' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('实例化工作流')).toBeVisible();

    // 步骤 1：来源选择「空白」
    await dialog.getByRole('button', { name: /^空白$/ }).click();
    await dialog.getByLabel('实例名称').fill(`wf-p2e16-实例-${Date.now().toString(36)}`);
    await dialog.getByRole('button', { name: '下一步', exact: true }).click();

    // 步骤 2：空白默认含 1 个 HUMAN 节点，编辑其字段
    await expect(dialog.getByText('实例化前配置')).toBeVisible();
    await dialog.getByLabel('节点 1 标识').fill('input');
    await dialog.getByLabel('节点 1 名称').fill('需求输入');
    await dialog.getByLabel('节点 1 阶段').fill('需求');
    // 添加 AI 节点并补全配置
    await dialog.getByRole('button', { name: '添加节点' }).click();
    await dialog.getByLabel('节点 2 标识').fill('exec');
    await dialog.getByLabel('节点 2 名称').fill('AI执行');
    await dialog.getByLabel('节点 2 阶段').fill('开发');
    await dialog.getByLabel('节点 2 提示词').fill('执行开发任务');
    await dialog.getByLabel('节点 2 产物标题').fill('开发产物');
    await dialog.locator('[data-slot="select-trigger"][aria-label="AI执行 Harness 工具"]').click();
    await page.getByRole('option', { name: 'opencode', exact: true }).click();
    // 设置 exec 依赖 input
    await dialog.getByText(/需求输入（input）/).click();
    await dialog.getByRole('button', { name: '确认实例化', exact: true }).click();

    await page.waitForURL(/\/workflows\/[a-f0-9]+/, { timeout: 10000 });
    const instanceId = page.url().match(/\/workflows\/([a-f0-9]+)/)![1];
    await expect(page.getByRole('heading', { name: /wf-p2e16-实例/ })).toBeVisible({ timeout: 10000 });
    await expect(nodeCard(page, '需求输入').getByText('待开始', { exact: true })).toBeVisible();
    await expect(nodeCard(page, 'AI执行').getByText('等待中', { exact: true })).toBeVisible();

    controller.disconnect();
  });

  // -------------------------------------------------------------------------
  // 二期 E2E-17 实例视图编辑未开始节点（保存生效；开始后再编辑被拒）
  // -------------------------------------------------------------------------
  test('P2-E2E-17: edit not-started instance node in instance view', async ({ page }) => {
    test.setTimeout(90000);
    const env = await setupWorkflowEnv(page, 'p2e17');
    const instanceName = `wf-p2e17-实例-${Date.now().toString(36)}`;
    const inst = await instantiate(page, env.token, env.configuredId, env.workspaceId, instanceName);
    const instanceId = inst.id as string;
    const inputNode = inst.nodes.find((n) => n.nodeKey === 'input')!;
    const execNode = inst.nodes.find((n) => n.nodeKey === 'exec')!;

    await loginViaUI(page, env.username);
    await page.goto(`/workflows/${instanceId}`);
    await expect(page.getByRole('heading', { name: instanceName })).toBeVisible({ timeout: 10000 });

    // exec 为 INITIALIZING（等待中），展示「编辑」入口
    const execCard = nodeCard(page, 'AI执行');
    await expect(execCard.getByText('等待中', { exact: true })).toBeVisible();
    await expect(execCard.getByRole('button', { name: '编辑' })).toBeVisible();

    // 打开编辑对话框，修改节点名称/提示词并保存
    await execCard.getByRole('button', { name: '编辑' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('编辑节点「AI执行」')).toBeVisible();
    await dialog.getByLabel('提示词').fill('编辑后的执行提示词');
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 10000 });

    // 保存生效（API 校验快照更新）
    await waitFor(async () => {
      const i = await getInstance(page, env.token, instanceId);
      const n = i.nodes.find((x) => x.nodeKey === 'exec')!;
      return n.prompts?.includes('编辑后的执行提示词') ? i : undefined;
    }, 15000, 'exec node snapshot updated');

    // 开始节点后（完成 input → exec RUNNING）「编辑」入口消失（已开始不可修改）
    await completeHumanNode(page, env.token, instanceId, inputNode.id, '做一个计算器');
    await waitFor(
      async () => {
        const i = await getInstance(page, env.token, instanceId);
        return i.nodes.find((x) => x.nodeKey === 'exec')!.status === 'RUNNING' ? i : undefined;
      },
      15000,
      'exec RUNNING',
    );
    await expect(nodeCard(page, 'AI执行').getByText('执行中', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(nodeCard(page, 'AI执行').getByRole('button', { name: '编辑' })).toHaveCount(0);

    env.controller.disconnect();
  });

  // -------------------------------------------------------------------------
  // 二期 E2E-18 AI 会话装配管理工具集完成编排（创建模板→配置→实例化；删人类资源被拒）
  // -------------------------------------------------------------------------
  test('P2-E2E-18: AI node session has admin toolset assembled and can orchestrate; cannot delete human resource', async ({ page }) => {
    test.setTimeout(90000);
    const env = await setupWorkflowEnv(page, 'p2e18');
    const instanceName = `wf-p2e18-实例-${Date.now().toString(36)}`;
    const { instanceId, execStart } = await advanceToExecRunning(page, env, instanceName);
    const sessionId = execStart.sessionId;
    const mcpToken = execStart.mcpEndpoint!.token;

    // AI 会话已装配管理工作流工具集（serverNames 含 agent-workflow-admin-tools）
    expect(execStart.mcpEndpoint?.serverNames).toContain('agent-workflow-admin-tools');

    // 用管理工具集完整编排：创建模板 → 配置 → 实例化
    const createdTpl = await callAdminTool(page, sessionId, mcpToken, 'createWorkflowTemplate', {
      name: `wf-p2e18-AI模板-${Date.now().toString(36)}`,
      nodes: [
        { nodeKey: 'input', type: 'HUMAN', name: '需求输入', stage: '需求', dependsOn: [], requiresWorktree: false },
        { nodeKey: 'exec', type: 'AI', name: 'AI执行', stage: '开发', prompts: ['阅读上游产物并完成执行'], artifactTitles: ['开发产物'], dependsOn: ['input'], requiresWorktree: false },
      ],
    });
    expect(createdTpl.isError).toBe(false);
    const aiTemplateId = (createdTpl.data as { id: string }).id;

    const createdCfg = await callAdminTool(page, sessionId, mcpToken, 'createConfiguredWorkflow', {
      name: `wf-p2e18-AI配置-${Date.now().toString(36)}`,
      controllerId: env.controller.controllerId,
      templateId: aiTemplateId,
      nodes: [
        { nodeKey: 'input' },
        { nodeKey: 'exec', agentConfig: { acpServerType: 'opencode', initNewWorktree: false } },
      ],
    });
    expect(createdCfg.isError).toBe(false);
    const aiCfgId = (createdCfg.data as { id: string }).id;

    const instantiated = await callAdminTool(page, sessionId, mcpToken, 'instantiateWorkflowFromConfigured', {
      configuredWorkflowId: aiCfgId,
      controllerId: env.controller.controllerId,
      workspaceId: env.workspaceId,
      name: `wf-p2e18-AI实例-${Date.now().toString(36)}`,
    });
    expect(instantiated.isError).toBe(false);

    // 人类创建的资源（本用户 setup 时创建的模板）不可被 AI 删除（requireAiOwned）
    const humanTpl = await callAdminTool(page, sessionId, mcpToken, 'listWorkflowTemplates', {});
    expect(humanTpl.isError).toBe(false);
    const humanTemplate = (humanTpl.data as { templates: { id: string; name: string; isBuiltin: boolean }[] }).templates.find(
      (t) => t.name.startsWith(`wf-p2e18-模板`),
    );
    const delHuman = await callAdminTool(page, sessionId, mcpToken, 'deleteWorkflowTemplate', { id: humanTemplate!.id });
    expect(delHuman.isError).toBe(true);

    // AI 创建的模板可被删除（归属校验通过）
    const delAi = await callAdminTool(page, sessionId, mcpToken, 'deleteWorkflowTemplate', { id: aiTemplateId });
    expect(delAi.isError).toBe(false);

    env.controller.disconnect();
  });
});
