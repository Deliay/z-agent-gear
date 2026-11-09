import { gql } from '@apollo/client'

// 对齐 contracts/workflow.graphql（已定稿契约）

export type WorkflowNodeType = 'HUMAN' | 'AI' | 'FLAG'

export type ResourceCreatedBy = 'HUMAN' | 'AI'

export type InstantiateSource = 'CONFIGURED' | 'TEMPLATE' | 'BLANK'

/** 已配置工作流来源：PLATFORM（平台模板/空白创建，默认）/ REPO（项目仓库模板） */
export type ConfiguredWorkflowSourceKind = 'PLATFORM' | 'REPO'

export type WorkflowNodeStatus =
  | 'INITIALIZING'
  | 'READY'
  | 'RUNNING'
  | 'DONE'
  | 'REJECT'
  | 'REWORK'
  | 'FAILED'
  /** 中断自动重试 10 次用尽（阻断流程，可重启节点或会话内指示后恢复） */
  | 'RETRY_FAILED'

export interface WorkflowTemplateNodeData {
  nodeKey: string
  type: WorkflowNodeType
  name: string
  description: string | null
  stage: string
  prompts: string[] | null
  artifactTitles: string[] | null
  dependsOn: string[]
  requiresWorktree: boolean
  linkUpstreamPullRequest: boolean
  sortOrder: number | null
}

export interface WorkflowTemplateData {
  id: string
  name: string
  description: string | null
  version: number
  nodes: WorkflowTemplateNodeData[]
  isBuiltin: boolean
  createdBy: ResourceCreatedBy
  /** 所属租户工作区；系统内置模板恒为 null（多租户二期） */
  resourceWorkspaceId?: string | null
  createdAt: string
  updatedAt: string
}

export interface AgentNodeConfigData {
  acpServerType: string
  modeId: string | null
  modelId: string | null
  initNewWorktree: boolean
}

export interface ConfiguredWorkflowNodeData extends WorkflowTemplateNodeData {
  agentConfig: AgentNodeConfigData | null
  sortOrder: number | null
}

export interface ConfiguredWorkflowData {
  id: string
  name: string
  controllerId: string
  sourceTemplateId: string | null
  sourceTemplateVersion: number | null
  /** 来源（存量行归一为 PLATFORM） */
  sourceKind: ConfiguredWorkflowSourceKind
  /** REPO 来源：模板文件相对仓库根的路径 */
  sourceRepoPath: string | null
  /** REPO 来源：模板所在项目工作区 id */
  sourceWorkspaceId: string | null
  nodes: ConfiguredWorkflowNodeData[]
  createdBy: ResourceCreatedBy
  /** 所属租户工作区（跟随控制器，多租户二期） */
  resourceWorkspaceId?: string
  createdAt: string
  updatedAt: string
}

/** 项目（仓库）内工作流模板：.zag/workflow/templates/ 下的 JSON 文件 */
export interface RepoWorkflowTemplateData {
  fileName: string
  name: string | null
  description: string | null
  nodeCount: number | null
  valid: boolean
  errors: string[]
  nodes: WorkflowTemplateNodeData[]
}

export interface WorkflowNodeRejectInfoData {
  reason: string
  fromNodeId: string | null
  at: string
}

export interface WorkflowNodeFailInfoData {
  reason: string
  /**
   * SESSION_STUCK（提醒后仍会停止）/ LLM_REPORTED（LLM 调用 failCurrentNode）/
   * SESSION_START_FAILED（节点会话启动失败或被移除）/ RETRY_EXHAUSTED（中断自动重试 10 次用尽）
   */
  source: string
  at: string
}

export interface WorkflowNodeData {
  id: string
  nodeKey: string
  type: WorkflowNodeType
  name: string
  description: string | null
  status: WorkflowNodeStatus
  stage: string
  sessionId: string | null
  // 实例快照字段（实例化时从最终节点图复制；旧实例可能缺失）
  prompts: string[] | null
  artifactTitles: string[] | null
  agentConfig: AgentNodeConfigData | null
  requiresWorktree: boolean | null
  linkUpstreamPullRequest: boolean
  sortOrder: number | null
  dependsOn: string[]
  createdAt: string
  startedAt: string | null
  reworkedAt: string | null
  reworkCount: number
  /** 当前中断 episode 已排期的自动重试次数（0~10） */
  retryCount: number
  /** 下次自动重试计划时间（ISO）；null = 无排期 */
  nextRetryAt: string | null
  rejectInfo: WorkflowNodeRejectInfoData | null
  failInfo: WorkflowNodeFailInfoData | null
}

