import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react'
import { GET_CUSTOM_MCP_SERVERS, GET_VALUT_MANUAL_OPTIONS } from '@/graphql/queries'
import {
  CREATE_CUSTOM_MCP_SERVER,
  DELETE_CUSTOM_MCP_SERVER,
  UPDATE_CUSTOM_MCP_SERVER,
} from '@/graphql/mutations'
import type {
  CreateCustomMcpServerInput,
  CreateCustomMcpServerMutation,
  CustomMcpAuthInput,
  CustomMcpAuthType,
  CustomMcpServerData,
  DeleteCustomMcpServerMutation,
  GetCustomMcpServersQuery,
  GetValutManualOptionsQuery,
  UpdateCustomMcpServerInput,
  UpdateCustomMcpServerMutation,
} from '@/graphql/types'
import {
  CUSTOM_MCP_AUTH_LABELS,
  customMcpErrorMessage,
  normalizeCustomMcpHeaders,
  validateCustomMcpDescription,
  validateCustomMcpEndpoint,
  validateCustomMcpName,
} from '@/lib/custom-mcp'
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

interface HeaderRow {
  key: string
  /** 每行一个同名 header 值（提交时拆分为 values[]） */
  valuesText: string
}

interface FormState {
  name: string
  description: string
  endpoint: string
  headers: HeaderRow[]
  authType: CustomMcpAuthType
  /** Bearer 二选一：填写 token / 选择已有 manual 条目 */
  bearerMode: 'fill' | 'select'
  newToken: string
  existingEntryId: string
}

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  endpoint: '',
  headers: [],
  authType: 'none',
  bearerMode: 'fill',
  newToken: '',
  existingEntryId: '',
}

const FIELD_CLASS =
  'w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring'

/**
 * 设置页「自定义 MCP」区块（工作区级 HTTP MCP，contracts/custom-mcp.graphql）。
 *
 * - bearer 两条路径：填写 token（自建，写入 Valut `service-mcp-bearer-tokens`）/ 选择 token（仅 manual）；
 * - 编辑时 `bearerEntryManaged=true` 就地重填（value 空待重填、不回显），
 *   `false` 展示「前往 Valut 编辑」穿透链接（D11：`/settings?section=valut&entry=<id>`）；
 * - 只读（全局工作区 developer）隐藏新增/编辑/删除入口，服务端插件为权威；
 * - 删除二次确认，自建 token 额外提示联动删除 Valut 条目。
 */
