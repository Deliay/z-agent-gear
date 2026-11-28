import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { Server } from 'lucide-react'
import { ADMIN_MODELS } from '@/graphql/queries'
import { UPDATE_MODEL_PRICING } from '@/graphql/mutations'
import type { AdminModelData, GetAdminModelsQuery } from '@/graphql/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { QueryError } from '@/components/ui/query-error'
import { LoadingSkeleton } from '@/components/ui/skeleton'
import * as T from '@/lib/table-styles'

interface Draft {
  inputPerMillion: string
  cachedInputPerMillion: string
  outputPerMillion: string
  isBillable: boolean
}

function draftOf(model: AdminModelData): Draft {
  return {
    inputPerMillion: String(model.pricing?.inputPerMillion ?? 0),
    cachedInputPerMillion: String(model.pricing?.cachedInputPerMillion ?? 0),
    outputPerMillion: String(model.pricing?.outputPerMillion ?? 0),
    isBillable: model.pricing?.isBillable ?? true,
  }
}

/** 模型定价编辑（输入/缓存输入/输出 每百万 token + 计费开关）。 */
export default function ModelPricingSection() {
  const { data, loading, error, refetch } = useQuery<GetAdminModelsQuery>(ADMIN_MODELS)
  const [updatePricing] = useMutation(UPDATE_MODEL_PRICING)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [savingId, setSavingId] = useState<string | null>(null)

  const models = useMemo(() => data?.adminModels ?? [], [data])

  const draftFor = (model: AdminModelData): Draft => drafts[model.id] ?? draftOf(model)

  const patch = (id: string, model: AdminModelData, value: Partial<Draft>) => {
    setDrafts((current) => ({ ...current, [id]: { ...draftFor(model), ...value } }))
  }

  const save = async (model: AdminModelData) => {
    const draft = draftFor(model)
    const values = {
      inputPerMillion: Number(draft.inputPerMillion),
      cachedInputPerMillion: Number(draft.cachedInputPerMillion),
      outputPerMillion: Number(draft.outputPerMillion),
      isBillable: draft.isBillable,
    }
    const numeric = [values.inputPerMillion, values.cachedInputPerMillion, values.outputPerMillion]
    if (numeric.some((value) => !Number.isFinite(value) || value < 0)) {
      toast.error('单价必须为非负数')
      return
    }
    setSavingId(model.id)
    try {
      await updatePricing({ variables: { modelId: model.id, pricing: values } })
      await refetch()
      setDrafts((current) => {
        const next = { ...current }
        delete next[model.id]
        return next
      })
      toast.success('模型定价已保存')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSavingId(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>模型定价（credits / 百万 token）</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {loading && !data ? (
          <LoadingSkeleton rows={3} className="border-0 p-0" />
        ) : error && !data ? (
          <QueryError message={error.message} onRetry={() => void refetch()} />
        ) : models.length === 0 ? (
          <EmptyState icon={Server} title="暂无模型" />
        ) : (
          <table className={`${T.TABLE_CLASS} min-w-[760px]`}>
            <thead>
              <tr className={T.TABLE_HEAD_CLASS}>
                <th className={T.TABLE_HEAD_CELL_CLASS}>模型</th>
                <th className={T.TABLE_HEAD_CELL_NUMERIC_CLASS}>输入</th>
                <th className={T.TABLE_HEAD_CELL_NUMERIC_CLASS}>缓存输入</th>
                <th className={T.TABLE_HEAD_CELL_NUMERIC_CLASS}>输出</th>
                <th className={T.TABLE_HEAD_CELL_CLASS}>计费</th>
                <th className={T.TABLE_HEAD_CELL_ACTION_CLASS}>操作</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => {
                const draft = draftFor(model)
                return (
                  <tr key={model.id} className={T.TABLE_ROW_CLASS}>
                    <td className={T.TABLE_CELL_CLASS}>{model.name}</td>
                    <td className={T.TABLE_CELL_NUMERIC_CLASS}>
                      <Input
                        className="ml-auto w-24 text-right tabular-nums"
                        value={draft.inputPerMillion}
                        onChange={(event) => patch(model.id, model, { inputPerMillion: event.target.value })}
                      />
                    </td>
                    <td className={T.TABLE_CELL_NUMERIC_CLASS}>
                      <Input
                        className="ml-auto w-24 text-right tabular-nums"
                        value={draft.cachedInputPerMillion}
                        onChange={(event) =>
                          patch(model.id, model, { cachedInputPerMillion: event.target.value })
                        }
                      />
                    </td>
                    <td className={T.TABLE_CELL_NUMERIC_CLASS}>
                      <Input
                        className="ml-auto w-24 text-right tabular-nums"
                        value={draft.outputPerMillion}
                        onChange={(event) => patch(model.id, model, { outputPerMillion: event.target.value })}
                      />
                    </td>
                    <td className={T.TABLE_CELL_CLASS}>
                      <Checkbox
                        checked={draft.isBillable}
                        onCheckedChange={(checked) =>
                          patch(model.id, model, { isBillable: Boolean(checked) })
                        }
                        aria-label={`${model.name} 计费开关`}
                      />
                    </td>
                    <td className={T.TABLE_ACTION_CELL_CLASS}>
                      <Button size="sm" variant="ghost" onClick={() => save(model)} disabled={savingId === model.id}>
                        保存
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  )
}
