import { useState, useCallback, useMemo } from 'react'
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
import type { GetAdminModelsQuery, GetAdminProvidersQuery } from '@/graphql/types'
import { Button } from '@/components/ui/button'
import ModelItem from './ModelItem'
import CustomModelDialog from './CustomModelDialog'

export default function ModelSection() {
  const { data, loading } = useQuery<GetAdminModelsQuery>(ADMIN_MODELS)
  const { data: providersData } = useQuery<GetAdminProvidersQuery>(ADMIN_PROVIDERS)
  const [toggleModel] = useMutation(TOGGLE_GLOBAL_MODEL)
  const [updateSortOrder] = useMutation(UPDATE_GLOBAL_MODEL_SORT_ORDER)
  const [createCustom] = useMutation(CREATE_GLOBAL_CUSTOM_MODEL)
  const [deleteCustomModel] = useMutation(DELETE_GLOBAL_CUSTOM_MODEL)

  const [customDialogOpen, setCustomDialogOpen] = useState(false)

  const models = useMemo(() => data?.adminModels ?? [], [data])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  )

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteCustomModel({
        variables: { id },
        refetchQueries: [ADMIN_MODELS],
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败，请重试')
    }
  }, [deleteCustomModel])

  const handleToggle = async (id: string) => {
    try {
      await toggleModel({
        variables: { id },
        refetchQueries: [ADMIN_MODELS],
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '切换失败，请重试')
    }
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = models.findIndex((m) => m.id === active.id)
    const newIndex = models.findIndex((m) => m.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return

    const reordered = [...models]
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
                  onDelete={handleDelete}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      <CustomModelDialog
        open={customDialogOpen}
        onOpenChange={setCustomDialogOpen}
        providers={enabledProviders}
        onSave={handleCustomSave}
      />
    </section>
  )
}
