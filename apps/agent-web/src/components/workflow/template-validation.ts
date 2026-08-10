import type { WorkflowNodeType, WorkflowTemplateNodeInput } from '@/graphql/workflow'

/** 模板编辑器中的可编辑节点（prompts/artifactTitles 以「每行一条」文本编辑） */
export interface EditableNode {
  nodeKey: string
  type: WorkflowNodeType
  name: string
  description: string
  stage: string
  promptsText: string
  artifactTitlesText: string
  dependsOn: string[]
  requiresWorktree: boolean
}

export function createEmptyNode(type: WorkflowNodeType = 'HUMAN'): EditableNode {
  return {
    nodeKey: '',
    type,
    name: '',
    description: '',
    stage: '',
    promptsText: '',
    artifactTitlesText: '',
    dependsOn: [],
    requiresWorktree: false,
  }
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export function toNodeInput(node: EditableNode): WorkflowTemplateNodeInput {
  const isAi = node.type === 'AI'
  return {
    nodeKey: node.nodeKey.trim(),
    type: node.type,
    name: node.name.trim(),
    description: node.description.trim() || null,
    stage: node.stage.trim(),
    prompts: isAi ? splitLines(node.promptsText) : null,
    artifactTitles: isAi ? splitLines(node.artifactTitlesText) : null,
    dependsOn: node.dependsOn,
    requiresWorktree: isAi ? node.requiresWorktree : false,
  }
}

/**
 * 前端基础校验（后端仍会做完整图校验：DAG、唯一首节点等）。
 * 返回错误文案列表，空数组表示通过。
 */
export function validateTemplateNodes(nodes: EditableNode[]): string[] {
  const errors: string[] = []

  if (nodes.length === 0) {
    errors.push('至少需要一个节点')
    return errors
  }

  const keys = nodes.map((n) => n.nodeKey.trim())
  const keySet = new Set(keys)

  nodes.forEach((node, index) => {
    const label = `节点 ${index + 1}`
    if (!node.nodeKey.trim()) {
      errors.push(`${label}：节点标识（nodeKey）不能为空`)
    }
    if (!node.name.trim()) {
      errors.push(`${label}：节点名称不能为空`)
    }
    if (!node.stage.trim()) {
      errors.push(`${label}：所属阶段不能为空`)
    }
    if (node.type === 'AI' && splitLines(node.promptsText).length === 0) {
      errors.push(`${label}「${node.name.trim() || node.nodeKey.trim()}」：AI 节点至少需要一条提示词`)
    }
    for (const dep of node.dependsOn) {
      if (dep === node.nodeKey.trim()) {
        errors.push(`${label}：不能依赖自身`)
      } else if (!keySet.has(dep)) {
        errors.push(`${label}：依赖的节点「${dep}」不存在`)
      }
    }
  })

  const seen = new Set<string>()
  for (const key of keys) {
    if (!key) continue
    if (seen.has(key)) {
      errors.push(`节点标识「${key}」重复`)
    }
    seen.add(key)
  }

  // 首节点（入度为 0）必须唯一且为人类节点
  const firstNodes = nodes.filter((n) => n.dependsOn.length === 0)
  if (firstNodes.length === 0) {
    errors.push('必须有一个首节点（无上游依赖的节点）')
  } else if (firstNodes.length > 1) {
    errors.push('首节点必须唯一（仅允许一个无上游依赖的节点）')
  } else if (firstNodes[0].type !== 'HUMAN') {
    errors.push('首节点必须是人类节点')
  }

  return errors
}
