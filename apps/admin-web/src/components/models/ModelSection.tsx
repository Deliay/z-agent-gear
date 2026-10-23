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
import { ADMIN_MODELS, ADMIN_PROVIDERS } from '@/graphql/queries'
import {
  TOGGLE_GLOBAL_MODEL,
  UPDATE_GLOBAL_MODEL_SORT_ORDER,
  CREATE_GLOBAL_CUSTOM_MODEL,
  DELETE_GLOBAL_MODEL,
  UPDATE_MODEL_CONTEXT_LENGTH,
} from '@/graphql/mutations'
import type {
  AdminModelData,
  GetAdminModelsQuery,
  GetAdminProvidersQuery,
} from '@/graphql/types'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { QueryError } from '@/components/ui/query-error'
import ModelGroup from './ModelGroup'
import ModelItem from './ModelItem'
import CustomModelDialog from './CustomModelDialog'

interface ModelGroupData {
  key: string
  title: string
  models: AdminModelData[]
}

export default function ModelSection() {
  const { data, loading, error, refetch } = useQuery<GetAdminModelsQuery>(ADMIN_MODELS)
  const { data: providersData, error: providersError } = useQuery<GetAdminProvidersQuery>(ADMIN_PROVIDERS)
  const [toggleModel] = useMutation(TOGGLE_GLOBAL_MODEL)
  const [updateSortOrder] = useMutation(UPDATE_GLOBAL_MODEL_SORT_ORDER)
  const [createCustom] = useMutation(CREATE_GLOBAL_CUSTOM_MODEL)
  const [updateContextLength] = useMutation(UPDATE_MODEL_CONTEXT_LENGTH)
  const [deleteModel] = useMutation(DELETE_GLOBAL_MODEL)

  const [customDialogOpen, setCustomDialogOpen] = useState(false)
  const [editingModel, setEditingModel] = useState<AdminModelData | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AdminModelData | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  // 默认全部折叠；状态保存在页面内存，refetch 不重置
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  // 单个 toggle 的在途集合：双击两次 toggle 会相互抵消，须忽略重复点击
  const pendingToggleRef = useRef<Set<string>>(new Set())
  const [pendingToggleIds, setPendingToggleIds] = useState<Set<string>>(new Set())

  const models = useMemo(() => data?.adminModels ?? [], [data])

  // 分组：按 adminModels 排序结果中供应商首次出现顺序；provider 为 null 归入「未知供应商」
  const groups = useMemo<ModelGroupData[]>(() => {
    const order: string[] = []
    const map = new Map<string, ModelGroupData>()
    for (const model of models) {
      const key = model.provider ? model.providerId : 'unknown'
      if (!map.has(key)) {
        map.set(key, { key, title: model.provider?.name ?? '未知供应商', models: [] })
        order.push(key)
      }
      map.get(key)!.models.push(model)
    }
    return order.map((key) => map.get(key)!)
  }, [models])

  // 初始加载失败走整页错误态；已有数据后的刷新失败不会替换内容，改用 toast 显式提示
  useEffect(() => {
    if (error && data) {
      toast.error(error.message || '数据刷新失败')
    }
  }, [error, data])

  // 供应商列表仅用于自定义模型对话框，失败不影响模型列表，但要显式暴露
  useEffect(() => {
    if (providersError) {
      toast.error(providersError.message || '供应商列表加载失败')
    }
  }, [providersError])

  // 拖拽结束可能晚于一次 refetch 到达，用 ref 持有最新分组/全局顺序，避免发全量 ids 时用到旧闭包数据
  const groupsRef = useRef(groups)
  const modelsRef = useRef(models)
  useEffect(() => {
    groupsRef.current = groups
    modelsRef.current = models
  }, [groups, models])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  )

  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  const handleToggle = useCallback(
    async (id: string) => {
      // 同一模型 toggle 在途时忽略重复点击，避免两次相反请求相互抵消
      if (pendingToggleRef.current.has(id)) return
      pendingToggleRef.current.add(id)
      setPendingToggleIds(new Set(pendingToggleRef.current))
      try {
        await toggleModel({
          variables: { id },
          refetchQueries: [ADMIN_MODELS],
        })
        toast.success('模型状态已更新')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '切换失败，请重试')
      } finally {
        pendingToggleRef.current.delete(id)
        setPendingToggleIds(new Set(pendingToggleRef.current))
      }
    },
    [toggleModel],
  )

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return
    setDeleteBusy(true)
    try {
      await deleteModel({
        variables: { id: deleteTarget.id },
        refetchQueries: [ADMIN_MODELS, ADMIN_PROVIDERS],
      })
      toast.success('模型已删除')
      setDeleteTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败，请重试')
    } finally {
      setDeleteBusy(false)
    }
  }, [deleteModel, deleteTarget])

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    // 以发送时刻的最新分组计算顺序（而非渲染期闭包）
    const currentGroups = groupsRef.current
    const group = currentGroups.find((g) => g.models.some((m) => m.id === active.id))
    const overGroup = currentGroups.find((g) => g.models.some((m) => m.id === over.id))
    // 跨组拖拽直接忽略（不移动、不报错）
    if (!group || group.key !== overGroup?.key) return

    const ids = group.models.map((m) => m.id)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from === -1 || to === -1) return

    const reordered = [...ids]
    const [removed] = reordered.splice(from, 1)
    reordered.splice(to, 0, removed)

    // 全量 id：只替换被拖拽组在全局顺序中的原位置，保留其他组模型的全局相对顺序（C-1）。
    // 不能按「分组展示顺序」拼接，否则会连带改写未操作组的相对顺序。
    const groupIds = new Set(ids)
    let cursor = 0
    const fullIds = modelsRef.current.map((m) => (groupIds.has(m.id) ? reordered[cursor++] : m.id))
    try {
      await updateSortOrder({
        variables: { ids: fullIds },
        refetchQueries: [ADMIN_MODELS],
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '排序保存失败，请重试')
    }
  }

  const handleCustomSave = async (providerId: string, name: string, contextLength: number | null) => {
    await createCustom({
      variables: { input: { providerId, name, contextLength } },
      refetchQueries: [ADMIN_MODELS, ADMIN_PROVIDERS],
    })
  }

  const handleEditSave = async (
    _providerId: string,
    _name: string,
    contextLength: number | null,
  ) => {
    if (!editingModel) return
    try {
      await updateContextLength({
        variables: { modelId: editingModel.id, contextLength },
        refetchQueries: [ADMIN_MODELS],
      })
      toast.success('模型最长上下文已更新')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败，请重试')
      throw err
    }
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
          暂无可用模型，通过供应商的「导入模型」手动导入
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <div className="space-y-2">
            {groups.map((group) => {
              const expanded = expandedGroups.has(group.key)
              return (
                <ModelGroup
                  key={group.key}
                  title={group.title}
                  count={group.models.length}
                  expanded={expanded}
                  onToggle={() => toggleGroup(group.key)}
                  itemIds={group.models.map((m) => m.id)}
                >
                  <div className="space-y-2">
                    {group.models.map((model) => (
                      <ModelItem
                        key={model.id}
                        model={model}
                        onToggle={handleToggle}
                        togglePending={pendingToggleIds.has(model.id)}
                        onDelete={(id) => {
                          const target = models.find((m) => m.id === id)
                          if (target) setDeleteTarget(target)
                        }}
                        onEdit={(model) => setEditingModel(model)}
                      />
                    ))}
                  </div>
                </ModelGroup>
              )
            })}
          </div>
        </DndContext>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleteTarget(null)
        }}
        title="删除模型"
        description={`确定要删除模型「${deleteTarget?.name ?? ''}」吗？删除后前台不再展示，按该模型名调用将返回「模型不存在」。`}
        loading={deleteBusy}
        onConfirm={handleDeleteConfirm}
      />

      <CustomModelDialog
        open={customDialogOpen}
        onOpenChange={setCustomDialogOpen}
        providers={enabledProviders}
        existingNames={models.map((m) => m.name)}
        onSave={handleCustomSave}
      />

      <CustomModelDialog
        open={editingModel !== null}
        onOpenChange={(open) => {
          if (!open) setEditingModel(null)
        }}
        providers={enabledProviders}
        model={editingModel}
        onSave={handleEditSave}
      />
    </section>
  )
}
