import { test, expect, type Page } from '@playwright/test'
import { io as SocketIOClient, type Socket } from 'socket.io-client'
import {
  createControllerKey,
  createFrontUser,
  createWorkspace,
  gqlRequest,
  loginViaUI,
} from './helpers'

/**
 * 工作流节点「立即失败」—— E2E-WMF1 ~ E2E-WMF2。
 *
 * 前置：`aspire start`（agent-web / agent-api / controller-api 就绪）+ `INTERNAL_API_TOKEN`（开户）。
 * 实例准备走 GraphQL；节点会话由 fake controller 应答 `acp:check` / `acp:start` / `acp:stop` 模拟。
 */
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273'

interface FakeController {
  controllerId: string
  socket: Socket
  starts: string[]
  stops: string[]
  resumeCount: number
  disconnect: () => void
}

function registerFakeController(rawKey: string, hostname: string): Promise<FakeController> {
  return new Promise((resolve, reject) => {
    const socket = SocketIOClient(CONTROLLER_API_URL, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    })
    const timer = setTimeout(() => {
      socket.disconnect()
      reject(new Error('Timeout registering controller'))
    }, 15000)
    const starts: string[] = []
    const stops: string[] = []
    let resumeCount = 0

    socket.on('acp:check', (data: { requestId: string }) => {
      socket.emit('acp:check:result', {
        requestId: data.requestId,
        servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
      })
    })
    socket.on('git:check', (data: { requestId: string }) => {
      socket.emit('git:check:result', { requestId: data.requestId, isGitRepo: false })
    })
    socket.on('git:worktree:list', (data: { requestId: string }) => {
      socket.emit('git:worktree:list:result', { requestId: data.requestId, success: true, worktrees: [] })
    })
    socket.on('acp:start', (data: { requestId: string; sessionId: string }) => {
      starts.push(data.sessionId)
      socket.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
        externalSessionId: `ext_wmf_${data.sessionId}`,
      })
    })
    socket.on('acp:resume', (data: { requestId: string; sessionId: string }) => {
      resumeCount += 1
      socket.emit('acp:resume:result', { requestId: data.requestId, sessionId: data.sessionId, success: true })
    })
    socket.on('acp:stop', (data: { sessionId: string }) => {
      stops.push(data.sessionId)
      socket.emit('acp:stopped', { sessionId: data.sessionId, reason: 'user_close' })
    })

    socket.once('registered', (data: { controllerId: string }) => {
      clearTimeout(timer)
      resolve({
        controllerId: data.controllerId,
        socket,
        starts,
        stops,
        get resumeCount() {
          return resumeCount
        },
        disconnect: () => socket.disconnect(),
      })
    })
    socket.once('error', (data: { message: string }) => {
      clearTimeout(timer)
      socket.disconnect()
      reject(new Error(`Register failed: ${data.message}`))
    })
    socket.emit('register', {
      key: rawKey,
      hostname,
      version: '2.20.0',
      homeDir: '/home/fake',
      platform: 'linux',
    })
  })
}

async function gql<T>(page: Page, token: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await gqlRequest(page, query, variables, token)
  const body = await res.json()
  if (body.errors) throw new Error(JSON.stringify(body.errors))
  return body.data as T
}

const INSTANCE_NODES_QUERY = `query WorkflowInstance($id: ID!) {
  workflowInstance(id: $id) {
    id
    nodes { id nodeKey type name status sessionId retryCount nextRetryAt failInfo { reason source } }
  }
}`

interface InstanceView {
  id: string
  nodes: Array<{
    id: string
    nodeKey: string
    type: string
    name: string
    status: string
    sessionId: string | null
  }>
}

/** 三节点线性图：HUMAN(input) → AI(exec) → AI(after) */
function blankNodes() {
  return [
    { nodeKey: 'input', type: 'HUMAN', name: '需求输入', stage: '阶段一', dependsOn: [], requiresWorktree: false },
    {
      nodeKey: 'exec',
      type: 'AI',
      name: 'AI执行',
      stage: '阶段一',
      prompts: ['阅读上游产物并完成执行'],
      artifactTitles: ['执行结果'],
      dependsOn: ['input'],
      requiresWorktree: false,
      agentConfig: { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: false },
    },
    {
      nodeKey: 'after',
      type: 'AI',
      name: 'AI收尾',
      stage: '阶段二',
      prompts: ['根据执行结果收尾'],
      artifactTitles: ['收尾结果'],
      dependsOn: ['exec'],
      requiresWorktree: false,
      agentConfig: { acpServerType: 'opencode', modeId: null, modelId: null, initNewWorktree: false },
    },
  ]
}

