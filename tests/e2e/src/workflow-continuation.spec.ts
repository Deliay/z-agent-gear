import { test, expect, type Page } from '@playwright/test'
import { io as SocketIOClient, type Socket } from 'socket.io-client'
import mongoose from 'mongoose'
import {
  createControllerKey,
  createFrontUser,
  createWorkspace,
  gqlRequest,
  loginViaUI,
} from './helpers'

/**
 * 已实例化工作流接续 —— E2E-WCT1 ~ E2E-WCT2。
 *
 * 前置：`aspire start` + `MONGODB_URI`（直连改控制器状态/节点快照与伪造运行中节点会话）。
 * 控制器离线/恢复经 DB 直写等价覆盖（真实断线需等 90s 心跳 TTL，不适合 UI 用例）。
 */
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001'
const MONGODB_URI = process.env.MONGODB_URI ?? ''

interface FakeController {
  controllerId: string
  socket: Socket
  starts: Array<{ sessionId: string; serverType?: string }>
  worktrees: Array<{ repoPath: string; worktreePath: string; branch: string }>
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
    const starts: FakeController['starts'] = []
    const worktrees: FakeController['worktrees'] = []

    socket.on('acp:check', (data: { requestId: string }) => {
      socket.emit('acp:check:result', {
        requestId: data.requestId,
        servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
      })
    })
    socket.on('git:check', (data: { requestId: string }) => {
      socket.emit('git:check:result', { requestId: data.requestId, isGitRepo: true, currentBranch: 'main' })
    })
    socket.on('git:worktree:list', (data: { requestId: string }) => {
      socket.emit('git:worktree:list:result', { requestId: data.requestId, success: true, worktrees: [] })
    })
    socket.on('git:worktree:add', (data: { requestId: string; repoPath: string; worktreePath: string; branch: string }) => {
      worktrees.push({ repoPath: data.repoPath, worktreePath: data.worktreePath, branch: data.branch })
      socket.emit('git:worktree:add:result', {
        requestId: data.requestId,
        success: true,
        worktreePath: data.worktreePath,
      })
    })
    socket.on('git:worktree:remove', (data: { requestId: string }) => {
      socket.emit('git:worktree:remove:result', { requestId: data.requestId, success: true })
    })
    socket.on('acp:start', (data: { requestId: string; sessionId: string; serverType?: string }) => {
      starts.push({ sessionId: data.sessionId, serverType: data.serverType })
      socket.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
        externalSessionId: `ext_${data.sessionId}`,
      })
    })
    socket.on('acp:resume', (data: { requestId: string; sessionId: string }) => {
      socket.emit('acp:resume:result', { requestId: data.requestId, sessionId: data.sessionId, success: true })
    })
    socket.on('acp:stop', (data: { sessionId: string }) => {
      socket.emit('acp:stopped', { sessionId: data.sessionId, reason: 'user_close' })
    })

    socket.once('registered', (data: { controllerId: string }) => {
      clearTimeout(timer)
      resolve({
        controllerId: data.controllerId,
        socket,
        starts,
        worktrees,
        disconnect: () => socket.disconnect(),
      })
    })
    socket.once('error', (data: { message: string }) => {
      clearTimeout(timer)
      socket.disconnect()
      reject(new Error(`Register failed: ${data.message}`))
    })
    socket.emit('register', { key: rawKey, hostname, version: '2.20.0', homeDir: '/home/fake', platform: 'linux' })
  })
}

async function db() {
  if (mongoose.connection.readyState === 0) await mongoose.connect(MONGODB_URI)
  return mongoose.connection.db!
}

async function setControllerStatus(controllerId: string, status: 'online' | 'offline') {
  const database = await db()
  await database.collection('controllers').updateOne(
    { _id: new mongoose.Types.ObjectId(controllerId) },
    { $set: { status } },
  )
}

async function patchInstance(instanceId: string, nodeId: string) {
  const database = await db()
  await database.collection('workflowinstances').updateOne(
    { _id: new mongoose.Types.ObjectId(instanceId), 'nodes.nodeId': nodeId },
    {
      $set: {
        'nodes.$.status': 'RUNNING',
        'nodes.$.sessionId': new mongoose.Types.ObjectId(),
        'nodes.$.startedAt': new Date(),
        currentNodeNames: ['AI执行'],
        lastNodeName: 'AI执行',
        lastNodeStatus: 'RUNNING',
      },
    },
  )
}

async function setWorkspaceDefaultBranch(workspaceId: string) {
  const database = await db()
  await database.collection('controllerworkspaces').updateOne(
    { _id: new mongoose.Types.ObjectId(workspaceId) },
    { $set: { defaultBranch: 'main' } },
  )
}

async function gql<T>(page: Page, token: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await gqlRequest(page, query, variables, token)
  const body = await res.json()
  if (body.errors) throw new Error(JSON.stringify(body.errors))
  return body.data as T
}