export default function CustomMcpSection() {
  const { readOnly } = useWorkspaceAccess()
  const navigate = useNavigate()
  const { data, loading, error } = useQuery<GetCustomMcpServersQuery>(GET_CUSTOM_MCP_SERVERS, {
    fetchPolicy: 'cache-and-network',
  })
  const [createCustomMcpServer] = useMutation<CreateCustomMcpServerMutation>(
    CREATE_CUSTOM_MCP_SERVER,
    { refetchQueries: [GET_CUSTOM_MCP_SERVERS] },
  )
  const [updateCustomMcpServer] = useMutation<UpdateCustomMcpServerMutation>(
    UPDATE_CUSTOM_MCP_SERVER,
    { refetchQueries: [GET_CUSTOM_MCP_SERVERS] },
  )
  const [deleteCustomMcpServer] = useMutation<DeleteCustomMcpServerMutation>(
    DELETE_CUSTOM_MCP_SERVER,
    { refetchQueries: [GET_CUSTOM_MCP_SERVERS] },
  )

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<CustomMcpServerData | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<CustomMcpServerData | null>(null)

  // 「选择 token」数据源：仅 manual namespace（服务端强制），仅对话框打开且选择 Bearer 时拉取
  const { data: manualData } = useQuery<GetValutManualOptionsQuery>(GET_VALUT_MANUAL_OPTIONS, {
    skip: !dialogOpen || form.authType !== 'bearer',
    fetchPolicy: 'cache-and-network',
  })
  const manualOptions = manualData?.valutManualOptions ?? []

  const servers = data?.customMcpServers ?? []

  const patchForm = (patch: Partial<FormState>) => {
    setForm((prev) => ({ ...prev, ...patch }))
    setFormError(null)
    setServerError(null)
  }

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setFormError(null)
    setServerError(null)
    setDialogOpen(true)
  }

  const openEdit = (server: CustomMcpServerData) => {
    const bearerMode = server.authType === 'bearer' && server.bearerEntryManaged === false
      ? 'select'
      : 'fill'
    setEditing(server)
    setForm({
      name: server.name,
      description: server.description ?? '',
      endpoint: server.endpoint,
      headers: server.customHeaders.map((header) => ({
        key: header.key,
        valuesText: header.values.join('\n'),
      })),
      authType: server.authType,
      bearerMode,
      // token 恒不回显（契约无出参），编辑态空待重填
      newToken: '',
      existingEntryId: server.bearerEntryId ?? '',
    })
    setFormError(null)
    setServerError(null)
    setDialogOpen(true)
  }

  const closeDialog = () => {
    setDialogOpen(false)
    setEditing(null)
    setForm(EMPTY_FORM)
    setFormError(null)
    setServerError(null)
  }

  const addHeader = () => {
    setForm((prev) => ({ ...prev, headers: [...prev.headers, { key: '', valuesText: '' }] }))
  }

  const patchHeader = (index: number, patch: Partial<HeaderRow>) => {
    setForm((prev) => ({
      ...prev,
      headers: prev.headers.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    }))
    setFormError(null)
    setServerError(null)
  }

  const removeHeader = (index: number) => {
    setForm((prev) => ({
      ...prev,
      headers: prev.headers.filter((_, i) => i !== index),
    }))
  }

  /** 组装 `auth`：省略 = 不动（编辑态未触碰验证方式时不下发该字段） */
  const buildAuth = (): { auth: CustomMcpAuthInput | undefined; error: string | null } => {
    if (form.authType === 'none') {
      // 从 bearer 切回 none 才需要显式下发；原本就是 none 则不动
      return editing?.authType === 'bearer'
        ? { auth: { type: 'none' }, error: null }
        : { auth: undefined, error: null }
    }

    if (form.bearerMode === 'fill') {
      const token = form.newToken.trim()
      if (token) return { auth: { type: 'bearer', newToken: token }, error: null }
      // 未输入新值：原样保持（自建/引用均不动）；从 none 切到 bearer 才必须填
      if (editing && editing.authType === 'bearer') return { auth: undefined, error: null }
      return { auth: undefined, error: '请填写 Bearer token' }
    }

    const entryId = form.existingEntryId.trim()
    if (!entryId) return { auth: undefined, error: '请选择密钥条目' }
    if (editing && entryId === editing.bearerEntryId) {
      return { auth: undefined, error: null }
    }
    return { auth: { type: 'bearer', existingEntryId: entryId }, error: null }
  }

  const handleSubmit = async () => {
    if (submitting) return
    setServerError(null)

    const nameError = validateCustomMcpName(form.name)
    if (nameError) {
      setFormError(nameError)
      return
    }
    const endpointError = validateCustomMcpEndpoint(form.endpoint)
    if (endpointError) {
      setFormError(endpointError)
      return
    }
    const descriptionError = validateCustomMcpDescription(form.description)
    if (descriptionError) {
      setFormError(descriptionError)
      return
    }
    const { headers, error: headerError } = normalizeCustomMcpHeaders(
      form.headers.map((row) => ({ key: row.key, values: row.valuesText.split('\n') })),
    )
    if (headerError) {
      setFormError(headerError)
      return
    }
    const { auth, error: authError } = buildAuth()
    if (authError) {
      setFormError(authError)
      return
    }

    setSubmitting(true)
    try {
      if (!editing) {
        const input: CreateCustomMcpServerInput = {
          name: form.name.trim(),
          description: form.description.trim() || null,
          endpoint: form.endpoint.trim(),
          auth: auth ?? { type: 'none' },
          customHeaders: headers,
        }
        await createCustomMcpServer({ variables: { input } })
        toast.success('自定义 MCP 已创建')
      } else {
        const input: UpdateCustomMcpServerInput = {
          name: form.name.trim(),
          description: form.description.trim() || null,
          endpoint: form.endpoint.trim(),
          customHeaders: headers,
        }
        if (auth) input.auth = auth
        await updateCustomMcpServer({ variables: { id: editing.id, input } })
        toast.success('自定义 MCP 已更新')
      }
      closeDialog()
    } catch (err) {
      setServerError(customMcpErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      await deleteCustomMcpServer({ variables: { id: deleteTarget.id } })
      toast.success('自定义 MCP 已删除')
      setDeleteTarget(null)
    } catch (err) {
      setDeleteTarget(null)
      // 对话框已关闭，错误走 toast 兜底
      toast.error(customMcpErrorMessage(err))
    }
  }

  const isEdit = editing !== null
  const bearerEntryLink =
    isEdit && editing.authType === 'bearer' && editing.bearerEntryManaged === false
      ? editing.bearerEntryId
      : null

  return (
    <section
      id="custom-mcp-section"
      className="mb-8 md:mb-10"
      data-testid="custom-mcp-section"
    >
      <div className="mb-4 flex flex-wrap items-center gap-2 md:mb-6">
        <h2 className="text-lg font-semibold md:text-xl text-foreground">自定义 MCP</h2>
        <Badge variant="secondary">工作区</Badge>
        <span className="text-xs text-muted-foreground">
          经平台代理转发，真实地址与凭据不出服务端
        </span>
        {!readOnly && (
          <div className="ml-auto">
            <Button type="button" size="sm" aria-label="新增自定义 MCP" onClick={openCreate}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              新增
            </Button>
          </div>
        )}
      </div>

      <Card>
        <CardContent>
          {loading && !data ? (
            <p className="text-sm text-muted-foreground">加载中...</p>
          ) : error && !data ? (
            <p className="text-sm text-destructive">列表加载失败，可稍后重试</p>
          ) : servers.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">暂无自定义 MCP</p>
          ) : (
            <ul className="space-y-2">
              {servers.map((server) => (
                <li
                  key={server.id}
                  className="min-w-0 rounded-lg border border-border p-3"
                  data-testid={`custom-mcp-item-${server.id}`}
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="min-w-0 break-all text-sm font-medium text-foreground">
                      {server.name}
                    </span>
                    <Badge variant="outline" className="shrink-0">
                      {CUSTOM_MCP_AUTH_LABELS[server.authType]}
                    </Badge>
                    <span className="ml-auto flex shrink-0 items-center gap-2">
                      {!readOnly && (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            aria-label={`编辑 ${server.name}`}
                            onClick={() => openEdit(server)}
                          >
                            <Pencil className="mr-1 h-3.5 w-3.5" />
                            编辑
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            aria-label={`删除 ${server.name}`}
                            onClick={() => setDeleteTarget(server)}
                          >
                            <Trash2 className="mr-1 h-3.5 w-3.5" />
                            删除
                          </Button>
                        </>
                      )}
                    </span>
                  </div>
                  <p className="mt-1 min-w-0 break-all text-xs text-muted-foreground">
                    {server.endpoint}
                  </p>
                  {server.description && (
                    <p className="mt-1 min-w-0 break-words text-xs text-muted-foreground">
                      {server.description}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={(open) => (open ? undefined : closeDialog())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isEdit ? '编辑自定义 MCP' : '新增自定义 MCP'}</DialogTitle>
            <DialogDescription>
              {isEdit
                ? 'endpoint/请求头编辑后对新调用立即生效；token 旧值不回显。'
                : 'HTTP 协议的自定义 MCP，对会话仅暴露平台代理地址。'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="custom-mcp-name">名称</Label>
              <Input
                id="custom-mcp-name"
                value={form.name}
                placeholder="工作区内唯一，1~64 字符"
                onChange={(event) => patchForm({ name: event.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="custom-mcp-description">描述（可选）</Label>
              <Input
                id="custom-mcp-description"
                value={form.description}
                placeholder="最多 512 字符"
                onChange={(event) => patchForm({ description: event.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="custom-mcp-endpoint">endpoint</Label>
              <Input
                id="custom-mcp-endpoint"
                value={form.endpoint}
                placeholder="https://example.com/mcp"
                onChange={(event) => patchForm({ endpoint: event.target.value })}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>自定义请求头（可选，同名可多值）</Label>
                <Button type="button" size="sm" variant="outline" onClick={addHeader}>
                  添加请求头
                </Button>
              </div>
              {form.headers.length === 0 ? (
                <p className="text-xs text-muted-foreground">暂无自定义请求头</p>
              ) : (
                <div className="space-y-3">
                  {form.headers.map((row, index) => (
                    <div
                      key={index}
                      className="space-y-2 rounded-md border border-border p-2"
                    >
                      <div className="flex gap-2">
                        <Input
                          value={row.key}
                          placeholder="请求头名称（不含空白与冒号）"
                          aria-label={`请求头名称 ${index + 1}`}
                          onChange={(event) => patchHeader(index, { key: event.target.value })}
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={`删除请求头 ${index + 1}`}
                          onClick={() => removeHeader(index)}
                        >
                          删除
                        </Button>
                      </div>
                      <textarea
                        rows={2}
                        value={row.valuesText}
                        placeholder={'每行一个值（同名多值）'}
                        aria-label={`请求头值 ${index + 1}`}
                        className={`${FIELD_CLASS} min-w-0 break-all`}
                        onChange={(event) => patchHeader(index, { valuesText: event.target.value })}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-card-foreground">验证方式</legend>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="custom-mcp-auth-type"
                    value="none"
                    checked={form.authType === 'none'}
                    onChange={() => patchForm({ authType: 'none' })}
                    className="h-4 w-4"
                  />
                  <span>无验证</span>
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="custom-mcp-auth-type"
                    value="bearer"
                    checked={form.authType === 'bearer'}
                    onChange={() => patchForm({ authType: 'bearer' })}
                    className="h-4 w-4"
                  />
                  <span>Bearer Token</span>
                </label>
              </div>
            </fieldset>

            {form.authType === 'bearer' && (
              <div className="space-y-3 rounded-md border border-border p-3">
                <div className="flex flex-wrap gap-x-6 gap-y-2" role="radiogroup" aria-label="Token 来源">
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="custom-mcp-bearer-mode"
                      value="fill"
                      checked={form.bearerMode === 'fill'}
                      onChange={() => patchForm({ bearerMode: 'fill' })}
                      className="h-4 w-4"
                    />
                    <span>填写 token</span>
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="custom-mcp-bearer-mode"
                      value="select"
                      checked={form.bearerMode === 'select'}
                      onChange={() => patchForm({ bearerMode: 'select' })}
                      className="h-4 w-4"
                    />
                    <span>选择 token</span>
                  </label>
                </div>

                {form.bearerMode === 'fill' ? (
                  <div className="space-y-2">
                    <Label htmlFor="custom-mcp-token">Bearer token</Label>
                    <textarea
                      id="custom-mcp-token"
                      rows={3}
                      value={form.newToken}
                      placeholder={isEdit ? '输入新值（旧值不可见）' : '输入 Bearer token'}
                      className={`${FIELD_CLASS} min-w-0 break-all`}
                      onChange={(event) => patchForm({ newToken: event.target.value })}
                    />
                    <p className="text-xs text-muted-foreground">
                      写入 Valut「MCP Bearer Tokens」，界面不回显已存值。
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="custom-mcp-bearer-entry">密钥条目（仅自定义密钥）</Label>
                    <select
                      id="custom-mcp-bearer-entry"
                      value={form.existingEntryId}
                      onChange={(event) => patchForm({ existingEntryId: event.target.value })}
                      className={FIELD_CLASS}
                    >
                      <option value="">选择密钥条目</option>
                      {manualOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.key}
                        </option>
                      ))}
                    </select>
                    {manualOptions.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        暂无可选择的密钥条目，请先在 Valut 新增
                      </p>
                    )}
                  </div>
                )}

                {bearerEntryLink && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline"
                    onClick={() =>
                      navigate(`/settings?section=valut&entry=${bearerEntryLink}`)
                    }
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    前往 Valut 编辑
                  </button>
                )}
              </div>
            )}

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
            <Button type="button" onClick={() => void handleSubmit()} disabled={submitting}>
              {submitting ? '保存中...' : isEdit ? '保存' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title="删除自定义 MCP"
        description={
          deleteTarget
            ? deleteTarget.authType === 'bearer' && deleteTarget.bearerEntryManaged === true
              ? `删除后不可恢复，且会同时删除关联的 Valut 自建 token 条目，确定删除「${deleteTarget.name}」吗？`
              : `删除后不可恢复，确定删除「${deleteTarget.name}」吗？`
            : ''
        }
        confirmLabel="删除"
        onConfirm={handleDelete}
      />
    </section>
  )
}
