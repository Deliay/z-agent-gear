import { useCallback, useState } from 'react'
import { useMutation } from '@apollo/client/react'
import { CREATE_CLOUD_HOST, SETUP_CLOUD_HOST_GITHUB_PROJECT } from '../graphql/mutations'
import type {
  CloudHostData,
  CreateCloudHostMutation,
  HarnessType,
  SetupCloudHostGithubProjectMutation,
} from '../graphql/types'

export interface CloudHostProjectSelection {
  accountId: string
  repoFullName: string
  /** 归一后的 clone 前缀（不是最终目录） */
  targetPath: string
  workloadIds?: string[]
}

export interface StartCloudHostProvisioningInput {
  name: string
  harnessTypes: HarnessType[]
  workloadIds?: string[]
  project: CloudHostProjectSelection
}

export interface CloudHostProvisioningState {
  /** 编排中的云电脑（进度对话框据此轮询启动状态） */
  hostId: string | null
  /** 服务端 setup operation，云电脑 RUNNING 后才创建 */
  operationId: string | null
  submitting: boolean
  error: string | null
}

/**
 * 新建云电脑 + Git 项目准备的编排：
 * createCloudHost(createDefaultSession=false) → 等待 RUNNING（由进度对话框轮询）
 * → setupCloudHostGithubProject(createSession = harnessTypes.length === 1)。
 *
 * 启动阶段完全由 `GithubSetupProgressDialog` 的 `hostId` 轮询驱动，
 * 本 Hook 只负责两次请求与状态串联，便于单测断言请求顺序。
 */
export function useCloudHostProvisioning() {
  const [createCloudHost] = useMutation<CreateCloudHostMutation>(CREATE_CLOUD_HOST)
  const [setupGithubProject] = useMutation<SetupCloudHostGithubProjectMutation>(
    SETUP_CLOUD_HOST_GITHUB_PROJECT,
  )
  const [state, setState] = useState<CloudHostProvisioningState>({
    hostId: null,
    operationId: null,
    submitting: false,
    error: null,
  })

  const reset = useCallback(() => {
    setState({ hostId: null, operationId: null, submitting: false, error: null })
  }, [])

  /** 第一步：创建云电脑（不自动建默认会话） */
  const start = useCallback(
    async (input: StartCloudHostProvisioningInput): Promise<CloudHostData> => {
      setState({ hostId: null, operationId: null, submitting: true, error: null })
      const { data } = await createCloudHost({
        variables: {
          input: {
            name: input.name,
            harnessTypes: input.harnessTypes,
            ...(input.workloadIds && input.workloadIds.length > 0
              ? { workloadIds: input.workloadIds }
              : {}),
            createDefaultSession: false,
          },
        },
      })
      const created = data?.createCloudHost
      if (!created) throw new Error('创建云电脑失败，请稍后重试')
      setState({
        hostId: created.id,
        operationId: null,
        submitting: false,
        error: null,
      })
      return created
    },
    [createCloudHost],
  )

  /** 第三步：云电脑 RUNNING 后发起 Git 项目准备（工作负载 + clone + 会话） */
  const beginProjectSetup = useCallback(
    async (input: {
      controllerId: string
      harnessTypes: HarnessType[]
      project: CloudHostProjectSelection
    }): Promise<string | null> => {
      const { data } = await setupGithubProject({
        variables: {
          input: {
            controllerId: input.controllerId,
            accountId: input.project.accountId,
            repoFullName: input.project.repoFullName,
            targetPath: input.project.targetPath,
            ...(input.project.workloadIds && input.project.workloadIds.length > 0
              ? { workloadIds: input.project.workloadIds }
              : {}),
            // 单 Harness 自动建项目会话；多 Harness 记 SKIPPED
            createSession: input.harnessTypes.length === 1,
          },
        },
      })
      const operation = data?.setupCloudHostGithubProject
      const operationId = operation?.id ?? null
      setState((prev) => ({ ...prev, operationId }))
      return operationId
    },
    [setupGithubProject],
  )

  return {
    ...state,
    start,
    beginProjectSetup,
    reset,
  }
}

export default useCloudHostProvisioning
