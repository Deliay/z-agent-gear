import type {
  WorkflowNodeType,
  WorkflowTemplateNodeInput,
  ConfiguredWorkflowNodeInput,
  AgentNodeConfigInput,
  ConfiguredWorkflowNodeData,
} from '@/graphql/workflow'

/** Agent 配置表单状态（acpServerType/modeId/modelId/initNewWorktree） */
export interface AgentConfigForm {
  acpServerType: string
  modeId: string
  modelId: string
  initNewWorktree: boolean
}

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
  /** 人类节点：是否联动上游 Pull Request */
  linkUpstreamPullRequest: boolean
  /** 已配置/实例化场景下的 Agent 配置；模板节点为 null（模板不含 agentConfig） */
  agentConfig?: AgentConfigForm | null
  /** 展示顺序（仅影响 UI 排列，不影响执行顺序） */
  sortOrder?: number | null
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
    linkUpstreamPullRequest: false,
    agentConfig: null,
    sortOrder: null,
  }
}

export function emptyAgentConfig(): AgentConfigForm {
  return { acpServerType: '', modeId: '', modelId: '', initNewWorktree: false }
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** 模板节点 → 可编辑节点（不含 agentConfig） */
export function templateNodeToEditable(
  node: {
    nodeKey: string
    type: WorkflowNodeType
    name: string
    description: string | null
    stage: string
    prompts: string[] | null
    artifactTitles: string[] | null
    dependsOn: string[]
    requiresWorktree: boolean
    linkUpstreamPullRequest?: boolean
    sortOrder?: number | null
  },
): EditableNode {
  return {
    nodeKey: node.nodeKey,
    type: node.type,
    name: node.name,
    description: node.description ?? '',
    stage: node.stage,
    promptsText: (node.prompts ?? []).join('\n'),
    artifactTitlesText: (node.artifactTitles ?? []).join('\n'),
    dependsOn: node.dependsOn,
    requiresWorktree: node.requiresWorktree,
    linkUpstreamPullRequest: node.type === 'HUMAN' ? (node.linkUpstreamPullRequest ?? false) : false,
    agentConfig: null,
    sortOrder: node.sortOrder ?? null,
  }
}

/** 已配置工作流节点 → 可编辑节点（含 agentConfig，供配置界面/实例化界面载入） */
export function configuredNodeToEditable(node: ConfiguredWorkflowNodeData): EditableNode {
  return {
    ...templateNodeToEditable(node),
    agentConfig: node.agentConfig
      ? {
          acpServerType: node.agentConfig.acpServerType,
          modeId: node.agentConfig.modeId ?? '',
          modelId: node.agentConfig.modelId ?? '',
          initNewWorktree: node.agentConfig.initNewWorktree,
        }
      : null,
  }
}

/** 可编辑节点 → 模板节点入参（不含 agentConfig，模板编辑器使用） */
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
    linkUpstreamPullRequest: node.type === 'HUMAN' ? node.linkUpstreamPullRequest : false,
    sortOrder: node.sortOrder,
  }
}

/** 可编辑节点 → 已配置工作流节点入参（全量，含 agentConfig，配置界面/实例化界面使用） */
export function toConfiguredNodeInput(node: EditableNode): ConfiguredWorkflowNodeInput {
  const isAi = node.type === 'AI'
  const config: AgentNodeConfigInput | null =
    isAi && node.agentConfig
      ? {
          acpServerType: node.agentConfig.acpServerType,
          modeId: node.agentConfig.modeId.trim() || null,
          modelId: node.agentConfig.modelId.trim() || null,
          initNewWorktree: node.agentConfig.initNewWorktree,
        }
      : null
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
    linkUpstreamPullRequest: node.type === 'HUMAN' ? node.linkUpstreamPullRequest : false,
    agentConfig: config,
    sortOrder: node.sortOrder,
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
    if (node.type !== 'HUMAN' && node.linkUpstreamPullRequest) {
      errors.push(`${label}「${node.name.trim() || node.nodeKey.trim()}」：仅人类节点可开启「联动上游 Pull Request」`)
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

/**
 * 已配置/实例化节点图校验 = 图校验 + Agent 配置校验。
 * 图校验与模板一致；AI 节点需已选 acpServerType（模式/模型可选）。
 */
export function validateConfiguredNodes(nodes: EditableNode[]): string[] {
  const errors = validateTemplateNodes(nodes)
  nodes.forEach((node, index) => {
    if (node.type !== 'AI') return
    const label = `节点 ${index + 1}`
    if (!node.agentConfig?.acpServerType) {
      errors.push(`${label}「${node.name.trim() || node.nodeKey.trim()}」：请为 AI 节点选择 Harness 工具`)
    }
  })
  return errors
}
