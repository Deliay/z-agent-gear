import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { GET_MCP_SERVERS, GET_CONTROLLERS } from '@/graphql/queries'
import { SET_CONTROLLER_DEFAULT_MCP } from '@/graphql/mutations'
import type { ControllerData, SetControllerDefaultMcpMutation } from '@/graphql/types'
import { HOME_OVERVIEW } from '@/graphql/home'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

interface McpServerItem {
  id: string
  name: string
  source: string
  enabled: boolean
  status: string
}

interface GetMcpServersData {
  mcpServers: McpServerItem[]
}

const SOURCE_LABELS: Record<string, string> = {
  proxy: '代理注册',
  manual: '远程绑定',
  platform: '平台内置',
}

function parseError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('MCP_SERVER_NOT_SELECTABLE')) return '平台云工具服务由系统自动注入，不可手动选择'
  if (message.includes('MCP_SERVER_NOT_FOUND')) return '所选 MCP 已停用或不存在，请重新选择'
  if (message.includes('Controller not found')) return '控制器不存在或已删除'
  return message || '保存失败，请稍后重试'
}

interface McpDefaultSectionProps {
  controller: ControllerData
}

/**
 * 控制器默认 MCP：新建会话（含 Git 项目自动建会话）默认注入的 MCP 集合。
 * `useAllEnabled` 打开时新 MCP 上线后自动注入；关闭时按勾选列表注入（空 = 不注入）。
 */
export default function McpDefaultSection({ controller }: McpDefaultSectionProps) {
  const { data: mcpData, loading: mcpLoading } = useQuery<GetMcpServersData>(GET_MCP_SERVERS, {
    fetchPolicy: 'cache-and-network',
  })
  const [saveDefaultMcp, { loading: saving }] = useMutation<SetControllerDefaultMcpMutation>(
    SET_CONTROLLER_DEFAULT_MCP,
    {
      refetchQueries: [{ query: GET_CONTROLLERS }, { query: HOME_OVERVIEW }],
    },
  )

  const defaultMcp = controller.defaultMcp ?? null
  const [useAllEnabled, setUseAllEnabled] = useState(defaultMcp?.useAllEnabled !== false)
  const [serverIds, setServerIds] = useState<string[]>(defaultMcp?.serverIds ?? [])
  const [error, setError] = useState<string | null>(null)
  // C-18：用户已编辑但未保存时，后台轮询/父级刷新不得覆盖表单
  const dirtyRef = useRef(false)
  const prevControllerIdRef = useRef(controller.id)

  // 控制器数据刷新后同步服务端权威值（保存成功由 mutation 结果/refetch 驱动）
  const serverIdsKey = (defaultMcp?.serverIds ?? []).join(',')
  useEffect(() => {
    // 切换控制器必须强制重置，不能把上一台的脏值/错误带过去
    if (prevControllerIdRef.current !== controller.id) {
      prevControllerIdRef.current = controller.id
      dirtyRef.current = false
    }
    if (dirtyRef.current) return
    setUseAllEnabled(defaultMcp?.useAllEnabled !== false)
    setServerIds(defaultMcp?.serverIds ?? [])
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.id, defaultMcp?.useAllEnabled, serverIdsKey])

  const servers = useMemo(
    // 云会话由服务端自动并入 agent-cloud-host-tools，不作为可配置项
    () => (mcpData?.mcpServers ?? []).filter((server) => server.name !== 'agent-cloud-host-tools'),
    [mcpData],
  )
  const enabledServers = servers.filter((server) => server.enabled)
  const effectiveSelection = useAllEnabled ? enabledServers.map((s) => s.id) : serverIds
  const staleIds = serverIds.filter((id) => !servers.some((s) => s.id === id))

  const toggleServer = (serverId: string, checked: boolean) => {
    dirtyRef.current = true
    setServerIds((prev) =>
      checked ? [...prev.filter((id) => id !== serverId), serverId] : prev.filter((id) => id !== serverId),
    )
  }

  const handleSave = async () => {
    setError(null)
    try {
      const result = await saveDefaultMcp({
        variables: {
          controllerId: controller.id,
          useAllEnabled,
          serverIds: useAllEnabled ? [] : serverIds,
        },
      })
      // N-2：保存成功后解除 dirty，并立即回写服务端权威值（不能永久短路同步 effect）
      dirtyRef.current = false
      const saved = result?.data?.setControllerDefaultMcp?.defaultMcp
      if (saved) {
        setUseAllEnabled(saved.useAllEnabled !== false)
        setServerIds(saved.serverIds ?? [])
      }
      setError(null)
      toast.success('已保存，对后续新建会话生效')
    } catch (err) {
      setError(parseError(err))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>默认 MCP</CardTitle>
        <CardDescription>
          新建会话时默认注入的 MCP 服务；会话内仍可单独调整。Git 项目自动创建的会话同样生效。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            aria-label="默认注入全部 MCP"
            checked={useAllEnabled}
            onChange={(event) => {
              dirtyRef.current = true
              setUseAllEnabled(event.target.checked)
            }}
            className="mt-0.5 h-4 w-4 shrink-0"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">默认注入全部已启用的 MCP</span>
            <span className="block text-xs text-muted-foreground">
              新 MCP 上线后自动注入，无需再次保存
            </span>
          </span>
        </label>

        {useAllEnabled ? (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            {enabledServers.length === 0
              ? '暂无已启用的 MCP 服务'
              : `已启用 ${enabledServers.length} 个 MCP 服务，全部自动注入`}
          </div>
        ) : mcpLoading && !mcpData ? (
          <p className="text-sm text-muted-foreground">正在加载 MCP 服务...</p>
        ) : servers.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无 MCP 服务</p>
        ) : (
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border p-3">
            {servers.map((server) => {
              const checked = effectiveSelection.includes(server.id)
              return (
                <label
                  key={server.id}
                  className={`flex min-w-0 items-center gap-2 ${server.enabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
                >
                  <input
                    type="checkbox"
                    aria-label={server.name}
                    checked={checked}
                    disabled={!server.enabled}
                    onChange={(event) => toggleServer(server.id, event.target.checked)}
                    className="h-4 w-4 shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {server.name}
                  </span>
                  <Badge variant="outline" className="shrink-0">
                    {SOURCE_LABELS[server.source] ?? server.source}
                  </Badge>
                  {!server.enabled && (
                    <span className="shrink-0 text-xs text-muted-foreground">已停用</span>
                  )}
                </label>
              )
            })}
          </div>
        )}

        {!useAllEnabled && staleIds.length > 0 && (
          <p className="text-xs text-warning">已选择的 MCP 中有已删除条目，请重新选择</p>
        )}
        {!useAllEnabled && serverIds.length === 0 && (
          <p className="text-xs text-muted-foreground">未选择任何 MCP：新建会话不注入 MCP</p>
        )}
        {error && (
          <p role="alert" className="break-words text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex justify-end">
          <Button type="button" onClick={() => { void handleSave() }} disabled={saving}>
            {saving ? '保存中...' : '保存默认 MCP'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
