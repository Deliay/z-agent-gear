import { describe, it, expect } from 'vitest'
import {
  createEmptyNode,
  configuredNodeToEditable,
  emptySessionBehavior,
  normalizeSessionBehavior,
  templateNodeToEditable,
  toConfiguredNodeInput,
  toNodeInput,
  validateConfiguredNodes,
  validateTemplateNodes,
} from '../template-validation'
import type { ConfiguredWorkflowNodeData } from '@/graphql/workflow'

function aiNode(patch: Record<string, unknown> = {}) {
  return {
    ...createEmptyNode('AI'),
    nodeKey: 'exec',
    name: '代码实现',
    stage: '开发',
    promptsText: '实现功能',
    dependsOn: ['review'],
    agentConfig: { acpServerType: 'opencode', modeId: '', modelId: '', initNewWorktree: false },
    ...patch,
  }
}

function humanNode(patch: Record<string, unknown> = {}) {
  return {
    ...createEmptyNode('HUMAN'),
    nodeKey: 'review',
    name: '评审',
    stage: '验收',
    ...patch,
  }
}

const SESSION_BEHAVIOR_KEYS = [
  'reworkSessionBehavior',
  'reworkCompactOriginalContext',
  'resumeSessionBehavior',
  'resumeCompactOriginalContext',
] as const

describe('toNodeInput / toConfiguredNodeInput 会话行为提交口径（T-SB-WEB3）', () => {
  it('AI 节点携带 4 字段，新会话时 compact 恒为 false', () => {
    const node = aiNode({
      reworkSessionBehavior: 'NEW_SESSION',
      // 非法组合：UI 已复位，这里断言提交侧兜底强制 false
      reworkCompactOriginalContext: true,
      resumeSessionBehavior: 'ORIGINAL_SESSION',
      resumeCompactOriginalContext: true,
    })

    const templateInput = toNodeInput(node)
    expect(templateInput).toMatchObject({
      nodeKey: 'exec',
      reworkSessionBehavior: 'NEW_SESSION',
      reworkCompactOriginalContext: false,
      resumeSessionBehavior: 'ORIGINAL_SESSION',
      resumeCompactOriginalContext: true,
    })

    const configuredInput = toConfiguredNodeInput(node)
    expect(configuredInput).toMatchObject({
      reworkSessionBehavior: 'NEW_SESSION',
      reworkCompactOriginalContext: false,
      resumeSessionBehavior: 'ORIGINAL_SESSION',
      resumeCompactOriginalContext: true,
    })
  })

  it('AI 节点缺省会话行为提交为服务端现状默认值', () => {
    const input = toNodeInput(aiNode())
    expect(input).toMatchObject({
      reworkSessionBehavior: 'ORIGINAL_SESSION',
      reworkCompactOriginalContext: false,
      resumeSessionBehavior: 'NEW_SESSION',
      resumeCompactOriginalContext: false,
    })
  })

  it.each(['HUMAN', 'FLAG'] as const)('%s 节点提交的报文不含会话行为键', (type) => {
    const node = {
      ...createEmptyNode(type),
      nodeKey: 'gate',
      name: '闸门',
      stage: '验收',
    }
    for (const input of [toNodeInput(node), toConfiguredNodeInput(node)]) {
      for (const key of SESSION_BEHAVIOR_KEYS) {
        expect(input).not.toHaveProperty(key)
      }
    }
  })
})

describe('configuredNodeToEditable / templateNodeToEditable 会话行为归一', () => {
  function configuredNode(
    patch: Partial<ConfiguredWorkflowNodeData> = {},
  ): ConfiguredWorkflowNodeData {
    return {
      nodeKey: 'exec',
      type: 'AI',
      name: '代码实现',
      description: null,
      stage: '开发',
      prompts: ['实现功能'],
      artifactTitles: null,
      dependsOn: ['review'],
      requiresWorktree: false,
      linkUpstreamPullRequest: false,
      agentConfig: {
        acpServerType: 'opencode',
        modeId: null,
        modelId: null,
        initNewWorktree: false,
      },
      sortOrder: null,
      ...patch,
    } as ConfiguredWorkflowNodeData
  }

  it('缺失字段（存量行）归一为默认值', () => {
    expect(configuredNodeToEditable(configuredNode())).toMatchObject(emptySessionBehavior())
  })

  it('显式值原样保留', () => {
    const editable = configuredNodeToEditable(
      configuredNode({
        reworkSessionBehavior: 'NEW_SESSION',
        reworkCompactOriginalContext: false,
        resumeSessionBehavior: 'ORIGINAL_SESSION',
        resumeCompactOriginalContext: true,
      }),
    )
    expect(editable).toMatchObject({
      reworkSessionBehavior: 'NEW_SESSION',
      reworkCompactOriginalContext: false,
      resumeSessionBehavior: 'ORIGINAL_SESSION',
      resumeCompactOriginalContext: true,
    })
  })

  it('新会话 + compact=true 的脏数据在读取侧被归一为 false', () => {
    expect(
      normalizeSessionBehavior({
        reworkSessionBehavior: 'NEW_SESSION',
        reworkCompactOriginalContext: true,
        resumeSessionBehavior: 'NEW_SESSION',
        resumeCompactOriginalContext: true,
      }),
    ).toEqual({
      reworkSessionBehavior: 'NEW_SESSION',
      reworkCompactOriginalContext: false,
      resumeSessionBehavior: 'NEW_SESSION',
      resumeCompactOriginalContext: false,
    })
  })

  it('模板节点读取走同一归一（含 HUMAN/FLAG 的 null）', () => {
    const editable = templateNodeToEditable({
      nodeKey: 'review',
      type: 'HUMAN',
      name: '评审',
      description: null,
      stage: '验收',
      prompts: null,
      artifactTitles: null,
      dependsOn: [],
      requiresWorktree: false,
      reworkSessionBehavior: null,
      reworkCompactOriginalContext: null,
      resumeSessionBehavior: null,
      resumeCompactOriginalContext: null,
    })
    expect(editable).toMatchObject(emptySessionBehavior())
  })
})

describe('validateTemplateNodes / validateConfiguredNodes 压缩勾选前置校验', () => {
  it('返工时=新会话时开启压缩被拒绝', () => {
    const nodes = [
      humanNode(),
      aiNode({
        reworkSessionBehavior: 'NEW_SESSION',
        reworkCompactOriginalContext: true,
      }),
    ]
    const errors = validateTemplateNodes(nodes).join('\n')
    expect(errors).toContain('「返工时」为「新会话」时不可开启「压缩原始上下文」')
  })

  it('打回后=新会话时开启压缩被拒绝（已配置节点同样覆盖）', () => {
    const nodes = [
      humanNode(),
      aiNode({
        resumeSessionBehavior: 'NEW_SESSION',
        resumeCompactOriginalContext: true,
      }),
    ]
    expect(validateConfiguredNodes(nodes).join('\n')).toContain(
      '「打回后」为「新会话」时不可开启「压缩原始上下文」',
    )
  })

  it('原始会话 + 压缩勾选合法', () => {
    const nodes = [
      humanNode(),
      aiNode({
        reworkSessionBehavior: 'ORIGINAL_SESSION',
        reworkCompactOriginalContext: true,
        resumeSessionBehavior: 'ORIGINAL_SESSION',
        resumeCompactOriginalContext: true,
      }),
    ]
    expect(validateTemplateNodes(nodes)).toEqual([])
    expect(validateConfiguredNodes(nodes)).toEqual([])
  })
})
