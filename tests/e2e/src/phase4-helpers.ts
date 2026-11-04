import { expect, type Page } from '@playwright/test'
import { io as SocketIOClient, type Socket } from 'socket.io-client'
import mongoose from 'mongoose'
import {
  createControllerKey,
  createWorkspace,
  gqlRequest,
  registerUser,
} from './helpers'

export const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001'

export interface Phase4Controller {
  controllerId: string
  socket: Socket
  starts: Array<{ requestId: string; sessionId: string; mcpEndpoint?: { token: string; serverNames: string[] } }>
  disconnect: () => void
}

/** 侧边栏/图表 E2E 用 fake controller：应答 acp:check/start/stop 与 git 探测 */
export function registerPhase4Controller(rawKey: string, hostname: string): Promise<Phase4Controller> {
  return new Promise((resolve, reject) => {
    const client = SocketIOClient(CONTROLLER_API_URL, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    })
    const timer = setTimeout(() => {
      client.disconnect()
      reject(new Error('Timeout registering controller'))
    }, 10000)
    const starts: Phase4Controller['starts'] = []

    client.on('acp:check', (data: { requestId: string }) => {
      client.emit('acp:check:result', {
        requestId: data.requestId,
        servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
      })
    })
    client.on('git:check', (data: { requestId: string }) => {
      client.emit('git:check:result', { requestId: data.requestId, isGitRepo: false })
    })
    client.on('git:worktree:list', (data: { requestId: string }) => {
      client.emit('git:worktree:list:result', { requestId: data.requestId, success: true, worktrees: [] })
    })
    client.on('acp:start', (data: { requestId: string; sessionId: string; mcpEndpoint?: { token: string; serverNames: string[] } }) => {
      starts.push(data)
      client.emit('acp:start:result', {
        requestId: data.requestId,
        sessionId: data.sessionId,
        success: true,
        externalSessionId: `ext_${data.sessionId}`,
      })
    })
    client.on('acp:resume', (data: { requestId: string; sessionId: string }) => {
      client.emit('acp:resume:result', { requestId: data.requestId, sessionId: data.sessionId, success: true })
    })
    client.on('acp:stop', (data: { sessionId: string }) => {
      client.emit('acp:stopped', { sessionId: data.sessionId, reason: 'user_close' })
    })

    client.once('registered', (data: { controllerId: string }) => {
      clearTimeout(timer)
      resolve({
        controllerId: data.controllerId,
        socket: client,
        starts,
        disconnect: () => client.disconnect(),
      })
    })
    client.once('error', (data: { message: string }) => {
      clearTimeout(timer)
      client.disconnect()
      reject(new Error(`Register failed: ${data.message}`))
    })
    client.emit('register', { key: rawKey, hostname, version: '2.0.0' })
  })
}

export async function gql<T>(
  page: Page,
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const response = await gqlRequest(page, query, variables, token)
  const body = await response.json()
  if (body.errors) throw new Error(JSON.stringify(body.errors))
  return body.data as T
}

export interface InstantiateNodeInput {
  nodeKey: string
  type: 'HUMAN' | 'AI'
  name: string
  stage: string
  dependsOn: string[]
  requiresWorktree: boolean
  prompts?: string[]
  artifactTitles?: string[]
  agentConfig?: { acpServerType: string; initNewWorktree: boolean }
}

/** 三节点图：hum2 ← hum1（人类） ← ai（AI） */
export function phase4Nodes(): InstantiateNodeInput[] {
  return [
    { nodeKey: 'input', type: 'HUMAN', name: '需求输入', stage: '需求', dependsOn: [], requiresWorktree: false },
    { nodeKey: 'review', type: 'HUMAN', name: '方案评审', stage: '方案', dependsOn: ['input'], requiresWorktree: false },
    {
      nodeKey: 'exec',
      type: 'AI',
      name: 'AI执行',
      stage: '实现',
      dependsOn: ['review'],
      requiresWorktree: false,
      prompts: ['按方案实现'],
      artifactTitles: ['实现产物'],
      agentConfig: { acpServerType: 'opencode', initNewWorktree: false },
    },
  ]
}

