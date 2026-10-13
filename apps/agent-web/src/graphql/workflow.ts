import { gql } from '@apollo/client'

// 对齐 contracts/workflow.graphql（已定稿契约）

export type WorkflowNodeType = 'HUMAN' | 'AI' | 'FLAG'

export type ResourceCreatedBy = 'HUMAN' | 'AI'

export type InstantiateSource = 'CONFIGURED' | 'TEMPLATE' | 'BLANK'

export type WorkflowNodeStatus =
  | 'INITIALIZING'
  | 'READY'
  | 'RUNNING'
  | 'DONE'
  | 'REJECT'
  | 'REWORK'
  | 'FAILED'

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
  nodes: ConfiguredWorkflowNodeData[]
  createdBy: ResourceCreatedBy
  createdAt: string
  updatedAt: string
}

export interface WorkflowNodeRejectInfoData {
  reason: string
  fromNodeId: string | null
  at: string
}

export interface WorkflowNodeFailInfoData {
  reason: string
  /** SESSION_STUCK（提醒后仍会停止）/ LLM_REPORTED（LLM 调用 failCurrentNode） */
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
  sortOrder: number | null
  dependsOn: string[]
  createdAt: string
  startedAt: string | null
  reworkedAt: string | null
  reworkCount: number
  rejectInfo: WorkflowNodeRejectInfoData | null
  failInfo: WorkflowNodeFailInfoData | null
}

export interface BlackboardEntryData {
  key: string
  value: string
  updatedAt: string
}

export interface WorkflowInstanceSummaryData {
  id: string
  // 统一实例化三来源中仅 CONFIGURED 来源保证存在，故可空
  configuredWorkflowId: string | null
  controllerId: string
  workspaceId: string
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
  sortOrder?: number | null
}

export interface ConfigureWorkflowInput {
  name: string
  controllerId: string
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
      createdAt
      updatedAt
    }
  }
  ${CONFIGURED_NODE_FIELDS}
`

export const GET_WORKFLOW_INSTANCES = gql`
  query GetWorkflowInstances($workspaceId: ID, $controllerId: ID, $archived: Boolean) {
    workflowInstances(workspaceId: $workspaceId, controllerId: $controllerId, archived: $archived) {
      id
      configuredWorkflowId
      controllerId
      workspaceId
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
        createdAt
        startedAt
        reworkedAt
        reworkCount
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
