import { createContext, useContext } from 'react'
import type { SettingsOverviewData } from '../graphql/types'

/**
 * 设置页聚合数据上下文：由 `SettingsPage` 挂载唯一一次 `SETTINGS_OVERVIEW` 查询后注入，
 * 各设置区块消费同一份数据（不再各自发起只读查询、不做独立轮询）。
 */
export interface SettingsOverviewContextValue {
  data: SettingsOverviewData | null
  loading: boolean
  error: Error | undefined
  refetch: () => void
}

export const SettingsOverviewContext = createContext<SettingsOverviewContextValue>({
  data: null,
  loading: false,
  error: undefined,
  refetch: () => {},
})

export function useSettingsOverview(): SettingsOverviewContextValue {
  return useContext(SettingsOverviewContext)
}
