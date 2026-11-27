import { useState } from 'react'
import { useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import {
  CREATE_CUSTOM_TOOL,
  DELETE_CUSTOM_TOOL,
  UPDATE_CUSTOM_TOOL,
  type CreateCustomToolInput,
  type CreateCustomToolMutation,
  type CustomToolData,
  type DeleteCustomToolMutation,
  type UpdateCustomToolMutation,
} from '@/graphql/custom-tool'
import { customToolErrorMessage, resolveExposedName } from '@/lib/custom-tool'
import { SETTINGS_OVERVIEW } from '@/graphql/queries'
import { useSettingsOverview } from '@/stores/settingsOverview'
import { formatDateTime } from '@/lib/format'
import { useWorkspaceAccess } from '@/stores/workspace'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import CustomToolDialog from './CustomToolDialog'

const TYPE_LABELS: Record<CustomToolData['type'], string> = {
  prompt: 'Prompt',
  http: 'HTTP',
}

/**
 * 设置页「自定义工具」区块（工作区级，contracts/custom-tool.graphql）。
 *
 * - 列表（名称/类型徽标/描述/更新时间）、空态、删除二次确认；
 * - `useWorkspaceAccess().readOnly` 收敛编辑入口（服务端为权威兜底）；
 * - 数据 `cache-and-network` + mutation `refetchQueries`，随工作区切换（apollo workspaceLink）。
 */
export default function CustomToolSection() {
  const { readOnly } = useWorkspaceAccess()
  const { data, loading, error } = useSettingsOverview()
  const [createCustomTool] = useMutation<CreateCustomToolMutation>(CREATE_CUSTOM_TOOL, {
    refetchQueries: [{ query: SETTINGS_OVERVIEW }],
  })
  const [updateCustomTool] = useMutation<UpdateCustomToolMutation>(UPDATE_CUSTOM_TOOL, {
    refetchQueries: [{ query: SETTINGS_OVERVIEW }],
  })
  const [deleteCustomTool] = useMutation<DeleteCustomToolMutation>(DELETE_CUSTOM_TOOL, {
    refetchQueries: [{ query: SETTINGS_OVERVIEW }],
  })

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<CustomToolData | null>(null)
  const [deleting, setDeleting] = useState<CustomToolData | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const tools = data?.customTools ?? []

  const openCreate = () => {
    setEditing(null)
    setDialogOpen(true)
  }

  const openEdit = (tool: CustomToolData) => {
    setEditing(tool)
    setDialogOpen(true)
  }

  const handleSubmit = async (input: CreateCustomToolInput) => {
    setSubmitting(true)
    try {
      if (editing) {
        await updateCustomTool({ variables: { id: editing.id, input } })
        toast.success('自定义工具已更新')
      } else {
        await createCustomTool({ variables: { input } })
        toast.success('自定义工具已创建')
      }
      setDialogOpen(false)
      setEditing(null)
    } catch (err) {
      toast.error(customToolErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!deleting) return
    try {
      await deleteCustomTool({ variables: { id: deleting.id } })
      toast.success('自定义工具已删除')
      setDeleting(null)
    } catch (err) {
      toast.error(customToolErrorMessage(err))
    }
  }

  return (
    <section id="custom-tool-section" className="mb-8 min-w-0 md:mb-10">
      <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-2 md:mb-6">
        <h2 className="flex min-w-0 items-center gap-2 text-lg font-semibold text-foreground md:text-xl">
          自定义工具
          <Badge variant="secondary">工作区</Badge>
        </h2>
        {!readOnly ? (
          <Button type="button" size="sm" onClick={openCreate}>
            <Plus className="mr-1 size-4" />
            新增自定义工具
          </Button>
        ) : null}
      </div>

      <Card>
        <CardContent className="min-w-0 space-y-3 p-4">
          {loading && tools.length === 0 ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : error ? (
            <p className="text-sm text-destructive">{customToolErrorMessage(error)}</p>
          ) : tools.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无自定义工具</p>
          ) : (
            <ul className="min-w-0 divide-y divide-border">
              {tools.map((tool) => (
                <li key={tool.id} className="flex min-w-0 items-start justify-between gap-3 py-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate font-medium text-foreground">{tool.name}</span>
                      <Badge variant="outline">{TYPE_LABELS[tool.type]}</Badge>
                      <span className="truncate text-xs text-muted-foreground">
                        MCP 名称：{resolveExposedName(tool)}
                      </span>
                    </div>
                    {tool.description ? (
                      <p className="truncate text-sm text-muted-foreground">{tool.description}</p>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      {tool.args.length} 个参数 · 更新于 {formatDateTime(tool.updatedAt)}
                    </p>
                  </div>
                  {!readOnly ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`编辑 ${tool.name}`}
                        onClick={() => openEdit(tool)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`删除 ${tool.name}`}
                        onClick={() => setDeleting(tool)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <CustomToolDialog
        open={dialogOpen}
        tool={editing}
        submitting={submitting}
        onClose={() => {
          setDialogOpen(false)
          setEditing(null)
        }}
        onSubmit={handleSubmit}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        title="删除自定义工具"
        description={`确定删除「${deleting?.name ?? ''}」吗？删除后当前工作区会话调用将立即失效。`}
        confirmLabel="删除"
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
        onConfirm={() => void handleDelete()}
      />
    </section>
  )
}
