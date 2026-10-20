import { useState, useCallback, useEffect, useRef } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
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
import type {
  AdminProviderData,
  BatchDeleteGlobalProvidersMutation,
  BatchDisableGlobalProvidersMutation,
  BatchEnableGlobalProvidersMutation,
  GetAdminProvidersQuery,
  ProviderInputData,
} from '@/graphql/types'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { QueryError } from '@/components/ui/query-error'
import ProviderItem from './ProviderItem'
import ProviderFormDialog from './ProviderFormDialog'
import BatchActionBar from './BatchActionBar'
import ImportModelsDialog from '@/components/models/ImportModelsDialog'

export default function ProviderSection() {
  const { data, loading, error, refetch } = useQuery<GetAdminProvidersQuery>(ADMIN_PROVIDERS)
  const [createProvider] = useMutation(CREATE_GLOBAL_PROVIDER)
  const [updateProvider] = useMutation(UPDATE_GLOBAL_PROVIDER)
  const [deleteProvider] = useMutation(DELETE_GLOBAL_PROVIDER)
  const [toggleProvider] = useMutation(TOGGLE_GLOBAL_PROVIDER)
  const [batchEnable] = useMutation<BatchEnableGlobalProvidersMutation>(
    BATCH_ENABLE_GLOBAL_PROVIDERS,
  )
  const [batchDisable] = useMutation<BatchDisableGlobalProvidersMutation>(
    BATCH_DISABLE_GLOBAL_PROVIDERS,
  )
  const [batchDelete] = useMutation<BatchDeleteGlobalProvidersMutation>(
    BATCH_DELETE_GLOBAL_PROVIDERS,
  )

  const [formOpen, setFormOpen] = useState(false)
  const [editingProvider, setEditingProvider] = useState<ProviderInputData | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [multiMode, setMultiMode] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<AdminProviderData | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  // 「导入模型」弹窗目标供应商
  const [importTarget, setImportTarget] = useState<AdminProviderData | null>(null)
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)
  // 单个 toggle 的在途集合：双击两次 toggle 会相互抵消，须忽略重复点击
  const pendingToggleRef = useRef<Set<string>>(new Set())
  const [pendingToggleIds, setPendingToggleIds] = useState<Set<string>>(new Set())

  const providers = data?.adminProviders ?? []

  // 初始加载失败走整页错误态；已有数据后的刷新失败不会替换内容，改用 toast 显式提示
  useEffect(() => {
    if (error && data) {
      toast.error(error.message || '数据刷新失败')
    }
  }, [error, data])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && multiMode && !batchBusy) {
        setSelectedIds(new Set())
        setMultiMode(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [multiMode, batchBusy])

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
      toast.success('供应商已添加，请通过「导入模型」手动导入模型')
    }
    setFormOpen(false)
    setEditingProvider(null)
    setEditingId(null)
  }

  const handleToggle = useCallback(
    async (id: string) => {
      // 同一供应商 toggle 在途时忽略重复点击，避免两次相反请求相互抵消
      if (pendingToggleRef.current.has(id)) return
      pendingToggleRef.current.add(id)
      setPendingToggleIds(new Set(pendingToggleRef.current))
      try {
        await toggleProvider({
          variables: { id },
          refetchQueries: [ADMIN_PROVIDERS, ADMIN_MODELS],
        })
        toast.success('供应商状态已更新')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '操作失败，请重试')
      } finally {
        pendingToggleRef.current.delete(id)
        setPendingToggleIds(new Set(pendingToggleRef.current))
      }
    },
    [toggleProvider],
  )

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    setDeleteBusy(true)
    try {
      await deleteProvider({
        variables: { id: deleteTarget.id },
        refetchQueries: [ADMIN_PROVIDERS, ADMIN_MODELS],
      })
      toast.success('供应商已删除')
      setDeleteTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败，请重试')
    } finally {
      setDeleteBusy(false)
    }
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

  const runBatch = async (
    action: (ids: string[]) => Promise<number | undefined>,
    label: string,
  ) => {
    if (batchBusy) return
    // 发送时以当前选中集合为准，避免使用渲染期闭包里的旧 ids
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return

    setBatchBusy(true)
    try {
      const successCount = await action(ids)
      if (typeof successCount !== 'number') {
        // successCount 缺失时不能假定全部成功，按结果未知处理
        toast.warning(`${label}完成：结果未确认，请刷新后核对`)
      } else if (successCount < ids.length) {
        toast.warning(`${label}完成：成功 ${successCount}/${ids.length} 个，其余已跳过`)
      } else {
        toast.success(`${label}成功：${successCount} 个`)
      }
      handleCancelMulti()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `${label}失败，请重试`)
    } finally {
      setBatchBusy(false)
    }
  }

  const handleBatchEnable = () =>
    runBatch(async (ids) => {
      const { data: result } = await batchEnable({
        variables: { ids },
        refetchQueries: [ADMIN_PROVIDERS, ADMIN_MODELS],
      })
      return result?.batchEnableGlobalProviders.successCount
    }, '批量启用')

  const handleBatchDisable = () =>
    runBatch(async (ids) => {
      const { data: result } = await batchDisable({
        variables: { ids },
        refetchQueries: [ADMIN_PROVIDERS, ADMIN_MODELS],
      })
      return result?.batchDisableGlobalProviders.successCount
    }, '批量禁用')

  const handleBatchDeleteConfirm = () => {
    setBatchConfirmOpen(false)
    void runBatch(async (ids) => {
      const { data: result } = await batchDelete({
        variables: { ids },
        refetchQueries: [ADMIN_PROVIDERS, ADMIN_MODELS],
      })
      return result?.batchDeleteGlobalProviders.successCount
    }, '批量删除')
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
          busy={batchBusy}
          onEnable={handleBatchEnable}
          onDisable={handleBatchDisable}
          onDelete={() => setBatchConfirmOpen(true)}
          onCancel={handleCancelMulti}
        />
      )}

      {loading && !data ? (
        <div className="text-sm text-muted-foreground">加载中...</div>
      ) : error && !data ? (
        <QueryError message={error.message} onRetry={() => refetch()} />
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
              onImport={(provider) => setImportTarget(provider)}
              onEdit={handleEdit}
              onToggle={handleToggle}
              onDelete={() => setDeleteTarget(provider)}
              togglePending={pendingToggleIds.has(provider.id)}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleteTarget(null)
        }}
        title="删除供应商"
        description={`确定要删除供应商「${deleteTarget?.name ?? ''}」吗？关联的模型也将被删除。`}
        loading={deleteBusy}
        onConfirm={handleDeleteConfirm}
      />

      <ConfirmDialog
        open={batchConfirmOpen}
        onOpenChange={setBatchConfirmOpen}
        title="批量删除供应商"
        description={`确定要删除选中的 ${selectedIds.size} 个供应商吗？关联的模型也将被删除。`}
        loading={batchBusy}
        onConfirm={handleBatchDeleteConfirm}
      />

      <ImportModelsDialog
        open={importTarget !== null}
        onOpenChange={(open) => {
          if (!open) setImportTarget(null)
        }}
        providerId={importTarget?.id ?? null}
        providerName={importTarget?.name ?? ''}
      />

      <ProviderFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        onSave={handleSave}
        initialData={editingProvider}
      />
    </section>
  )
}