async function createRunningInstance(
  page: Page,
  token: string,
  controllerId: string,
  workspaceId: string,
): Promise<{ instanceId: string; nodeId: string }> {
  await gql(page, token, `mutation Refresh($controllerId: ID!) {
    refreshAcpCapabilities(controllerId: $controllerId) { type available }
  }`, { controllerId })

  const data = await gql<{ instantiateWorkflow: { id: string; nodes: Array<{ id: string; type: string }> } }>(
    page,
    token,
    `mutation Instantiate($input: InstantiateWorkflowInput!) {
      instantiateWorkflow(input: $input) { id nodes { id type status } }
    }`,
    {
      input: {
        source: 'BLANK',
        controllerId,
        workspaceId,
        name: `wct-inst-${Date.now().toString(36)}`,
        nodes: [
          {
            nodeKey: 'exec',
            type: 'AI',
            name: 'AI执行',
            stage: '实现',
            prompts: ['按方案实现'],
            artifactTitles: ['实现产物'],
            dependsOn: [],
            requiresWorktree: false,
            agentConfig: { acpServerType: 'opencode', initNewWorktree: false },
          },
        ],
        createWorkflowWorktree: false,
      },
    },
  )
  const node = data.instantiateWorkflow.nodes.find((item) => item.type === 'AI')!
  await patchInstance(data.instantiateWorkflow.id, node.id)
  return { instanceId: data.instantiateWorkflow.id, nodeId: node.id }
}

/** 注册用户 + 两台 git-capable fake 控制器 + 各自工作区（B 设 defaultBranch） */
async function setupEnv(page: Page, tag: string) {
  const user = await createFrontUser(page)
  const keyA = await createControllerKey(page, user.token)
  const keyB = await createControllerKey(page, user.token)
  const controllerA = await registerFakeController(keyA.rawKey, `wct-a-${tag}-${Date.now().toString(36)}`)
  const controllerB = await registerFakeController(keyB.rawKey, `wct-b-${tag}-${Date.now().toString(36)}`)
  const workspaceA = await createWorkspace(
    page,
    controllerA.controllerId,
    `/tmp/e2e-wct-${tag}-a-${Date.now().toString(36)}`,
    user.token,
  )
  const workspaceB = await createWorkspace(
    page,
    controllerB.controllerId,
    `/tmp/e2e-wct-${tag}-b-${Date.now().toString(36)}`,
    user.token,
  )
  await setWorkspaceDefaultBranch(workspaceB.id)
  await gql(page, user.token, `mutation Refresh($controllerId: ID!) {
    refreshAcpCapabilities(controllerId: $controllerId) { type available }
  }`, { controllerId: controllerB.controllerId })

  const { instanceId, nodeId } = await createRunningInstance(
    page,
    user.token,
    controllerA.controllerId,
    workspaceA.id,
  )
  await loginViaUI(page, user.username)
  return { user, controllerA, controllerB, workspaceA, workspaceB, instanceId, nodeId }
}

test.describe('已实例化工作流接续', () => {
  test.skip(!MONGODB_URI, 'requires MONGODB_URI for controller status + instance fixtures')

  test('E2E-WCT1 详情不可用标识 → 接续对话框 → 迁移到 B → 重启节点恢复执行', async ({ page }) => {
    const env = await setupEnv(page, 'wct1')
    await setControllerStatus(env.controllerA.controllerId, 'offline')

    await page.goto(`/workflows/${env.instanceId}`)
    await expect(page.getByTestId('workflow-unavailable-notice')).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('workflow-unavailable-notice')).toContainText('控制器离线')

    await page.getByRole('button', { name: '接续', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // 新控制器 B（A 已离线，不在选项中）
    await dialog.getByRole('combobox', { name: '新控制器' }).click()
    await page.getByRole('option', { name: /wct-b-/ }).click()

    await dialog.getByRole('combobox', { name: '工作路径' }).click()
    await page.getByRole('option', { name: new RegExp(`e2e-wct-wct1-b`) }).click()

    // Worktree 默认勾选且 B 为 Git 仓库
    await expect(dialog.getByRole('checkbox', { name: '创建新 Worktree' })).toBeChecked()
    await expect(dialog.getByRole('combobox', { name: 'AI执行 Harness' })).toContainText('opencode')

    await dialog.getByRole('button', { name: '确认接续' }).click()
    await expect(page.getByText('工作流已接续到新控制器')).toBeVisible({ timeout: 20000 })
    await expect(page.getByTestId('workflow-unavailable-notice')).toHaveCount(0, { timeout: 20000 })
    expect(env.controllerB.worktrees.length).toBeGreaterThan(0)

    // 收敛后的节点可重启：B 收到 acp:start
    await page.getByRole('button', { name: '重启', exact: true }).click()
    await page.getByRole('button', { name: '确认重启' }).click()
    await expect
      .poll(() => env.controllerB.starts.length, { timeout: 20000 })
      .toBeGreaterThan(0)
    expect(env.controllerB.starts.at(-1)?.serverType).toBe('opencode')

    env.controllerA.disconnect()
    env.controllerB.disconnect()
  })

  test('E2E-WCT2 控制器恢复在线后标识自动消失；可用实例无接续入口', async ({ page }) => {
    const env = await setupEnv(page, 'wct2')
    await setControllerStatus(env.controllerA.controllerId, 'offline')

    await page.goto(`/workflows/${env.instanceId}`)
    await expect(page.getByTestId('workflow-unavailable-notice')).toBeVisible({ timeout: 15000 })
    await expect(page.getByRole('button', { name: '接续', exact: true })).toBeVisible()

    // 控制器恢复在线：5s 轮询自动刷新，标识消失
    await setControllerStatus(env.controllerA.controllerId, 'online')
    await expect(page.getByTestId('workflow-unavailable-notice')).toHaveCount(0, { timeout: 20000 })
    await expect(page.getByRole('button', { name: '接续', exact: true })).toHaveCount(0)

    env.controllerA.disconnect()
    env.controllerB.disconnect()
  })
})
