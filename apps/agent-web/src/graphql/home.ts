import { gql } from '@apollo/client'
import { CLOUD_HOST_FIELDS } from './queries'

// 对齐 contracts/home.graphql（首页展示优化聚合查询，已定稿契约）
//
// 命名 `HomeOverview`（非 `Get*` 前缀）以区别于普通 CRUD 查询，表明这是首页聚合入口。

const HOME_WORKFLOW_INSTANCE_FIELDS = gql`
  fragment HomeWorkflowInstanceFields on WorkflowInstance {
    id
    configuredWorkflowId
    controllerId
    workspaceId
    name
    currentNodeNames
    lastNodeName
    lastNodeStatus
    archived
    workspace {
      id
      name
    }
    controller {
      id
      name
    }
    createdAt
    updatedAt
  }
`

export { HOME_WORKFLOW_INSTANCE_FIELDS }

export const HOME_OVERVIEW = gql`
  query HomeOverview {
    homeOverview {
      controllers {
        id
        name
        hostname
        type
        status
        keyId
        version
        lastHeartbeatAt
        createdAt
        updatedAt
        defaultMcp {
          useAllEnabled
          serverIds
        }
        gateways {
          gateways {
            id
            controllerId
            name
            port
            status
            createdAt
          }
          total
          limit
        }
        cloudHost {
          ...CloudHostFields
        }
      }
      sessions {
        id
        userId
        controllerId
        controllerName
        acpServerType
        status
        title
        externalSessionId
        cwd
        worktreePath
        worktreeBranch
        workflowInstanceId
        workflowNodeId
        createdAt
        updatedAt
        endedAt
      }
      sessionTotalCount
      workspaces {
        id
        userId
        controllerId
        name
        path
        isEnabled
        isGitRepo
        defaultBranch
        createdAt
        updatedAt
        worktrees {
          path
          branch
          sessionCount
          sessions {
            id
            title
            status
            worktreePath
          }
        }
      }
      workflowInstances {
        ...HomeWorkflowInstanceFields
      }
      archivedWorkflowInstances {
        ...HomeWorkflowInstanceFields
      }
      todos {
        id
        type
        priority
        title
        description
        isRead
        data {
          requestId
          sessionId
          toolCallId
          toolCall {
            toolCallId
            title
            kind
            rawInput
            locations
          }
          options {
            optionId
            name
            kind
          }
        }
        elicitationData {
          requestId
          sessionId
          toolCallId
          mode
          message
          requestedSchema
          elicitationId
          url
        }
        resolution
        resolvedAt
        expiresAt
        createdAt
      }
      unreadTodoCount
    }
  }
  ${HOME_WORKFLOW_INSTANCE_FIELDS}
  ${CLOUD_HOST_FIELDS}
`