export interface Phase4InstanceNode {
  id: string
  nodeKey: string
  name: string
  status: string
  sessionId: string | null
}

export interface Phase4Instance {
  id: string
  name: string
  nodes: Phase4InstanceNode[]
  blackboard: Array<{ key: string; value: string }>
  additionalPrompts: Array<{ key: string; value: string }>
}

export async function instantiatePhase4Workflow(
  page: Page,
  token: string,
  controllerId: string,
  workspaceId: string,
  name: string,
  nodes = phase4Nodes(),
): Promise<Phase4Instance> {
  const data = await gql<{ instantiateWorkflow: Phase4Instance }>(
    page,
    token,
    `mutation Instantiate($input: InstantiateWorkflowInput!) {
      instantiateWorkflow(input: $input) {
        id name
        nodes { id nodeKey name status sessionId }
        blackboard { key value }
        additionalPrompts { key value }
      }
    }`,
    {
      input: {
        source: 'BLANK',
        controllerId,
        workspaceId,
        name,
        nodes,
      },
    },
  )
  return data.instantiateWorkflow
}

export async function getPhase4Instance(page: Page, token: string, instanceId: string): Promise<Phase4Instance> {
  const data = await gql<{ workflowInstance: Phase4Instance }>(
    page,
    token,
    `query Instance($id: ID!) {
      workflowInstance(id: $id) {
        id name
        nodes { id nodeKey name status sessionId }
        blackboard { key value }
        additionalPrompts { key value }
      }
    }`,
    { id: instanceId },
  )
  return data.workflowInstance
}

export async function completeHumanNode(
  page: Page,
  token: string,
  instanceId: string,
  nodeId: string,
  input: string,
): Promise<void> {
  await gql(page, token, `mutation Complete($instanceId: ID!, $nodeId: ID!, $input: String) {
    completeHumanNode(instanceId: $instanceId, nodeId: $nodeId, input: $input) { id status }
  }`, { instanceId, nodeId, input })
}

export async function rejectNode(
  page: Page,
  token: string,
  instanceId: string,
  nodeId: string,
  reason: string,
): Promise<void> {
  await gql(page, token, `mutation Reject($instanceId: ID!, $nodeId: ID!, $reason: String!) {
    rejectNode(instanceId: $instanceId, nodeId: $nodeId, reason: $reason) { id status }
  }`, { instanceId, nodeId, reason })
}

/** 注入 ACP 消息（走 fake controller 的 acp:message，服务端落库并经会话 SSE 下发） */
export function injectSessionUpdate(
  controller: Phase4Controller,
  sessionId: string,
  update: Record<string, unknown>,
): void {
  // 契约：acp:message 的 message 字段即 ACP SessionUpdate 对象
  controller.socket.emit('acp:message', { sessionId, message: update })
}

export interface Phase4Env {
  token: string
  username: string
  controllers: Phase4Controller[]
  workspaces: Array<{ id: string; path: string }>
  instances: Phase4Instance[]
}

export interface SetupPhase4Options {
  /** 主机数量（跨环境聚合用例传 2） */
  controllerCount?: number
  /** 每台主机创建一个实例（BLANK 三节点图） */
  withInstances?: boolean
  /** 每台主机创建一个会话 */
  withSessions?: boolean
}

/** 注册用户 + N 台 fake 主机 + 工作区（可选实例/会话） */
export async function setupPhase4Env(
  page: Page,
  tag: string,
  options: SetupPhase4Options = {},
): Promise<Phase4Env> {
  const { controllerCount = 1, withInstances = false, withSessions = false } = options
  const { token, username } = await registerUser(page)
  const controllers: Phase4Controller[] = []
  const workspaces: Array<{ id: string; path: string }> = []
  const instances: Phase4Instance[] = []

  for (let index = 0; index < controllerCount; index += 1) {
    const { rawKey } = await createControllerKey(page, token)
    const controller = await registerPhase4Controller(
      rawKey,
      `p4-${tag}-${index}-${Date.now().toString(36)}`,
    )
    controllers.push(controller)
    const path = `/tmp/e2e-p4-${tag}-${index}-${Date.now().toString(36)}`
    const workspace = await createWorkspace(page, controller.controllerId, path, token)
    workspaces.push({ id: workspace.id, path })

    if (withSessions) {
      await gql(page, token, `mutation Create($input: CreateSessionInput!) {
        createSession(input: $input) { session { id } }
      }`, {
        input: { controllerId: controller.controllerId, acpServerType: 'opencode', workspaceId: workspace.id },
      })
    }
    if (withInstances) {
      instances.push(
        await instantiatePhase4Workflow(
          page,
          token,
          controller.controllerId,
          workspace.id,
          `p4-${tag}-实例-${index}-${Date.now().toString(36)}`,
        ),
      )
    }
  }

  return { token, username, controllers, workspaces, instances }
}

