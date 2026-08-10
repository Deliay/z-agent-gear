import { gql } from '@apollo/client'

// 对齐 contracts/workflow.graphql（已定稿契约）

export type WorkflowNodeType = 'HUMAN' | 'AI' | 'FLAG'

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
}

export interface WorkflowTemplateData {
  id: string
  name: string
  description: string | null
  version: number
  nodes: WorkflowTemplateNodeData[]
  isBuiltin: boolean
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
}

export interface ConfiguredWorkflowData {
  id: string
  name: string
  controllerId: string
  sourceTemplateId: string | null
  sourceTemplateVersion: number | null
  nodes: ConfiguredWorkflowNodeData[]
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
  configuredWorkflowId: string
  controllerId: string
  workspaceId: string
  name: string
  currentNodeNames: string[]
  createdAt: string
  updatedAt: string
}

export interface WorkflowInstanceData extends WorkflowInstanceSummaryData {
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
  agentConfig?: AgentNodeConfigInput | null
}

export interface ConfigureWorkflowInput {
  name: string
  controllerId: string
  nodes: ConfiguredWorkflowNodeInput[]
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
      createdAt
      updatedAt
    }
  }
  ${CONFIGURED_NODE_FIELDS}
`

export const GET_WORKFLOW_INSTANCES = gql`
  query GetWorkflowInstances($workspaceId: ID!) {
    workflowInstances(workspaceId: $workspaceId) {
      id
      configuredWorkflowId
      controllerId
      workspaceId
      name
      currentNodeNames
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
      nodes {
        id
        nodeKey
        type
        name
        description
        status
        stage
        sessionId
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

export const INSTANTIATE_WORKFLOW = gql`
  mutation InstantiateWorkflow($configuredWorkflowId: ID!, $workspaceId: ID!, $name: String!) {
    instantiateWorkflow(configuredWorkflowId: $configuredWorkflowId, workspaceId: $workspaceId, name: $name) {
      id
      name
      workspaceId
      currentNodeNames
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