export interface BlackboardEntryData {
  key: string
  value: string
  updatedAt: string
}

export interface WorkflowAdditionalPromptData {
  key: string
  value: string
}

export interface WorkflowPullRequestLinkData {
  pullRequestId: string
  prUrl: string | null
  nodeId: string
  nodeName: string | null
  registeredAt: string
  // ---- check-run 同步状态（只读投影；未同步时为 null） ----
  checkRunUrl: string | null
  lastSyncedCommitSha: string | null
  lastSyncAt: string | null
  lastSyncError: string | null
}

export interface WorkflowInstanceSummaryData {
  id: string
  // 统一实例化三来源中仅 CONFIGURED 来源保证存在，故可空
  configuredWorkflowId: string | null
  controllerId: string
  /** 项目工作区（ControllerWorkspace）id；注意不是租户工作区 */
  workspaceId: string
  /** 租户工作区 id（多租户二期） */
  resourceWorkspaceId?: string
  name: string
  currentNodeNames: string[]
  lastNodeName: string | null
  lastNodeStatus: WorkflowNodeStatus | null
  archived: boolean
  // 归属对象（集中列表展示所属工作区/控制器）；可能已被删除，消费方须判空
  workspace: { id: string; name: string } | null
  controller: { id: string; name: string } | null
  createdAt: string
  updatedAt: string
}

export interface WorkflowInstanceData extends WorkflowInstanceSummaryData {
  workflowWorktreePath: string | null
  workflowWorktreeBranch: string | null
  nodes: WorkflowNodeData[]
  blackboard: BlackboardEntryData[]
  blackboardTrash: BlackboardEntryData[]
  additionalPrompts: WorkflowAdditionalPromptData[]
  pullRequestLinks: WorkflowPullRequestLinkData[]
}

export interface WorkflowTemplateNodeInput {
  nodeKey: string
  type: WorkflowNodeType
  name: string
  description?: string | null
  stage: string
  prompts?: string[] | null
  artifactTitles?: string[] | null
  dependsOn: string[]
  requiresWorktree: boolean
  linkUpstreamPullRequest?: boolean
  sortOrder?: number | null
}

export interface WorkflowTemplateInput {
  name: string
  description?: string | null
  nodes: WorkflowTemplateNodeInput[]
}

export interface AgentNodeConfigInput {
  acpServerType: string
  modeId?: string | null
  modelId?: string | null
  initNewWorktree: boolean
}

export interface ConfiguredWorkflowNodeInput {
  nodeKey: string
  type: WorkflowNodeType
  name: string
  description?: string | null
  stage: string
  prompts?: string[] | null
  artifactTitles?: string[] | null
  dependsOn: string[]
  requiresWorktree: boolean
  // AI 节点必填；HUMAN/FLAG 节点为 null
  agentConfig?: AgentNodeConfigInput | null
  linkUpstreamPullRequest?: boolean
  sortOrder?: number | null
}

export interface ConfigureWorkflowInput {
  name: string
  controllerId: string
  nodes: ConfiguredWorkflowNodeInput[]
}

/** 从项目（仓库）模板配置工作流入参 */
export interface ConfigureRepoWorkflowInput {
  workspaceId: string
  fileName: string
  name: string
  nodes: ConfiguredWorkflowNodeInput[]
}

export interface InstantiateWorkflowInput {
  source: InstantiateSource
  // source=CONFIGURED 必填
  configuredWorkflowId?: string | null
  // source=TEMPLATE 必填
  templateId?: string | null
  controllerId: string
  workspaceId: string
  name: string
  // 实例化前配置界面编辑后的最终节点图（服务端以此为准校验并快照落库）
  nodes: ConfiguredWorkflowNodeInput[]
  // 是否为工作流创建独立 Worktree（默认 false）
  createWorkflowWorktree?: boolean | null
}

export interface WorkflowNodeUpdateInput {
  name?: string | null
  description?: string | null
  stage?: string | null
  prompts?: string[] | null
  artifactTitles?: string[] | null
  requiresWorktree?: boolean | null
  agentConfig?: AgentNodeConfigInput | null
  linkUpstreamPullRequest?: boolean | null
  sortOrder?: number | null
}

// ---------- Query ----------

const TEMPLATE_NODE_FIELDS = gql`
  fragment TemplateNodeFields on WorkflowTemplateNode {
    nodeKey
    type
    name
    description
    stage
    prompts
    artifactTitles
    dependsOn
    requiresWorktree
    linkUpstreamPullRequest
    sortOrder
  }
`

