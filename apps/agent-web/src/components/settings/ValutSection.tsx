import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { GET_VALUT_ENTRIES } from '@/graphql/queries'
import {
  CREATE_VALUT_ENTRY,
  DELETE_VALUT_ENTRY,
  UPDATE_VALUT_ENTRY,
} from '@/graphql/mutations'
import type {
  CreateValutEntryMutation,
  DeleteValutEntryMutation,
  GetValutEntriesQuery,
  UpdateValutEntryMutation,
  ValutEntryData,
  ValutNamespaceGroupData,
} from '@/graphql/types'
import { formatDateTime } from '@/lib/format'
import { valutErrorMessage, validateValutKey, validateValutValue } from '@/lib/valut'
import { useWorkspaceAccess } from '@/stores/workspace'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface DialogState {
  open: boolean
  mode: 'create' | 'edit'
  entry: ValutEntryData | null
}

const CLOSED_DIALOG: DialogState = { open: false, mode: 'create', entry: null }

function findEntry(groups: ValutNamespaceGroupData[], id: string): ValutEntryData | null {
  for (const group of groups) {
    const hit = group.entries.find((entry) => entry.id === id)
    if (hit) return hit
  }
  return null
}

function renderRefs(entry: ValutEntryData) {
  if (entry.refs.length === 0) return null
  return (
    <ul className="mt-2 space-y-1 rounded-md bg-muted/40 p-2">
      {entry.refs.map((ref) => (
        <li key={`${ref.feature}-${ref.refId}`} className="min-w-0 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{ref.refLabel || ref.refId}</span>
          <span className="ml-2">{ref.feature}</span>
          <span className="ml-2">{formatDateTime(ref.createdAt)}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * 设置页「Valut」区块（工作区级加密密钥，contracts/valut.graphql）。
 *
 * - 按 namespace 聚合展示（组头 displayName），**任何状态不回显 value**（契约无 value 出参，D10）；
 * - 编辑 = 重填新值（key 只读、value 空待重填）；
 * - 只读（全局工作区 developer，`Workspace.readOnly`）隐藏新增/编辑/删除入口——服务端插件才是权威；
 * - `?section=valut&entry=<id>` 穿透定位：滚动到本区块并自动展开该条目编辑对话框（D11）。
 */
export default function ValutSection() {
  const { readOnly } = useWorkspaceAccess()
  const [searchParams] = useSearchParams()
  const { data, loading, error } = useQuery<GetValutEntriesQuery>(GET_VALUT_ENTRIES, {
    fetchPolicy: 'cache-and-network',
  })
  const [createValutEntry] = useMutation<CreateValutEntryMutation>(CREATE_VALUT_ENTRY, {
    refetchQueries: [GET_VALUT_ENTRIES],
  })
  const [updateValutEntry] = useMutation<UpdateValutEntryMutation>(UPDATE_VALUT_ENTRY, {
    refetchQueries: [GET_VALUT_ENTRIES],
  })
  const [deleteValutEntry] = useMutation<DeleteValutEntryMutation>(DELETE_VALUT_ENTRY, {
    refetchQueries: [GET_VALUT_ENTRIES],
  })

  const [dialog, setDialog] = useState<DialogState>(CLOSED_DIALOG)
  const [keyInput, setKeyInput] = useState('')
  const [valueInput, setValueInput] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ValutEntryData | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [expandedRefs, setExpandedRefs] = useState<Set<string>>(new Set())
  const handledEntryRef = useRef<string | null>(null)

  const groups = (data?.valutEntries ?? []).filter((group) => group.entries.length > 0)
  const totalEntries = groups.reduce((sum, group) => sum + group.entries.length, 0)

  const openCreate = () => {
    setDialog({ open: true, mode: 'create', entry: null })
    setKeyInput('')
    setValueInput('')
    setFormError(null)
    setServerError(null)
  }

  const openEdit = (entry: ValutEntryData) => {
    setDialog({ open: true, mode: 'edit', entry })
    setKeyInput(entry.key)
    // D10：编辑不回显旧值，value 恒为空待重填
    setValueInput('')
    setFormError(null)
    setServerError(null)
  }

  const closeDialog = () => {
    setDialog(CLOSED_DIALOG)
    setFormError(null)
    setServerError(null)
  }

  // D11 穿透定位：section=valut 时滚动到本区块
  const sectionParam = searchParams.get('section')
  useEffect(() => {
    if (sectionParam !== 'valut') return
    document.getElementById('valut-section')?.scrollIntoView({ behavior: 'smooth' })
  }, [sectionParam])

  // D11 穿透定位：entry 命中时自动展开该条目的编辑对话框（每个 entry 只处理一次，用户关闭后不回弹）
  const entryParam = searchParams.get('entry')
  useEffect(() => {
    if (!entryParam || !data) return
    if (handledEntryRef.current === entryParam) return
    const entry = findEntry(data.valutEntries, entryParam)
    if (!entry) return
    // 只读上下文 / 不可编辑条目只滚动不弹窗（无编辑入口）
    if (readOnly || !entry.editable) return
    handledEntryRef.current = entryParam
    openEdit(entry)
    // openEdit 每次渲染重建，仅作为触发动作，不进依赖
  }, [entryParam, data, readOnly])

  const handleSubmit = async () => {
    if (submitting) return
    const keyError = validateValutKey(keyInput)
    const valueError = validateValutValue(valueInput)
    if (keyError || valueError) {
      setFormError(keyError ?? valueError)
      return
    }
    setFormError(null)
    setServerError(null)
    setSubmitting(true)
    try {
      if (dialog.mode === 'create') {
        await createValutEntry({
          variables: { input: { key: keyInput.trim(), value: valueInput } },
        })
        toast.success('密钥条目已创建')
      } else if (dialog.entry) {
        await updateValutEntry({
          variables: { id: dialog.entry.id, value: valueInput },
        })
        toast.success('密钥值已更新')
      }
      closeDialog()
    } catch (err) {
      setServerError(valutErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      await deleteValutEntry({ variables: { id: deleteTarget.id } })
      toast.success('密钥条目已删除')
      setDeleteTarget(null)
    } catch (err) {
      setDeleteTarget(null)
      // 确认对话框已关闭，错误走 toast 兜底
      toast.error(valutErrorMessage(err))
    }
  }

  const toggleRefs = (id: string) => {
    setExpandedRefs((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const dialogTitle = dialog.mode === 'create' ? '新增条目' : '编辑条目'
  const keyReadonly = dialog.mode === 'edit'

  return (
    <section id="valut-section" className="mb-8 md:mb-10" data-testid="valut-section">
      <div className="mb-4 flex flex-wrap items-center gap-2 md:mb-6">
        <h2 className="text-lg font-semibold md:text-xl text-foreground">Valut</h2>
        <Badge variant="secondary">工作区</Badge>
        <span className="text-xs text-muted-foreground">密钥值仅创建/编辑时填写，界面不展示</span>
        {!readOnly && (
          <div className="ml-auto">
            <Button type="button" size="sm" aria-label="新增条目" onClick={openCreate}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              新增条目
            </Button>
          </div>
        )}
      </div>

      <Card>
        <CardContent>
          {loading && !data ? (
            <p className="text-sm text-muted-foreground">加载中...</p>
          ) : error && !data ? (
            <p className="text-sm text-destructive">密钥列表加载失败，可稍后重试</p>
          ) : totalEntries === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">暂无密钥条目</p>
          ) : (
            <div className="space-y-6">
              {groups.map((group) => (
                <div
                  key={group.namespace.name}
                  data-testid={`valut-group-${group.namespace.name}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-foreground">
                      {group.namespace.displayName}
                    </h3>
                    <Badge variant="outline">{group.namespace.name}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {group.entries.length} 条
                    </span>
                  </div>
                  <ul className="mt-2 space-y-2">
                    {group.entries.map((entry) => {
                      const refsExpanded = expandedRefs.has(entry.id)
                      return (
                        <li
                          key={entry.id}
                          className="min-w-0 rounded-lg border border-border p-3"
                          data-testid={`valut-entry-${entry.id}`}
                        >
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="min-w-0 break-all text-sm font-medium text-foreground">
                              {entry.key}
                            </span>
                            <Badge variant="outline" className="shrink-0">
                              {entry.namespaceDisplayName}
                            </Badge>
                            {!entry.deletable && (
                              <Badge variant="secondary" className="shrink-0">
                                服务托管
                              </Badge>
                            )}
                            <span className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
                              {entry.refs.length > 0 && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  aria-label={`查看 ${entry.key} 的引用`}
                                  aria-expanded={refsExpanded}
                                  onClick={() => toggleRefs(entry.id)}
                                >
                                  {refsExpanded ? (
                                    <ChevronDown className="mr-1 h-3.5 w-3.5" />
                                  ) : (
                                    <ChevronRight className="mr-1 h-3.5 w-3.5" />
                                  )}
                                  引用 {entry.refs.length}
                                </Button>
                              )}
                              {!readOnly && entry.editable && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  aria-label={`编辑 ${entry.key}`}
                                  onClick={() => openEdit(entry)}
                                >
                                  编辑
                                </Button>
                              )}
                              {!readOnly && entry.deletable && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="destructive"
                                  aria-label={`删除 ${entry.key}`}
                                  onClick={() => setDeleteTarget(entry)}
                                >
                                  删除
                                </Button>
                              )}
                            </span>
                          </div>
                          <p className="mt-1 break-all text-xs text-muted-foreground">
                            创建人 {entry.createdBy} · 更新于 {formatDateTime(entry.updatedAt)}
                          </p>
                          {refsExpanded && renderRefs(entry)}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialog.open} onOpenChange={(open) => (open ? undefined : closeDialog())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>
              {dialog.mode === 'create'
                ? '手动条目落在「自定义密钥」namespace，值加密存储。'
                : 'key 不可修改；旧值不可见，请填入新值覆盖。'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="valut-entry-key">名称</Label>
              <Input
                id="valut-entry-key"
                value={keyInput}
                readOnly={keyReadonly}
                aria-readonly={keyReadonly}
                placeholder="例如 my-api-token"
                onChange={(event) => {
                  setKeyInput(event.target.value)
                  setFormError(null)
                  setServerError(null)
                }}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="valut-entry-value">值</Label>
              <textarea
                id="valut-entry-value"
                value={valueInput}
                rows={4}
                className="w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
                placeholder={
                  dialog.mode === 'create' ? '输入密钥值（多行）' : '输入新值（旧值不可见）'
                }
                onChange={(event) => {
                  setValueInput(event.target.value)
                  setFormError(null)
                  setServerError(null)
                }}
              />
            </div>

            {formError && (
              <p role="alert" className="break-words text-sm text-destructive">
                {formError}
              </p>
            )}
            {serverError && (
              <p role="alert" className="break-words text-sm text-destructive">
                {serverError}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog} disabled={submitting}>
              取消
            </Button>
            <Button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submitting}
            >
              {submitting ? '保存中...' : dialog.mode === 'create' ? '创建' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title="删除密钥条目"
        description={
          deleteTarget
            ? `删除后不可恢复，确定删除密钥「${deleteTarget.key}」吗？`
            : ''
        }
        confirmLabel="删除"
        onConfirm={handleDelete}
      />
    </section>
  )
}
