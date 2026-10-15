import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { ADMIN_MODELS, ADMIN_PROVIDERS } from '@/graphql/queries'
import {
  TOGGLE_GLOBAL_MODEL,
  UPDATE_GLOBAL_MODEL_SORT_ORDER,
  CREATE_GLOBAL_CUSTOM_MODEL,
  DELETE_GLOBAL_CUSTOM_MODEL,
} from '@/graphql/mutations'
import type {
  AdminModelData,
  GetAdminModelsQuery,
  GetAdminProvidersQuery,
} from '@/graphql/types'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { QueryError } from '@/components/ui/query-error'
import ModelItem from './ModelItem'
import CustomModelDialog from './CustomModelDialog'

export default function ModelSection() {
  const { data, loading, error, refetch } = useQuery<GetAdminModelsQuery>(ADMIN_MODELS)
  const { data: providersData } = useQuery<GetAdminProvidersQuery>(ADMIN_PROVIDERS)
  const [toggleModel] = useMutation(TOGGLE_GLOBAL_MODEL)
  const [updateSortOrder] = useMutation(UPDATE_GLOBAL_MODEL_SORT_ORDER)
  const [createCustom] = useMutation(CREATE_GLOBAL_CUSTOM_MODEL)
  const [deleteCustomModel] = useMutation(DELETE_GLOBAL_CUSTOM_MODEL)

  const [customDialogOpen, setCustomDialogOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<AdminModelData | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const models = useMemo(() => data?.adminModels ?? [], [data])

  // 拖拽结束可能晚于一次 refetch 到达，用 ref 持有最新列表，避免发全量 ids 时用到旧闭包数据
  const modelsRef = useRef(models)
  useEffect(() => {
    modelsRef.current = models
  }, [models])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  )

  const handleToggle = async (id: string) => {
    try {
      await toggleModel({
        variables: { id },
        refetchQueries: [ADMIN_MODELS],
      })
      toast.success('模型状态已更新')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '切换失败，请重试')
    }
  }

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return
    setDeleteBusy(true)
    try {
      await deleteCustomModel({
        variables: { id: deleteTarget.id },
        refetchQueries: [ADMIN_MODELS],
      })
      toast.success('自定义模型已删除')
      setDeleteTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败，请重试')
    } finally {
      setDeleteBusy(false)
    }
  }, [deleteCustomModel, deleteTarget])

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    // 以发送时刻的最新列表计算顺序（而非渲染期闭包）
    const current = modelsRef.current
    const oldIndex = current.findIndex((m) => m.id === active.id)
    const newIndex = current.findIndex((m) => m.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return

    const reordered = [...current]
    const [removed] = reordered.splice(oldIndex, 1)
    reordered.splice(newIndex, 0, removed)

    const ids = reordered.map((m) => m.id)
    try {
      await updateSortOrder({
        variables: { ids },
        refetchQueries: [ADMIN_MODELS],
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '排序保存失败，请重试')
    }
  }

  const handleCustomSave = async (providerId: string, name: string) => {
    await createCustom({
      variables: { input: { providerId, name } },
      refetchQueries: [ADMIN_MODELS],
    })
  }

  const enabledProviders = (providersData?.adminProviders ?? [])
    .filter((p) => p.isEnabled)
    .map((p) => ({ id: p.id, name: p.name }))

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium text-foreground">可用模型</h3>
        <Button size="sm" variant="outline" onClick={() => setCustomDialogOpen(true)}>
          自定义模型
        </Button>
      </div>

      {loading && !data ? (
        <div className="text-sm text-muted-foreground">加载中...</div>
      ) : error && !data ? (
        <QueryError message={error.message} onRetry={() => refetch()} />
      ) : models.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          暂无可用模型，添加供应商后自动拉取
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={models.map((m) => m.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-2">
              {models.map((model) => (
                <ModelItem
                  key={model.id}
                  model={model}
                  onToggle={handleToggle}
                  onDelete={(id) => {
                    const target = models.find((m) => m.id === id)
                    if (target) setDeleteTarget(target)
                  }}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleteTarget(null)
        }}
        title="删除自定义模型"
        description={`确定要删除自定义模型「${deleteTarget?.name ?? ''}」吗？`}
        loading={deleteBusy}
        onConfirm={handleDeleteConfirm}
      />

      <CustomModelDialog
        open={customDialogOpen}
        onOpenChange={setCustomDialogOpen}
        providers={enabledProviders}
        onSave={handleCustomSave}
      />
    </section>
  )
}
