import { describe, expect, it } from 'vitest'
import { MAX_NODE_RESOURCES, buildGraphViewModel, buildResourceOwnership } from '../graph-layout'
import type { WorkflowInstanceData, WorkflowNodeData } from '@/graphql/workflow'

function node(overrides: Partial<WorkflowNodeData> & { id: string; name: string }): WorkflowNodeData {
  return {
    nodeKey: overrides.id,
    type: 'AI',
    description: null,
    status: 'READY',
    stage: '阶段',
    sessionId: null,
    prompts: null,
    artifactTitles: null,
    agentConfig: null,
    requiresWorktree: null,
    linkUpstreamPullRequest: false,
    sortOrder: null,
    dependsOn: [],
    createdAt: '',
    startedAt: null,
    reworkedAt: null,
    reworkCount: 0,
    rejectInfo: null,
    failInfo: null,
    ...overrides,
  }
}

function instance(overrides: Partial<WorkflowInstanceData> = {}): WorkflowInstanceData {
  return {
    id: 'inst-1',
    configuredWorkflowId: null,
    controllerId: 'ctrl-1',
    workspaceId: 'ws-1',
    name: '实例',
    currentNodeNames: [],
    lastNodeName: null,
    lastNodeStatus: null,
    archived: false,
    workspace: null,
    controller: null,
    workflowWorktreePath: null,
    workflowWorktreeBranch: null,
    nodes: [
      node({ id: 'n1', name: '评审' }),
      node({ id: 'n2', name: '实现', status: 'RUNNING', sessionId: 's2' }),
    ],
    blackboard: [],
    blackboardTrash: [],
    additionalPrompts: [],
    pullRequestLinks: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

function entry(key: string, value = 'v') {
  return { key, value, updatedAt: '' }
}

describe('buildResourceOwnership', () => {
  it('T-UI4-GL6 黑板 key 前缀归属到对应节点', () => {
    const ownership = buildResourceOwnership(
      instance({ blackboard: [entry('n1-评审-产物-评审报告', '通过')] }),
    )
    const resources = ownership.byNode.get('n1')!
    expect(resources).toHaveLength(1)
    expect(resources[0].title).toBe('评审报告')
    expect(resources[0].kind).toBe('blackboard')
    expect(ownership.instanceResources).toHaveLength(0)
  })

  it('T-UI4-GL7 PR 按 nodeId 精确归属', () => {
    const ownership = buildResourceOwnership(
      instance({
        pullRequestLinks: [
          {
            pullRequestId: 'acme/repo#1',
            prUrl: 'https://github.com/acme/repo/pull/1',
            nodeId: 'n2',
            nodeName: '实现',
            registeredAt: '',
            checkRunUrl: 'https://checks/1',
            lastSyncedCommitSha: 'abc',
            lastSyncAt: '',
            lastSyncError: null,
          },
        ],
      }),
    )
    expect(ownership.byNode.get('n2')!.map((r) => r.kind)).toEqual(['pr'])
    expect(ownership.byNode.get('n2')![0].url).toBe('https://github.com/acme/repo/pull/1')
  })

  it('T-UI4-GL8 追加提示词：恰好一个执行中节点时归属该节点', () => {
    const ownership = buildResourceOwnership(
      instance({ additionalPrompts: [{ key: 'review', value: '请重点看测试' }] }),
    )
    expect(ownership.byNode.get('n2')!.map((r) => r.kind)).toEqual(['prompt'])
    expect(ownership.instanceResources).toHaveLength(0)
  })

  it('T-UI4-GL9 多执行中/零执行中：追加提示词入实例资源行', () => {
    const multi = buildResourceOwnership(
      instance({
        nodes: [node({ id: 'a', name: 'A', status: 'RUNNING' }), node({ id: 'b', name: 'B', status: 'REWORK' })],
        additionalPrompts: [{ key: 'k', value: 'v' }],
      }),
    )
    expect(multi.instanceResources.map((r) => r.kind)).toEqual(['prompt'])
    const none = buildResourceOwnership(
      instance({
        nodes: [node({ id: 'a', name: 'A', status: 'DONE' })],
        additionalPrompts: [{ key: 'k', value: 'v' }],
      }),
    )
    expect(none.instanceResources).toHaveLength(1)
  })

  it('T-UI4-GL10 垃圾桶不渲染 + 无法解析的黑板条目入实例资源行', () => {
    const view = buildGraphViewModel(
      instance({
        blackboard: [entry('legacy-key-without-marker', 'old')],
        blackboardTrash: [entry('n1-评审-产物-已删除', 'gone')],
      }),
    )
    expect(view.instanceResources).toHaveLength(1)
    expect(view.instanceResources[0].title).toBe('legacy-key-without-marker')
    const allResourceTitles = view.nodes.flatMap((n) => n.data.resources.map((r) => r.title))
    expect(allResourceTitles).not.toContain('已删除')
  })

  it('单节点最多可见 3 个资源，其余折叠计数', () => {
    const blackboard = Array.from({ length: MAX_NODE_RESOURCES + 2 }, (_, i) =>
      entry(`n1-评审-产物-产物${i}`),
    )
    const view = buildGraphViewModel(instance({ blackboard }))
    const card = view.nodes.find((n) => n.id === 'n1')!
    expect(card.data.resources).toHaveLength(MAX_NODE_RESOURCES)
    expect(card.data.moreResources).toBe(2)
  })
})