async function mongoDb() {
  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error('MONGODB_URI 未配置')
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri)
  return mongoose.connection.db!
}

/** 直写实例字段（状态/黑板/追加提示词等），用于构造图表展示型 fixture */
export async function seedInstance(
  instanceId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const db = await mongoDb()
  await db
    .collection('workflowinstances')
    .updateOne({ _id: new mongoose.Types.ObjectId(instanceId) }, { $set: fields })
}

/** 直写 PR 联动记录（供 PR/检查项徽标展示用例） */
export async function seedPullRequestLink(
  instanceId: string,
  link: {
    nodeId: string
    nodeKey?: string
    pullRequestId: string
    prUrl?: string | null
    checkRunUrl?: string | null
    commitSha?: string | null
  },
): Promise<void> {
  const db = await mongoDb()
  const instance = await db
    .collection('workflowinstances')
    .findOne({ _id: new mongoose.Types.ObjectId(instanceId) })
  if (!instance) throw new Error('workflow instance not found')
  await db.collection('workflowprhandlers').insertOne({
    userId: instance.userId,
    tenantId: instance.tenantId,
    workflowInstanceId: new mongoose.Types.ObjectId(instanceId),
    nodeId: link.nodeId,
    nodeKey: link.nodeKey ?? null,
    pullRequestId: link.pullRequestId,
    pullRequestIdLower: link.pullRequestId.toLowerCase(),
    prUrl: link.prUrl ?? null,
    lastCheckRunUrl: link.checkRunUrl ?? null,
    lastWrittenCommitSha: link.commitSha ?? null,
    lastSyncAt: link.checkRunUrl ? new Date('2026-10-31T12:00:00Z') : null,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
}

/** 轮询等待条件 */
export async function waitFor<T>(
  fn: () => T | Promise<T> | undefined | null | false,
  timeoutMs = 15000,
  label = 'condition',
): Promise<NonNullable<T>> {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value as NonNullable<T>
    if (Date.now() - start > timeoutMs) throw new Error(`Timeout waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/** 调用工作流 MCP 工具（模拟 Agent 完成节点） */
export async function callWorkflowTool(
  controller: Phase4Controller,
  sessionId: string,
  mcpToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; data: Record<string, unknown> }> {
  const requestId = `p4_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
  const response = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.socket.off('mcp:response', onResponse)
      reject(new Error('Timeout waiting for mcp:response'))
    }, 10000)
    const onResponse = (data: { requestId: string; status: number; body: unknown }) => {
      if (data.requestId !== requestId) return
      clearTimeout(timer)
      controller.socket.off('mcp:response', onResponse)
      resolve({ status: data.status, body: (data.body ?? {}) as Record<string, unknown> })
    }
    controller.socket.on('mcp:response', onResponse)
    controller.socket.emit('mcp:request', {
      requestId,
      sessionId,
      serverName: 'agent-workflow-tools',
      token: mcpToken,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    })
  })
  expect(response.status).toBe(200)
  const result = (response.body as { result: { isError?: boolean; content: Array<{ text: string }> } }).result
  return { isError: Boolean(result.isError), data: JSON.parse(result.content[0].text) }
}

export const SIDEBAR = 'nav[aria-label="Sidebar"]'
export const sectionToggle = (key: 'hosts' | 'workflows' | 'sessions' | 'gateways') =>
  `[data-testid="sidebar-section-${key}"] > div > button[aria-expanded]`
export const nodeCard = (nodeId: string) => `[data-testid="workflow-node-card-${nodeId}"]`
