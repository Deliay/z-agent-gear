import { gql } from '@apollo/client'

/**
 * Harness 平台配置（压缩指令）。
 *
 * 契约见 `contracts/admin-harness.graphql`：`harnessconfigs` 由 admin-api 唯一写方维护，
 * 三种 Harness 固定存在，未配置行由服务端以默认 `/compact` 归一返回。
 */
export type HarnessType = 'OPENCODE' | 'KIMI_CODE' | 'DEEPSEEK_HARNESS'

/** 与 `HARNESS_TYPES`（admin-api / agent-api）同值同序，单一事实源在前端仅作展示顺序。 */
export const HARNESS_TYPES: HarnessType[] = ['OPENCODE', 'KIMI_CODE', 'DEEPSEEK_HARNESS']

export const DEFAULT_COMPACT_COMMAND = '/compact'

export interface HarnessConfigData {
  harnessType: HarnessType
  compactCommand: string
  updatedAt: string
}

export interface AdminHarnessConfigsData {
  adminHarnessConfigs: HarnessConfigData[]
}

export interface UpsertHarnessConfigData {
  upsertHarnessConfig: HarnessConfigData
}

export interface UpsertHarnessConfigVariables {
  harnessType: HarnessType
  compactCommand: string
}

export const ADMIN_HARNESS_CONFIGS = gql`
  query AdminHarnessConfigs {
    adminHarnessConfigs {
      harnessType
      compactCommand
      updatedAt
    }
  }
`

export const UPSERT_HARNESS_CONFIG = gql`
  mutation UpsertHarnessConfig($harnessType: HarnessType!, $compactCommand: String!) {
    upsertHarnessConfig(harnessType: $harnessType, compactCommand: $compactCommand) {
      harnessType
      compactCommand
      updatedAt
    }
  }
`
