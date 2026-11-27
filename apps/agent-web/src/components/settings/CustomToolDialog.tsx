import { useEffect, useMemo, useState } from 'react'
import type {
  CreateCustomToolInput,
  CustomToolBodyType,
  CustomToolData,
  CustomToolType,
  FragmentData,
} from '@/graphql/custom-tool'
import {
  COMMON_HTTP_METHODS,
  isBodyMethod,
  validateCustomToolDescription,
  validateCustomToolName,
  validateArgKey,
  validateArgName,
  validateHeaderKey,
  validateQueryKey,
} from '@/lib/custom-tool'
import ArgsListEditor, { type ArgsListItem } from '@/components/common/args-list-editor/ArgsListEditor'
import FragmentEditor from '@/components/common/fragment-editor/FragmentEditor'
import { Button } from '@/components/ui/button'
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

interface FormFieldRow {
  key: string
  type: 'text' | 'file'
  value: FragmentData[]
}

interface KeyValueRow {
  key: string
  value: FragmentData[]
}

interface FormState {
  name: string
  description: string
  type: CustomToolType
  args: ArgsListItem[]
  prompt: FragmentData[]
  method: string
  endpoint: FragmentData[]
  insecure: boolean
  bodyType: 'none' | CustomToolBodyType
  body: FragmentData[]
  form: FormFieldRow[]
  headers: KeyValueRow[]
  queries: KeyValueRow[]
}

const EMPTY: FormState = {
  name: '',
  description: '',
  type: 'prompt',
  args: [],
  prompt: [],
  method: 'GET',
  endpoint: [{ type: 'Plain', value: 'https://', format: 'Generic' }],
  insecure: false,
  bodyType: 'none',
  body: [],
  form: [],
  headers: [],
  queries: [],
}

const ERROR_HINT =
  '这个工具会要求 AI 输入参数列表中的参数，并将提示词的内容进行模板替换'

function fromTool(tool: CustomToolData): FormState {
  if (tool.type === 'prompt') {
    return {
      ...EMPTY,
      name: tool.name,
      description: tool.description ?? '',
      type: 'prompt',
      args: tool.args.map((arg) => ({ key: arg.key, name: arg.name, description: arg.description })),
      prompt: tool.prompt ?? [],
    }
  }
  const http = tool.http
  return {
    ...EMPTY,
    name: tool.name,
    description: tool.description ?? '',
    type: 'http',
    args: tool.args.map((arg) => ({ key: arg.key, name: arg.name, description: arg.description })),
    method: http?.method ?? 'GET',
    endpoint: http?.endpoint ?? EMPTY.endpoint,
    insecure: http?.insecure ?? false,
    bodyType: http?.bodyType ?? 'none',
    body: http?.body ?? [],
    form: (http?.form ?? []).map((field) => ({
      key: field.key,
      type: field.type,
      value: field.value,
    })),
    headers: (http?.headers ?? []).map((row) => ({ key: row.key, value: row.value })),
    queries: (http?.queries ?? []).map((row) => ({ key: row.key, value: row.value })),
  }
}

export interface CustomToolDialogProps {
  open: boolean
  tool: CustomToolData | null
  submitting?: boolean
  onClose: () => void
  onSubmit: (input: CreateCustomToolInput) => Promise<void>
}

/**
 * 自定义工具新增/编辑对话框（PRD 功能点 5/6 前端呈现）。
 *
 * - 名称/描述/类型；参数列表（ArgsListEditor，双类型复用）；
 * - prompt：「提示文案 + 多行 FragmentEditor（Generic）」；
 * - http：method（常用下拉 + 自定义）/ endpoint（单行 Uri）/ insecure / body（GET 类隐藏、
 *   POST 类默认 json，text|json|form 三态）/ headers / queries（勾选展开按行编辑）；
 * - 每处 FragmentEditor 独立受控 value（禁止共享 store）。
 */