export const GET_WORKFLOW_TEMPLATES = gql`
  query GetWorkflowTemplates {
    workflowTemplates {
      id
      name
      description
      version
      nodes {
        ...TemplateNodeFields
      }
      isBuiltin
      createdBy
      resourceWorkspaceId
      createdAt
      updatedAt
    }
  }
  ${TEMPLATE_NODE_FIELDS}
`

const CONFIGURED_NODE_FIELDS = gql`
  fragment ConfiguredNodeFields on ConfiguredWorkflowNode {
    nodeKey
    type
    name
    description
    stage
    prompts
    artifactTitles
    dependsOn
    requiresWorktree
    linkUpstreamPullRequest
    sortOrder
  }
`

export const GET_CONFIGURED_WORKFLOWS = gql`
  query GetConfiguredWorkflows($controllerId: ID) {
    configuredWorkflows(controllerId: $controllerId) {
      id
      name
      controllerId
      sourceTemplateId
      sourceTemplateVersion
      sourceKind
      sourceRepoPath
      sourceWorkspaceId
      nodes {
        ...ConfiguredNodeFields
        agentConfig {
          acpServerType
          modeId
          modelId
          initNewWorktree
        }
      }
      createdBy
      resourceWorkspaceId
      createdAt
      updatedAt
    }
  }
  ${CONFIGURED_NODE_FIELDS}
`

/**
 * 项目（仓库）工作流模板扫描：控制器离线/版本不足/目录不存在时返回空数组（降级不抛错）。
 * 节点图用于配置弹窗预填。
 */
export const REPO_WORKFLOW_TEMPLATES = gql`
  query RepoWorkflowTemplates($workspaceId: ID!) {
    repoWorkflowTemplates(workspaceId: $workspaceId) {
      fileName
      name
      description
      nodeCount
      valid
      errors
      nodes {
        ...TemplateNodeFields
      }
    }
  }
  ${TEMPLATE_NODE_FIELDS}
`

export const GET_WORKFLOW_INSTANCES = gql`
  query GetWorkflowInstances($workspaceId: ID, $controllerId: ID, $archived: Boolean) {
    workflowInstances(workspaceId: $workspaceId, controllerId: $controllerId, archived: $archived) {
      id
      configuredWorkflowId
      controllerId
      workspaceId
      resourceWorkspaceId
      name
      currentNodeNames
      lastNodeName
      lastNodeStatus
      archived
      workspace { id name }
      controller { id name }
      createdAt
      updatedAt
    }
  }
`

export const GET_WORKFLOW_INSTANCE = gql`
  query GetWorkflowInstance($id: ID!) {
    workflowInstance(id: $id) {
      id
      configuredWorkflowId
      controllerId
      workspaceId
      resourceWorkspaceId
      name
      currentNodeNames
      lastNodeName
      lastNodeStatus
      archived
      workspace { id name }
      controller { id name }
      workflowWorktreePath
      workflowWorktreeBranch
      nodes {
        id
        nodeKey
        type
        name
        description
        status
        stage
        sessionId
        prompts
        artifactTitles
        agentConfig {
          acpServerType
          modeId
          modelId
          initNewWorktree
        }
        requiresWorktree
        sortOrder
        dependsOn
        linkUpstreamPullRequest
        createdAt
        startedAt
        reworkedAt
        reworkCount
        retryCount
        nextRetryAt
        rejectInfo {
          reason
          fromNodeId
          at
        }
        failInfo {
          reason
          source
          at
        }
      }
      blackboard {
        key
        value
        updatedAt
      }
      blackboardTrash {
        key
        value
        updatedAt
      }
      additionalPrompts {
        key
        value
      }
      pullRequestLinks {
        pullRequestId
        prUrl
        nodeId
        nodeName
        registeredAt
        checkRunUrl
        lastSyncedCommitSha
        lastSyncAt
        lastSyncError
      }
      createdAt
      updatedAt
    }
  }
`

// ---------- Mutation ----------

export const CREATE_WORKFLOW_TEMPLATE = gql`
  mutation CreateWorkflowTemplate($input: WorkflowTemplateInput!) {
    createWorkflowTemplate(input: $input) {
      id
      name
      version
      isBuiltin
    }
  }
`

export const UPDATE_WORKFLOW_TEMPLATE = gql`
  mutation UpdateWorkflowTemplate($id: ID!, $input: WorkflowTemplateInput!) {
    updateWorkflowTemplate(id: $id, input: $input) {
      id
      name
      version
    }
  }
`

export const DELETE_WORKFLOW_TEMPLATE = gql`
  mutation DeleteWorkflowTemplate($id: ID!) {
    deleteWorkflowTemplate(id: $id)
  }
`

