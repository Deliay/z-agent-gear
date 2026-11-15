import { useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { QueryError } from '@/components/ui/query-error'
import {
  COMPACT_COMMAND_RULE_MESSAGE,
  mapHarnessConfigError,
  validateCompactCommand,
} from '@/lib/harness-config'
import {
  ADMIN_HARNESS_CONFIGS,
  DEFAULT_COMPACT_COMMAND,
  HARNESS_TYPES,
  UPSERT_HARNESS_CONFIG,
  type AdminHarnessConfigsData,
  type HarnessType,
  type UpsertHarnessConfigData,
} from '@/graphql/harness-config'

/** Harness 展示名（与 agent-web 既有 harness 文案一致：OpenCode / Kimi Code / DeepSeek Harness）。 */
const HARNESS_LABELS: Record<HarnessType, string> = {
  OPENCODE: 'OpenCode',
  KIMI_CODE: 'Kimi Code',
  DEEPSEEK_HARNESS: 'DeepSeek Harness',
}

const HARNESS_DESCRIPTIONS: Record<HarnessType, string> = {
  OPENCODE: 'OpenCode 云电脑恢复原始会话时的压缩指令',
  KIMI_CODE: 'Kimi Code 云电脑恢复原始会话时的压缩指令',
  DEEPSEEK_HARNESS: 'DeepSeek Harness 云电脑恢复原始会话时的压缩指令',
}

function formatUpdatedAt(updatedAt: string | undefined): string | null {
  if (!updatedAt) return null
  const date = new Date(updatedAt)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString()
}

/**
 * Harness 配置页：固定三行（OPENCODE / KIMI_CODE / DEEPSEEK_HARNESS），
 * 逐行编辑「原始上下文压缩指令」并逐行保存（计划期裁决 D10，不做整页单保存）。
 */
export default function HarnessConfigsPage() {
  const { data, loading, error, refetch } = useQuery<AdminHarnessConfigsData>(ADMIN_HARNESS_CONFIGS)
  const [upsertConfig] = useMutation<UpsertHarnessConfigData>(UPSERT_HARNESS_CONFIG)

  // 逐行草稿：未编辑时回显服务端值（缺失行回落默认 /compact）
  const [drafts, setDrafts] = useState<Partial<Record<HarnessType, string>>>({})
  const [savingType, setSavingType] = useState<HarnessType | null>(null)

  const configs = data?.adminHarnessConfigs ?? []

  const serverValueOf = (harnessType: HarnessType) =>
    configs.find((config) => config.harnessType === harnessType)?.compactCommand

  const valueOf = (harnessType: HarnessType) =>
    drafts[harnessType] ?? serverValueOf(harnessType) ?? DEFAULT_COMPACT_COMMAND

  const handleSave = async (harnessType: HarnessType) => {
    const compactCommand = valueOf(harnessType).trim()
    if (!validateCompactCommand(compactCommand)) return

    setSavingType(harnessType)
    try {
      await upsertConfig({
        variables: { harnessType, compactCommand },
        refetchQueries: [ADMIN_HARNESS_CONFIGS],
      })
      setDrafts((prev) => ({ ...prev, [harnessType]: compactCommand }))
      toast.success(`${HARNESS_LABELS[harnessType]} 压缩指令已保存`)
    } catch (err) {
      toast.error(mapHarnessConfigError((err as Error).message))
    } finally {
      setSavingType(null)
    }
  }

  if (loading && !data) {
    return <div className="p-6 text-sm text-muted-foreground">加载中...</div>
  }

  if (error && !data) {
    return (
      <div className="p-6">
        <QueryError message={error.message} onRetry={() => void refetch()} />
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Harness 配置</h1>
        <p className="text-sm text-muted-foreground">
          配置各 Harness 的原始上下文压缩指令。工作流节点在返工/复工时若选择「原始会话」并开启压缩，将向该会话发送此指令。
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">压缩指令</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {HARNESS_TYPES.map((harnessType) => {
            const value = valueOf(harnessType)
            const valid = validateCompactCommand(value)
            const saving = savingType === harnessType
            const updatedAt = formatUpdatedAt(
              configs.find((config) => config.harnessType === harnessType)?.updatedAt,
            )

            return (
              <div key={harnessType} className="space-y-2 rounded-md border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-sm font-medium">{HARNESS_LABELS[harnessType]}</p>
                    <p className="text-xs text-muted-foreground">
                      {HARNESS_DESCRIPTIONS[harnessType]}
                      {updatedAt ? ` · 更新于 ${updatedAt}` : ''}
                    </p>
                  </div>
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    {harnessType}
                  </span>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`harness-compact-${harnessType}`}>压缩指令</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id={`harness-compact-${harnessType}`}
                      aria-label={`${HARNESS_LABELS[harnessType]} 压缩指令`}
                      aria-invalid={!valid}
                      value={value}
                      onChange={(e) =>
                        setDrafts((prev) => ({ ...prev, [harnessType]: e.target.value }))
                      }
                    />
                    <Button
                      size="sm"
                      aria-label={`保存 ${HARNESS_LABELS[harnessType]}`}
                      disabled={!valid || saving}
                      onClick={() => void handleSave(harnessType)}
                    >
                      {saving ? '保存中…' : '保存'}
                    </Button>
                  </div>
                  {!valid && <p className="text-xs text-destructive">{COMPACT_COMMAND_RULE_MESSAGE}</p>}
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>
    </div>
  )
}
