import { describe, it, expect } from 'vitest'
import { print } from 'graphql'
import {
  GET_CONFIGURED_WORKFLOWS,
  GET_WORKFLOW_INSTANCE,
  GET_WORKFLOW_TEMPLATES,
  SET_WORKFLOW_ADDITIONAL_PROMPT,
  REMOVE_WORKFLOW_ADDITIONAL_PROMPT,
} from '../workflow'

describe('工作流 PR 联动 GraphQL 文档', () => {
  it('GET_WORKFLOW_INSTANCE 选择 additionalPrompts 与 pullRequestLinks', () => {
    const document = print(GET_WORKFLOW_INSTANCE)
    expect(document).toContain('additionalPrompts')
    expect(document).toContain('pullRequestLinks')
    for (const field of [
      'pullRequestId',
      'prUrl',
      'nodeId',
      'nodeName',
      'registeredAt',
      'checkRunUrl',
      'lastSyncedCommitSha',
      'lastSyncAt',
      'lastSyncError',
    ]) {
      expect(document).toContain(field)
    }
    expect(document).toContain('linkUpstreamPullRequest')
  })

  it('模板/已配置节点查询包含联动字段', () => {
    expect(print(GET_WORKFLOW_TEMPLATES)).toContain('linkUpstreamPullRequest')
    expect(print(GET_CONFIGURED_WORKFLOWS)).toContain('linkUpstreamPullRequest')
  })

  it('追加提示词 mutation 与契约一致', () => {
    expect(print(SET_WORKFLOW_ADDITIONAL_PROMPT)).toContain(
      'setWorkflowAdditionalPrompt(instanceId: $instanceId, key: $key, value: $value)',
    )
    expect(print(REMOVE_WORKFLOW_ADDITIONAL_PROMPT)).toContain(
      'removeWorkflowAdditionalPrompt(instanceId: $instanceId, key: $key)',
    )
  })
})