export default function CustomToolDialog({
  open,
  tool,
  submitting = false,
  onClose,
  onSubmit,
}: CustomToolDialogProps) {
  const [form, setForm] = useState<FormState>(() => (tool ? fromTool(tool) : EMPTY))
  const [error, setError] = useState<string | null>(null)
  const [headersEnabled, setHeadersEnabled] = useState(false)
  const [queriesEnabled, setQueriesEnabled] = useState(false)
  const [bodyType, setBodyType] = useState<'none' | CustomToolBodyType>('none')

  useEffect(() => {
    if (!open) return
    const next = tool ? fromTool(tool) : EMPTY
    setForm(next)
    setError(null)
    setBodyType(next.bodyType)
    setHeadersEnabled(next.headers.length > 0)
    setQueriesEnabled(next.queries.length > 0)
  }, [open, tool])

  const argParams = useMemo(() => {
    const params: Record<string, { name: string; description?: string }> = {}
    for (const arg of form.args) {
      const key = arg.key.trim()
      if (!key) continue
      params[key] = { name: arg.name.trim() || key, description: arg.description ?? undefined }
    }
    return params
  }, [form.args])

  const bodyVisible = isBodyMethod(form.method)

  const patch = (next: Partial<FormState>) => setForm((current) => ({ ...current, ...next }))

  const submit = async () => {
    setError(null)
    const nameError = validateCustomToolName(form.name)
    if (nameError) return setError(nameError)
    const descriptionError = validateCustomToolDescription(form.description)
    if (descriptionError) return setError(descriptionError)

    const keys = form.args.map((arg) => arg.key.trim())
    for (const [index, arg] of form.args.entries()) {
      const keyError = validateArgKey(arg.key, keys.filter((_, current) => current !== index))
      if (keyError) return setError(`参数 ${index + 1}：${keyError}`)
      const nameIssue = validateArgName(arg.name)
      if (nameIssue) return setError(`参数 ${index + 1}：${nameIssue}`)
    }

    const args = form.args.map((arg) => ({
      key: arg.key.trim(),
      name: arg.name.trim(),
      description: arg.description?.trim() || null,
    }))

    if (form.type === 'prompt') {
      await onSubmit({
        name: form.name.trim(),
        description: form.description.trim() || null,
        type: 'prompt',
        args,
        prompt: form.prompt,
      })
      return
    }

    const endpoint = form.endpoint
    if (endpoint.length === 0 || endpoint[0].type !== 'Plain' || !/^https?:\/\//i.test(endpoint[0].value)) {
      return setError('endpoint 必须以 http:// 或 https:// 开头')
    }

    const headerKeys: string[] = []
    for (const [index, row] of form.headers.entries()) {
      const keyError = validateHeaderKey(row.key, headerKeys)
      if (keyError) return setError(`Header ${index + 1}：${keyError}`)
      headerKeys.push(row.key.trim())
    }
    const queryKeys: string[] = []
    for (const [index, row] of form.queries.entries()) {
      const keyError = validateQueryKey(row.key, queryKeys)
      if (keyError) return setError(`Query ${index + 1}：${keyError}`)
      queryKeys.push(row.key.trim())
    }

    const effectiveBodyType = bodyVisible && bodyType !== 'none' ? bodyType : null
    // 仅校验实际提交的 body 形态：切离 form 后残留行不参与校验（对应编辑区已隐藏）。
    if (effectiveBodyType === 'form') {
      for (const field of form.form) {
        if (!field.key.trim()) return setError('Form 字段名称不能为空')
        if (field.type === 'file') return setError('本期不支持文件类型')
      }
    }

    await onSubmit({
      name: form.name.trim(),
      description: form.description.trim() || null,
      type: 'http',
      args,
      http: {
        method: form.method.trim().toUpperCase(),
        endpoint,
        insecure: form.insecure,
        bodyType: effectiveBodyType,
        body: effectiveBodyType === 'text' || effectiveBodyType === 'json' ? form.body : undefined,
        form:
          effectiveBodyType === 'form'
            ? form.form
                .filter((field) => field.key.trim())
                .map((field) => ({ key: field.key.trim(), type: field.type, value: field.value }))
            : undefined,
        headers: form.headers
          .filter((row) => row.key.trim())
          .map((row) => ({ key: row.key.trim(), value: row.value })),
        queries: form.queries
          .filter((row) => row.key.trim())
          .map((row) => ({ key: row.key.trim(), value: row.value })),
      },
    })
  }

  const keyValueEditor = (
    rows: KeyValueRow[],
    onChange: (rows: KeyValueRow[]) => void,
    kind: 'header' | 'query',
  ) => (
    <div className="min-w-0 space-y-2">
      {rows.map((row, index) => (
        <div key={index} className="flex min-w-0 items-start gap-2">
          <Input
            aria-label={`${kind === 'header' ? 'Header' : 'Query'} 名称 ${index + 1}`}
            placeholder={kind === 'header' ? 'Header 名称' : 'query 名称'}
            value={row.key}
            className="w-40 shrink-0"
            onChange={(event) =>
              onChange(rows.map((item, current) => (current === index ? { ...item, key: event.target.value } : item)))
            }
          />
          <div className="min-w-0 flex-1">
            <FragmentEditor
              mode="single"
              editorMode={kind === 'query' ? 'Uri' : 'Generic'}
              params={argParams}
              ariaLabel={`${kind === 'header' ? 'Header' : 'Query'} 值 ${index + 1}`}
              value={row.value}
              onChange={(value) =>
                onChange(rows.map((item, current) => (current === index ? { ...item, value } : item)))
              }
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`删除 ${kind} ${index + 1}`}
            onClick={() => onChange(rows.filter((_, current) => current !== index))}
          >
            ×
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          onChange([...rows, { key: '', value: [{ type: 'Plain', value: '', format: 'Generic' }] }])
        }
      >
        添加一行
      </Button>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !submitting ? onClose() : undefined)}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tool ? '编辑自定义工具' : '新增自定义工具'}</DialogTitle>
          <DialogDescription>
            自定义工具经平台 MCP <code>agent-custom-tools</code> 提供给当前工作区的会话使用。
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-4">
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <div className="min-w-0 space-y-1">
              <Label htmlFor="custom-tool-name">名称</Label>
              <Input
                id="custom-tool-name"
                value={form.name}
                placeholder="如：查询天气"
                onChange={(event) => patch({ name: event.target.value })}
              />
            </div>
            <div className="min-w-0 space-y-1">
              <Label htmlFor="custom-tool-type">类型</Label>
              <select
                id="custom-tool-type"
                className="w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={form.type}
                onChange={(event) => patch({ type: event.target.value as CustomToolType })}
              >
                <option value="prompt">Prompt（提示词）</option>
                <option value="http">HTTP 请求</option>
              </select>
            </div>
          </div>

          <div className="min-w-0 space-y-1">
            <Label htmlFor="custom-tool-description">描述</Label>
            <Input
              id="custom-tool-description"
              value={form.description}
              placeholder="可选，≤512 字符"
              onChange={(event) => patch({ description: event.target.value })}
            />
          </div>

          <div className="min-w-0 space-y-2">
            <Label>参数列表</Label>
            <ArgsListEditor value={form.args} onChange={(args) => patch({ args })} />
          </div>

          {form.type === 'prompt' ? (
            <div className="min-w-0 space-y-2">
              <p className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">{ERROR_HINT}</p>
              <Label>提示词</Label>
              <FragmentEditor
                mode="multi"
                editorMode="Generic"
                params={argParams}
                placeholder="输入 $ 引用参数、# 引用 Valut 密钥名称"
                ariaLabel="提示词模板"
                value={form.prompt}
                onChange={(prompt) => patch({ prompt })}
                className="min-w-0"
              />
            </div>
          ) : (
            <div className="min-w-0 space-y-4">
              <div className="grid min-w-0 gap-3 sm:grid-cols-[8rem_1fr]">
                <div className="min-w-0 space-y-1">
                  <Label htmlFor="custom-tool-method">Method</Label>
                  <Input
                    id="custom-tool-method"
                    list="custom-tool-method-options"
                    value={form.method}
                    onChange={(event) => {
                      const method = event.target.value
                      const shouldDefaultJson = isBodyMethod(method) && bodyType === 'none'
                      if (shouldDefaultJson) setBodyType('json')
                      if (!isBodyMethod(method) && bodyType !== 'none') setBodyType('none')
                      patch({ method })
                    }}
                  />
                  <datalist id="custom-tool-method-options">
                    {COMMON_HTTP_METHODS.map((method) => (
                      <option key={method} value={method} />
                    ))}
                  </datalist>
                </div>
                <div className="min-w-0 space-y-1">
                  <Label>Endpoint</Label>
                  <FragmentEditor
                    mode="single"
                    editorMode="Uri"
                    params={argParams}
                    placeholder="https://…"
                    ariaLabel="Endpoint 模板"
                    value={form.endpoint}
                    onChange={(endpoint) => patch({ endpoint })}
                    className="min-w-0"
                  />
                </div>
              </div>

              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.insecure}
                  onChange={(event) => patch({ insecure: event.target.checked })}
                />
                <span>
                  跳过 TLS 证书校验（insecure）
                  <span className="block text-xs text-muted-foreground">
                    仅本次工具调用生效；请确认目标可信。
                  </span>
                </span>
              </label>

              {bodyVisible ? (
                <div className="min-w-0 space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="custom-tool-body-type">Body</Label>
                    <select
                      id="custom-tool-body-type"
                      className="rounded-md border border-input bg-background px-2 py-1 text-sm"
                      value={bodyType}
                      onChange={(event) => {
                        const next = event.target.value as 'none' | CustomToolBodyType
                        setBodyType(next)
                      }}
                    >
                      <option value="none">无</option>
                      <option value="json">JSON</option>
                      <option value="text">Text</option>
                      <option value="form">Form</option>
                    </select>
                  </div>
                  {bodyType === 'text' || bodyType === 'json' ? (
                    <FragmentEditor
                      mode="multi"
                      editorMode={bodyType === 'json' ? 'Json' : 'Generic'}
                      params={argParams}
                      ariaLabel="Body 模板"
                      value={form.body}
                      onChange={(body) => patch({ body })}
                      className="min-w-0"
                    />
                  ) : null}
                  {bodyType === 'form' ? (
                    <div className="min-w-0 space-y-2">
                      {form.form.map((field, index) => (
                        <div key={index} className="flex min-w-0 items-start gap-2">
                          <Input
                            aria-label={`Form 字段 ${index + 1}`}
                            className="w-32 shrink-0"
                            value={field.key}
                            placeholder="字段名"
                            onChange={(event) =>
                              patch({
                                form: form.form.map((item, current) =>
                                  current === index ? { ...item, key: event.target.value } : item,
                                ),
                              })
                            }
                          />
                          <select
                            aria-label={`Form 字段类型 ${index + 1}`}
                            className="rounded-md border border-input bg-background px-2 py-1 text-sm"
                            value={field.type}
                            onChange={(event) =>
                              patch({
                                form: form.form.map((item, current) =>
                                  current === index
                                    ? { ...item, type: event.target.value as 'text' | 'file' }
                                    : item,
                                ),
                              })
                            }
                          >
                            <option value="text">文本</option>
                            <option value="file" disabled>
                              文件（本期不支持）
                            </option>
                          </select>
                          <div className="min-w-0 flex-1">
                            <FragmentEditor
                              mode="single"
                              editorMode="Generic"
                              params={argParams}
                              ariaLabel={`Form 字段值 ${index + 1}`}
                              value={field.value}
                              onChange={(value) =>
                                patch({
                                  form: form.form.map((item, current) =>
                                    current === index ? { ...item, value } : item,
                                  ),
                                })
                              }
                            />
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`删除 Form 字段 ${index + 1}`}
                            onClick={() =>
                              patch({ form: form.form.filter((_, current) => current !== index) })
                            }
                          >
                            ×
                          </Button>
                        </div>
                      ))}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          patch({
                            form: [
                              ...form.form,
                              { key: '', type: 'text', value: [{ type: 'Plain', value: '', format: 'Generic' }] },
                            ],
                          })
                        }
                      >
                        添加 Form 字段
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="min-w-0 space-y-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={queriesEnabled}
                    onChange={(event) => {
                      setQueriesEnabled(event.target.checked)
                      if (event.target.checked && form.queries.length === 0) {
                        patch({
                          queries: [{ key: '', value: [{ type: 'Plain', value: '', format: 'Generic' }] }],
                        })
                      }
                      if (!event.target.checked) patch({ queries: [] })
                    }}
                  />
                  Queries
                </label>
                {queriesEnabled
                  ? keyValueEditor(form.queries, (queries) => patch({ queries }), 'query')
                  : null}
              </div>

              <div className="min-w-0 space-y-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={headersEnabled}
                    onChange={(event) => {
                      setHeadersEnabled(event.target.checked)
                      if (event.target.checked && form.headers.length === 0) {
                        patch({
                          headers: [{ key: '', value: [{ type: 'Plain', value: '', format: 'Generic' }] }],
                        })
                      }
                      if (!event.target.checked) patch({ headers: [] })
                    }}
                  />
                  Headers
                </label>
                {headersEnabled
                  ? keyValueEditor(form.headers, (headers) => patch({ headers }), 'header')
                  : null}
              </div>
            </div>
          )}

          {error ? <p className="text-sm text-destructive-text">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={submitting} onClick={onClose}>
            取消
          </Button>
          <Button type="button" disabled={submitting} onClick={() => void submit()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

