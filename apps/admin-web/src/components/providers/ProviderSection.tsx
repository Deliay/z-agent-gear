import { useState, useCallback, useEffect } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { ADMIN_PROVIDERS, ADMIN_MODELS } from '@/graphql/queries'
import {
  CREATE_GLOBAL_PROVIDER,
  UPDATE_GLOBAL_PROVIDER,
  DELETE_GLOBAL_PROVIDER,
  TOGGLE_GLOBAL_PROVIDER,
  BATCH_ENABLE_GLOBAL_PROVIDERS,
  BATCH_DISABLE_GLOBAL_PROVIDERS,
  BATCH_DELETE_GLOBAL_PROVIDERS,
} from '@/graphql/mutations'
import type { GetAdminProvidersQuery, ProviderInputData } from '@/graphql/types'
import { Button } from '@/components/ui/button'
import ProviderItem from './ProviderItem'
import ProviderFormDialog from './ProviderFormDialog'
import BatchActionBar from './BatchActionBar'

export default function ProviderSection() {
  const { data, loading } = useQuery<GetAdminProvidersQuery>(ADMIN_PROVIDERS)
  const [createProvider] = useMutation(CREATE_GLOBAL_PROVIDER)
  const [updateProvider] = useMutation(UPDATE_GLOBAL_PROVIDER)
  const [deleteProvider] = useMutation(DELETE_GLOBAL_PROVIDER)
  const [toggleProvider] = useMutation(TOGGLE_GLOBAL_PROVIDER)
  const [batchEnable] = useMutation(BATCH_ENABLE_GLOBAL_PROVIDERS)
  const [batchDisable] = useMutation(BATCH_DISABLE_GLOBAL_PROVIDERS)
  const [batchDelete] = useMutation(BATCH_DELETE_GLOBAL_PROVIDERS)

  const [formOpen, setFormOpen] = useState(false)
  const [editingProvider, setEditingProvider] = useState<ProviderInputData | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [multiMode, setMultiMode] = useState(false)

  const providers = data?.adminProviders ?? []

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && multiMode) {
        setSelectedIds(new Set())
        setMultiMode(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [multiMode])

  const handleAdd = () => {
    setEditingProvider(null)
    setEditingId(null)
    setFormOpen(true)
  }

  const handleEdit = useCallback((provider: ProviderInputData & { id: string }) => {
    setEditingId(provider.id)
    setEditingProvider({
      name: provider.name,
      type: provider.type,
      endpoint: provider.endpoint,
      credentialType: provider.credentialType,
      credentialValue: '',
    })
    setFormOpen(true)
  }, [])

  const handleSave = async (input: ProviderInputData) => {
    if (editingId) {
      await updateProvider({
        variables: { id: editingId, input },
        refetchQueries: [ADMIN_PROVIDERS, ADMIN_MODELS],
      })
    } else {
      await createProvider({
        variables: { input },
        refetchQueries: [ADMIN_PROVIDERS, ADMIN_MODELS],
      })
    }
    setFormOpen(false)
    setEditingProvider(null)
    setEditingId(null)
  }

  const handleToggle = async (id: string) => {
    await toggleProvider({
      variables: { id },
      refetchQueries: [ADMIN_PROVIDERS, ADMIN_MODELS],
    })
  }

  const handleDelete = async (id: string) => {
    await deleteProvider({
      variables: { id },
      refetchQueries: [ADMIN_PROVIDERS, ADMIN_MODELS],
    })
  }

  const handleSelect = (id: string) => {
    setMultiMode(true)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      if (next.size === 0) {
        setMultiMode(false)
      }
      return next
    })
  }

  const handleCancelMulti = () => {
    setSelectedIds(new Set())
    setMultiMode(false)
  }

  const handleBatchEnable = async () => {
    await batchEnable({
      variables: { ids: Array.from(selectedIds) },
      refetchQueries: [ADMIN_PROVIDERS, ADMIN_MODELS],
    })
    handleCancelMulti()
  }

  const handleBatchDisable = async () => {
    await batchDisable({
      variables: { ids: Array.from(selectedIds) },
      refetchQueries: [ADMIN_PROVIDERS, ADMIN_MODELS],
    })
    handleCancelMulti()
  }

  const handleBatchDelete = async () => {
    await batchDelete({
      variables: { ids: Array.from(selectedIds) },
      refetchQueries: [ADMIN_PROVIDERS, ADMIN_MODELS],
    })
    handleCancelMulti()
  }

  const handleDeleteWithConfirm = (id: string) => {
    if (window.confirm('确定要删除此供应商吗？关联的模型也将被删除。')) {
      handleDelete(id)
    }
  }

  const handleBatchDeleteWithConfirm = () => {
    if (window.confirm(`确定要删除选中的 ${selectedIds.size} 个供应商吗？关联的模型也将被删除。`)) {
      handleBatchDelete()
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium text-foreground">供应商设置</h3>
        <Button size="sm" onClick={handleAdd}>
          添加供应商
        </Button>
      </div>

      {multiMode && selectedIds.size > 0 && (
        <BatchActionBar
          selectedCount={selectedIds.size}
          onEnable={handleBatchEnable}
          onDisable={handleBatchDisable}
          onDelete={handleBatchDeleteWithConfirm}
          onCancel={handleCancelMulti}
        />
      )}

      {loading && !data ? (
        <div className="text-sm text-muted-foreground">加载中...</div>
      ) : providers.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          暂无供应商，点击「添加供应商」开始配置
        </div>
      ) : (
        <div className="space-y-2">
          {providers.map((provider) => (
            <ProviderItem
              key={provider.id}
              provider={provider}
              selected={selectedIds.has(provider.id)}
              onSelect={handleSelect}
              onEdit={handleEdit}
              onToggle={handleToggle}
              onDelete={handleDeleteWithConfirm}
            />
          ))}
        </div>
      )}

      <ProviderFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        onSave={handleSave}
        initialData={editingProvider}
      />
    </section>
  )
}