export const CONFIGURE_WORKFLOW = gql`
  mutation ConfigureWorkflow($templateId: ID!, $input: ConfigureWorkflowInput!) {
    configureWorkflow(templateId: $templateId, input: $input) {
      id
      name
      controllerId
      sourceTemplateId
      sourceTemplateVersion
    }
  }
`

/** 从项目（仓库）模板配置工作流（sourceKind=REPO，快照落库） */
export const CONFIGURE_REPO_WORKFLOW = gql`
  mutation ConfigureRepoWorkflow($input: ConfigureRepoWorkflowInput!) {
    configureRepoWorkflow(input: $input) {
      id
      name
      controllerId
      sourceKind
      sourceRepoPath
      sourceWorkspaceId
    }
  }
`

export const UPDATE_CONFIGURED_WORKFLOW = gql`
  mutation UpdateConfiguredWorkflow($id: ID!, $input: ConfigureWorkflowInput!) {
    updateConfiguredWorkflow(id: $id, input: $input) {
      id
      name
      controllerId
    }
  }
`

export const DELETE_CONFIGURED_WORKFLOW = gql`
  mutation DeleteConfiguredWorkflow($id: ID!) {
    deleteConfiguredWorkflow(id: $id)
  }
`

export const DELETE_WORKFLOW_INSTANCE = gql`
  mutation DeleteWorkflowInstance($id: ID!) {
    deleteWorkflowInstance(id: $id)
  }
`

export const ARCHIVE_WORKFLOW_INSTANCE = gql`
  mutation ArchiveWorkflowInstance($id: ID!, $archived: Boolean!) {
    archiveWorkflowInstance(id: $id, archived: $archived)
  }
`

export const RENAME_WORKFLOW_INSTANCE = gql`
  mutation RenameWorkflowInstance($id: ID!, $name: String!) {
    renameWorkflowInstance(id: $id, name: $name) {
      id
      name
    }
  }
`

export const INSTANTIATE_WORKFLOW = gql`
  mutation InstantiateWorkflow($input: InstantiateWorkflowInput!) {
    instantiateWorkflow(input: $input) {
      id
      name
      workspaceId
      currentNodeNames
    }
  }
`

export const UPDATE_WORKFLOW_NODE = gql`
  mutation UpdateWorkflowNode($instanceId: ID!, $nodeId: ID!, $input: WorkflowNodeUpdateInput!) {
    updateWorkflowNode(instanceId: $instanceId, nodeId: $nodeId, input: $input) {
      id
      status
    }
  }
`

export const COMPLETE_HUMAN_NODE = gql`
  mutation CompleteHumanNode($instanceId: ID!, $nodeId: ID!, $input: String) {
    completeHumanNode(instanceId: $instanceId, nodeId: $nodeId, input: $input) {
      id
      status
    }
  }
`

export const REJECT_NODE = gql`
  mutation RejectNode($instanceId: ID!, $nodeId: ID!, $reason: String!) {
    rejectNode(instanceId: $instanceId, nodeId: $nodeId, reason: $reason) {
      id
      status
    }
  }
`

export const RESTART_NODE = gql`
  mutation RestartNode($instanceId: ID!, $nodeId: ID!, $agentConfig: AgentNodeConfigInput) {
    restartNode(instanceId: $instanceId, nodeId: $nodeId, agentConfig: $agentConfig) {
      id
      status
    }
  }
`

export const SET_WORKFLOW_ADDITIONAL_PROMPT = gql`
  mutation SetWorkflowAdditionalPrompt($instanceId: ID!, $key: String!, $value: String!) {
    setWorkflowAdditionalPrompt(instanceId: $instanceId, key: $key, value: $value) {
      id
      additionalPrompts {
        key
        value
      }
    }
  }
`

export const REMOVE_WORKFLOW_ADDITIONAL_PROMPT = gql`
  mutation RemoveWorkflowAdditionalPrompt($instanceId: ID!, $key: String!) {
    removeWorkflowAdditionalPrompt(instanceId: $instanceId, key: $key) {
      id
      additionalPrompts {
        key
        value
      }
    }
  }
`

// ---------- Query/Mutation 结果类型 ----------

export interface GetWorkflowTemplatesQuery {
  workflowTemplates: WorkflowTemplateData[]
}

export interface GetConfiguredWorkflowsQuery {
  configuredWorkflows: ConfiguredWorkflowData[]
}

export interface GetWorkflowInstancesQuery {
  workflowInstances: WorkflowInstanceSummaryData[]
}

export interface GetWorkflowInstanceQuery {
  workflowInstance: WorkflowInstanceData | null
}
