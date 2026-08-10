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

function registerWorkflowController(rawKey: string, hostname: string): Promise<WorkflowController> {
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
      client.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
        externalSessionId: `ext_${data.sessionId}`,
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
        nodes { id nodeKey name type status stage sessionId reworkCount rejectInfo { reason } }
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
    nodes: (InstanceNode & { rejectInfo: { reason: string } | null })[];
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

// ---------------------------------------------------------------------------
// 公共 setup：用户 + fake controller + 工作区 + 模板 + 已配置工作流
// ---------------------------------------------------------------------------

interface WorkflowEnv {
  token: string;
  username: string;
  controller: WorkflowController;
  workspaceId: string;
  workspacePath: string;
  configuredId: string;
}

async function setupWorkflowEnv(page: Page, tag: string): Promise<WorkflowEnv> {
  const { token, username } = await registerUser(page);
  const { rawKey } = await createControllerKey(page, token);
  const controller = await registerWorkflowController(rawKey, `wf-${tag}-host-${Date.now().toString(36)}`);
  await refreshCapabilities(page, token, controller.controllerId);
  const workspacePath = `/tmp/e2e-wf-${tag}-${Date.now().toString(36)}`;
  const ws = await createWorkspace(page, controller.controllerId, workspacePath, token);
  const templateId = await createThreeNodeTemplate(page, token, `wf-${tag}-模板-${Date.now().toString(36)}`);
  const configuredId = await configureFromTemplate(page, token, templateId, controller.controllerId, `wf-${tag}-配置-${Date.now().toString(36)}`);
  return { token, username, controller, workspaceId: ws.id, workspacePath, configuredId };
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
    await dialog.getByRole('button', { name: '实例化', exact: true }).click();

    // 跳转到实例视图：首节点 READY（待开始），AI 节点 INITIALIZING（初始化中）
    await page.waitForURL(/\/workflows\/[a-f0-9]+/, { timeout: 10000 });
    const instanceId = page.url().match(/\/workflows\/([a-f0-9]+)/)![1];
    await expect(page.getByRole('heading', { name: instanceName })).toBeVisible({ timeout: 10000 });
    await expect(nodeCard(page, '需求输入').getByText('待开始', { exact: true })).toBeVisible();
    await expect(nodeCard(page, 'AI执行').getByText('初始化中', { exact: true })).toBeVisible();

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

    // 实例状态推进（UI）
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

    // UI：verify 回到执行中，exec 显示返工次数
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

    // 再次结束会话：每节点仅兜底 1 次，不再 resume
    await closeSession(page, env.token, execSessionId);
    await waitFor(() => env.controller.stops.filter((s) => s === execSessionId).length >= 2 || undefined, 15000, 'second acp:stop');
    await page.waitForTimeout(3000);
    expect(env.controller.resumes.filter((r) => r.sessionId === execSessionId)).toHaveLength(1);
    const msgsAfter = await getSessionMessagesText(page, env.token, execSessionId);
    expect(msgsAfter.filter((m) => m.includes('你身处一个自动化工作流系统'))).toHaveLength(1);

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

    // 状态 badge
    await expect(nodeCard(page, '需求输入').getByText('已完成', { exact: true })).toBeVisible();
    await expect(nodeCard(page, 'AI执行').getByText('执行中', { exact: true })).toBeVisible();
    await expect(nodeCard(page, 'AI验收').getByText('初始化中', { exact: true })).toBeVisible();
    await expect(nodeCard(page, '需求输入').getByText('人类', { exact: true })).toBeVisible();
    await expect(nodeCard(page, 'AI执行').getByText('AI', { exact: true })).toBeVisible();

    // 黑板面板：首节点产物可见
    await expect(page.getByRole('heading', { name: '工作流黑板' })).toBeVisible();
    await expect(page.getByText(`${inputNode.id}-需求输入-产物-输入`)).toBeVisible();
    await expect(page.getByText('做一个计算器')).toBeVisible();

    // 点击会话入口打开侧面板（SessionView 可见，展示节点提示词）
    await nodeCard(page, 'AI执行').getByRole('button', { name: '会话' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('节点会话')).toBeVisible();
    await expect(dialog.getByText(/你身处一个工作流系统/)).toBeVisible({ timeout: 15000 });
    expect(execStart.sessionId).toBeTruthy();

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
});
