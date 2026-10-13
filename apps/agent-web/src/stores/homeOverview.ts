import { createContext, useContext } from 'react'
import type { HomeOverviewData } from '../graphql/types'

/**
 * 首页聚合数据上下文：由 `MainLayout` 挂载唯一一次 `HOME_OVERVIEW` 查询后注入，
 * `HomePage` / `Sidebar` 及其子组件消费同一份数据，不再各自发起查询。
 */
export interface HomeOverviewContextValue {
  data: HomeOverviewData | null
  loading: boolean
  error: Error | undefined
  refetch: () => void
}

export const HomeOverviewContext = createContext<HomeOverviewContextValue>({
  data: null,
  loading: false,
  error: undefined,
  refetch: () => {},
})

export function useHomeOverview(): HomeOverviewContextValue {
  return useContext(HomeOverviewContext)
}
