import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  GET_MODELS,
  GET_PROVIDERS,
} from '@/graphql/queries'
import {
  TOGGLE_MODEL,
  UPDATE_MODEL_SORT_ORDER,
  CREATE_CUSTOM_MODEL,
  DELETE_CUSTOM_MODEL,
} from '@/graphql/mutations'
import type { GetModelsQuery, GetProvidersQuery } from '@/graphql/types'
import { Button } from '@/components/ui/button'
import ModelGroup from './ModelGroup'
import ModelItem from './ModelItem'
import CustomModelDialog from './CustomModelDialog'

interface ModelData {
  id: string
  /** global（系统内置）模型由服务端掩蔽为 null */
  providerId: string | null
  provider?: {
    id: string
    name: string
    type: string
    isEnabled: boolean
  }
  name: string
  isCustom: boolean
  isEnabled: boolean
  sortOrder: number
  scope: 'user' | 'global'
}

interface ModelGroupData {
  key: string
  title: string
  models: ModelData[]
  sortable: boolean
}

const SYSTEM_KEY = 'system'

export default function ModelSection() {
  const { data, loading } = useQuery<GetModelsQuery>(GET_MODELS)
  const { data: providersData } = useQuery<GetProvidersQuery>(GET_PROVIDERS)
  const [toggleModel] = useMutation(TOGGLE_MODEL)
  const [updateSortOrder] = useMutation(UPDATE_MODEL_SORT_ORDER)
  const [createCustom] = useMutation(CREATE_CUSTOM_MODEL)
  const [deleteCustomModel] = useMutation(DELETE_CUSTOM_MODEL)

  const [customDialogOpen, setCustomDialogOpen] = useState(false)
  // 默认全部折叠；refetch 不重置（仅内存，不持久化）
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  const models: ModelData[] = useMemo(() => data?.models ?? [], [data])

  // 系统内置固定 key=system、排首位；其余按 providerId 首次出现顺序分组
  const groups = useMemo<ModelGroupData[]>(() => {
    const systemModels = models.filter((model) => model.scope === 'global')
    const order: string[] = []
    const map = new Map<string, ModelGroupData>()
    for (const model of models) {
      if (model.scope === 'global') continue
      const key = model.provider ? (model.providerId ?? 'unknown') : 'unknown'
      if (!map.has(key)) {
        map.set(key, {
          key,
          title: model.provider?.name ?? '未知供应商',
          models: [],
          sortable: true,
        })
        order.push(key)
      }
      map.get(key)!.models.push(model)
    }
    return [
      ...(systemModels.length
        ? [{ key: SYSTEM_KEY, title: '系统内置', models: systemModels, sortable: false }]
        : []),
      ...order.map((key) => map.get(key)!),
    ]
  }, [models])

  const groupsRef = useRef(groups)
  useEffect(() => {
    groupsRef.current = groups
  }, [groups])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  )

  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const handleDelete = useCallback(async (id: string) => {
    await deleteCustomModel({
      variables: { id },
      refetchQueries: [GET_MODELS],
    })
  }, [deleteCustomModel])

  const handleToggle = async (id: string) => {
    await toggleModel({
      variables: { id },
      refetchQueries: [GET_MODELS],
    })
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const currentGroups = groupsRef.current
    const group = currentGroups.find((g) => g.models.some((m) => m.id === active.id))
    const overGroup = currentGroups.find((g) => g.models.some((m) => m.id === over.id))
    // 跨组 / 系统内置组拖拽一律忽略（只读且不参与排序）
    if (!group || !group.sortable || group.key !== overGroup?.key) return

    const ids = group.models.map((m) => m.id)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from === -1 || to === -1) return

    const reordered = [...ids]
    const [removed] = reordered.splice(from, 1)
    reordered.splice(to, 0, removed)

    // 只提交用户模型 id（按用户组展示顺序拼接，不含 global）
    const userIds = currentGroups
      .filter((g) => g.sortable)
      .flatMap((g) => (g.key === group.key ? reordered : g.models.map((m) => m.id)))

    await updateSortOrder({
      variables: { ids: userIds },
      refetchQueries: [GET_MODELS],
    })
  }

  const handleCustomSave = async (providerId: string, name: string) => {
    await createCustom({
      variables: { input: { providerId, name } },
      refetchQueries: [GET_MODELS],
    })
  }

  const enabledProviders = (providersData?.providers ?? [])
    .filter((p: { isEnabled: boolean }) => p.isEnabled)
    .map((p: { id: string; name: string }) => ({ id: p.id, name: p.name }))

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium text-foreground">可用模型</h3>
        <Button size="sm" variant="outline" onClick={() => setCustomDialogOpen(true)}>
          自定义模型
        </Button>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">加载中...</div>
      ) : models.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          暂无可用模型，添加供应商后自动同步模型
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <div className="space-y-2">
            {groups.map((group) => (
              <ModelGroup
                key={group.key}
                title={group.title}
                count={group.models.length}
                expanded={expandedGroups.has(group.key)}
                onToggle={() => toggleGroup(group.key)}
                sortableIds={group.sortable ? group.models.map((m) => m.id) : undefined}
              >
                <div className="space-y-2">
                  {group.models.map((model) => (
                    <ModelItem
                      key={model.id}
                      model={model}
                      onToggle={handleToggle}
                      onDelete={handleDelete}
                      sortable={group.sortable}
                      hideProviderName
                      readOnlyToggle={!group.sortable}
                    />
                  ))}
                </div>
              </ModelGroup>
            ))}
          </div>
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
