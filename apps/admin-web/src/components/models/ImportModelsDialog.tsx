import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { LIST_GLOBAL_PROVIDER_MODELS, ADMIN_MODELS, ADMIN_PROVIDERS } from '@/graphql/queries'
import { IMPORT_GLOBAL_MODELS } from '@/graphql/mutations'
import type { ImportGlobalModelsMutation, ListGlobalProviderModelsQuery } from '@/graphql/types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { QueryError } from '@/components/ui/query-error'

interface ImportModelsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  providerId: string | null
  providerName: string
}

/**
 * 「导入模型」弹窗：拉取上游清单 → 勾选 → 手动导入。
 * - 已导入（该供应商已存在）与已存在（其他供应商占用）条目禁选；
 * - 全选只作用于当前过滤结果中的可勾选项；
 * - 导入成功后本地合并已导入名（即时禁选）并重新查询。
 */
export default function ImportModelsDialog({
  open,
  onOpenChange,
  providerId,
  providerName,
}: ImportModelsDialogProps) {
  const { data, loading, error, refetch } = useQuery<ListGlobalProviderModelsQuery>(
    LIST_GLOBAL_PROVIDER_MODELS,
    {
      variables: { providerId },
      skip: !open || !providerId,
      fetchPolicy: 'network-only',
    },
  )
  const [importModels, { loading: importing }] = useMutation<ImportGlobalModelsMutation>(IMPORT_GLOBAL_MODELS)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [keyword, setKeyword] = useState('')
  const [importedNames, setImportedNames] = useState<Set<string>>(new Set())
  const [result, setResult] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setSelected(new Set())
      setKeyword('')
      setImportedNames(new Set())
      setResult(null)
    }
  }, [open, providerId])

  const options = useMemo(() => {
    const list = data?.listGlobalProviderModels ?? []
    return list.map((option) => ({
      ...option,
      isImported: option.isImported || importedNames.has(option.name),
    }))
  }, [data, importedNames])

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase()
    if (!needle) return options
    return options.filter((option) => option.name.toLowerCase().includes(needle))
  }, [options, keyword])

  const selectable = filtered.filter((option) => !option.isImported && !option.isDuplicate)
  const allSelected = selectable.length > 0 && selectable.every((option) => selected.has(option.name))

  const toggleOne = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
      }
      return next
    })
  }

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allSelected) {
        selectable.forEach((option) => next.delete(option.name))
      } else {
        selectable.forEach((option) => next.add(option.name))
      }
      return next
    })
  }

  const handleImport = async () => {
    if (!providerId || selected.size === 0) return
    try {
      const { data: mutationData } = await importModels({
        variables: { providerId, names: [...selected] },
        refetchQueries: [ADMIN_MODELS, ADMIN_PROVIDERS],
      })
      const created = mutationData?.importGlobalModels?.length ?? 0
      setImportedNames((prev) => new Set([...prev, ...selected]))
      setSelected(new Set())
      setResult(`成功导入 ${created} 个模型`)
      toast.success(`成功导入 ${created} 个模型`)
      await refetch()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导入失败，请重试')
      // 并发导入可能仅部分落库（唯一索引兜底），刷新一次以展示已成功导入的条目
      try {
        await refetch()
      } catch {
        // 刷新失败不覆盖原始导入错误提示
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>导入模型</DialogTitle>
          <DialogDescription>从「{providerName}」拉取上游模型清单并勾选导入</DialogDescription>
        </DialogHeader>

        {loading && !data ? (
          <div className="text-sm text-muted-foreground">加载中...</div>
        ) : error && !data ? (
          <QueryError message={error.message} onRetry={() => refetch()} />
        ) : options.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            暂无可导入的模型
          </div>
        ) : (
          <div className="space-y-3">
            <Input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="按模型名过滤"
              aria-label="过滤模型"
            />
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox
                  checked={allSelected}
                  disabled={selectable.length === 0}
                  onCheckedChange={toggleAll}
                  aria-label="全选可导入模型"
                />
                全选（{selectable.length}）
              </label>
              <span className="text-xs text-muted-foreground">已选 {selected.size} 个</span>
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border p-2">
              {filtered.length === 0 ? (
                <p className="p-2 text-sm text-muted-foreground">没有匹配的模型</p>
              ) : (
                filtered.map((option) => {
                  const disabled = option.isImported || option.isDuplicate
                  return (
                    <label
                      key={option.name}
                      className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${
                        disabled ? 'opacity-60' : 'hover:bg-muted'
                      }`}
                    >
                      <Checkbox
                        checked={selected.has(option.name)}
                        disabled={disabled}
                        onCheckedChange={() => toggleOne(option.name)}
                        aria-label={`选择 ${option.name}`}
                      />
                      <span className="min-w-0 flex-1 truncate text-foreground">{option.name}</span>
                      {option.isImported && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          已导入
                        </span>
                      )}
                      {option.isDuplicate && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          已存在
                        </span>
                      )}
                    </label>
                  )
                })
              )}
            </div>
            {result && (
              <p role="status" className="text-sm text-foreground">
                {result}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button onClick={handleImport} disabled={selected.size === 0 || importing || !!error}>
            {importing ? '导入中...' : `导入${selected.size > 0 ? `（${selected.size}）` : ''}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