/** 造用户 + fake 控制器 + 工作区；实例化并推进到 AI exec 节点 RUNNING（持会话） */
async function setupRunningInstance(page: Page, tag: string) {
  const user = await createFrontUser(page)
  const key = await createControllerKey(page, user.token)
  const fake = await registerFakeController(key.rawKey, `wmf-${tag}-${Date.now().toString(36)}`)
  const workspace = await createWorkspace(
    page,
    fake.controllerId,
    `/tmp/e2e-wmf-${tag}-${Date.now().toString(36)}`,
    user.token,
  )
  await gql(page, user.token, `mutation Refresh($controllerId: ID!) {
    refreshAcpCapabilities(controllerId: $controllerId) { type available }
  }`, { controllerId: fake.controllerId })

  const data = await gql<{ instantiateWorkflow: { id: string } }>(
    page,
    user.token,
    `mutation Instantiate($input: InstantiateWorkflowInput!) {
      instantiateWorkflow(input: $input) { id nodes { id nodeKey type name status } }
    }`,
    {
      input: {
        source: 'BLANK',
        controllerId: fake.controllerId,
        workspaceId: workspace.id,
        name: `wmf-${tag}-实例-${Date.now().toString(36)}`,
        nodes: blankNodes(),
        createWorkflowWorktree: false,
      },
    },
  )
  const instanceId = data.instantiateWorkflow.id
  let view = await gql<{ workflowInstance: InstanceView }>(page, user.token, INSTANCE_NODES_QUERY, {
    id: instanceId,
  })
  const humanNode = view.workflowInstance.nodes.find((n) => n.nodeKey === 'input')!
  const startBefore = fake.starts.length

  // 完成人类节点 → AI 节点拉起会话
  await gql(page, user.token, `mutation Complete($instanceId: ID!, $nodeId: ID!) {
    completeHumanNode(instanceId: $instanceId, nodeId: $nodeId, input: "做一个计算器") { id status }
  }`, { instanceId, nodeId: humanNode.id })

  await expect.poll(() => fake.starts.length, { timeout: 20000 }).toBeGreaterThan(startBefore)
  await expect
    .poll(async () => {
      view = await gql<{ workflowInstance: InstanceView }>(page, user.token, INSTANCE_NODES_QUERY, {
        id: instanceId,
      })
      return view.workflowInstance.nodes.find((n) => n.nodeKey === 'exec')?.status
    }, { timeout: 20000 })
    .toBe('RUNNING')

  const execNode = view.workflowInstance.nodes.find((n) => n.nodeKey === 'exec')!
  await loginViaUI(page, user.username)
  return { user, fake, instanceId, execNode }
}

async function openExecDrawer(page: Page, instanceId: string) {
  await page.goto(`/workflows/${instanceId}`)
  await page.getByRole('button', { name: 'AI执行 详情' }).click()
  const drawer = page.getByTestId('node-detail-drawer')
  await expect(drawer).toBeVisible()
  return drawer
}

test.describe.configure({ timeout: 120_000 })

test.describe('工作流节点立即失败', () => {
  test('E2E-WMF1 确认立即失败 → 节点 FAILED + 失败来源人工标记 + 会话停止 + 下游等待', async ({ page }) => {
    const env = await setupRunningInstance(page, 'wmf1')
    const drawer = await openExecDrawer(page, env.instanceId)

    await expect(drawer.getByTestId('drawer-node-status')).toHaveText('执行中')
    await drawer.getByRole('button', { name: '立即失败' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('中断会话')
    await expect(dialog).toContainText('取消全部自动重试')
    await expect(dialog).toContainText('阻断工作流')

    await dialog.getByRole('button', { name: '确认失败' }).click()
    await expect(page.getByText('节点已标记失败')).toBeVisible({ timeout: 15000 })

    // 5s 轮询收敛：FAILED 徽标 + 失败来源 + 重试进度消失
    await expect(drawer.getByTestId('drawer-node-status')).toHaveText('失败', { timeout: 20000 })
    await expect(drawer.getByTestId('drawer-fail-source')).toHaveText('失败来源：人工标记')
    await expect(drawer.getByText(/失败原因：人工标记失败/)).toBeVisible()
    await expect(drawer.getByText('自动重试')).toHaveCount(0)

    // fake controller 收到会话 stop；节点无自动重试（零 resume）
    expect(env.fake.stops).toContain(env.execNode.sessionId)
    expect(env.fake.resumeCount).toBe(0)

    // 下游节点保持等待；实例阻断提示可见
    const view = await gql<{ workflowInstance: InstanceView }>(page, env.user.token, INSTANCE_NODES_QUERY, {
      id: env.instanceId,
    })
    const after = view.workflowInstance.nodes.find((n) => n.nodeKey === 'after')!
    expect(['INITIALIZING', 'READY']).toContain(after.status)
    expect(view.workflowInstance.nodes.find((n) => n.nodeKey === 'exec')!.status).toBe('FAILED')

    // 失败节点仍可重启（恢复路径与既有失败一致）
    await expect(drawer.getByRole('button', { name: '重启节点' })).toBeVisible()

    env.fake.disconnect()
  })

  test('E2E-WMF2 取消零副作用；DONE/HUMAN 节点无「立即失败」入口', async ({ page }) => {
    const env = await setupRunningInstance(page, 'wmf2')
    const drawer = await openExecDrawer(page, env.instanceId)

    await drawer.getByRole('button', { name: '立即失败' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toHaveCount(0)

    // 节点仍 RUNNING，无任何关闭会话动作
    await expect(drawer.getByTestId('drawer-node-status')).toHaveText('执行中')
    await page.waitForTimeout(1000)
    const view = await gql<{ workflowInstance: InstanceView }>(page, env.user.token, INSTANCE_NODES_QUERY, {
      id: env.instanceId,
    })
    expect(view.workflowInstance.nodes.find((n) => n.nodeKey === 'exec')!.status).toBe('RUNNING')
    expect(env.fake.stops).toHaveLength(0)

    // 已完成的人类节点无入口
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    await page.getByRole('button', { name: '需求输入 详情' }).click()
    const humanDrawer = page.getByTestId('node-detail-drawer')
    await expect(humanDrawer).toBeVisible()
    await expect(humanDrawer.getByTestId('drawer-node-status')).toHaveText('已完成')
    await expect(humanDrawer.getByRole('button', { name: '立即失败' })).toHaveCount(0)

    env.fake.disconnect()
  })
})
