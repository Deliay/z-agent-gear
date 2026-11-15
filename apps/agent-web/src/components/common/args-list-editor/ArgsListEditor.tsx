import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { validateArgDescription, validateArgKey, validateArgName } from '@/lib/custom-tool'

export interface ArgsListItem {
  key: string
  name: string
  description?: string | null
}

export interface ArgsListEditorProps {
  value: ArgsListItem[]
  onChange: (value: ArgsListItem[]) => void
  disabled?: boolean
}

const FIELD_CLASS =
  'w-full min-w-0 rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring'

/**
 * 参数列表编辑器（prompt / http 双类型复用，PRD 功能点 7）。
 *
 * - 按行维护 `{key,name,description?}`，增删改；
 * - 标识非法/重复、名称/描述超限即时提示（服务端一致性校验兜底）；
 * - 只读时禁用全部入口。
 */
export default function ArgsListEditor({ value, onChange, disabled = false }: ArgsListEditorProps) {
  const update = (index: number, patch: Partial<ArgsListItem>) => {
    onChange(value.map((item, current) => (current === index ? { ...item, ...patch } : item)))
  }

  const remove = (index: number) => {
    onChange(value.filter((_, current) => current !== index))
  }

  const keys = value.map((item) => item.key.trim())

  return (
    <div className="min-w-0 space-y-2">
      {value.length === 0 ? (
        <p className="text-xs text-muted-foreground">暂未声明参数</p>
      ) : (
        <ul className="min-w-0 space-y-2">
          {value.map((item, index) => {
            const keyError = validateArgKey(item.key, keys.filter((_, current) => current !== index))
            const nameError = validateArgName(item.name)
            const descriptionError = validateArgDescription(item.description ?? '')
            return (
              <li key={index} className="min-w-0 space-y-1 rounded-md border border-border p-2">
                <div className="flex min-w-0 items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <Input
                      aria-label={`参数标识 ${index + 1}`}
                      placeholder="标识（如 city）"
                      value={item.key}
                      className={FIELD_CLASS}
                      disabled={disabled}
                      onChange={(event) => update(index, { key: event.target.value })}
                    />
                    {keyError ? <p className="mt-1 text-xs text-destructive">{keyError}</p> : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    <Input
                      aria-label={`参数名称 ${index + 1}`}
                      placeholder="名称（展示给 AI）"
                      value={item.name}
                      className={FIELD_CLASS}
                      disabled={disabled}
                      onChange={(event) => update(index, { name: event.target.value })}
                    />
                    {nameError ? <p className="mt-1 text-xs text-destructive">{nameError}</p> : null}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`删除参数 ${index + 1}`}
                    disabled={disabled}
                    onClick={() => remove(index)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
                <Input
                  aria-label={`参数描述 ${index + 1}`}
                  placeholder="描述（可选）"
                  value={item.description ?? ''}
                  className={FIELD_CLASS}
                  disabled={disabled}
                  onChange={(event) => update(index, { description: event.target.value })}
                />
                {descriptionError ? (
                  <p className="text-xs text-destructive">{descriptionError}</p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => onChange([...value, { key: '', name: '', description: '' }])}
      >
        <Plus className="mr-1 size-4" />
        添加参数
      </Button>
    </div>
  )
}
